// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	// Handshake and welcome blobs are a few hundred bytes to a few
	// kilobytes. Generous enough for a large group, small enough that
	// these tables cannot be used as storage.
	maxHandshakeBytes = 256 * 1024
	maxWelcomeBytes   = 1024 * 1024

	// A GroupInfo carries the ratchet tree, about 300 bytes per member.
	maxGroupInfoBytes = 1024 * 1024

	// How many members may be added in one commit. A larger add is split
	// across several commits by the client.
	maxWelcomesPerCommit = 50

	// Catch-up page size.
	maxHandshakeBatch = 200
)

type mlsGroupState struct {
	Exists bool  `json:"exists"`
	Epoch  int64 `json:"epoch"`

	// Which group this is: bumped each time the group is replaced (see
	// resetGroup). Clients put it in the MLS group ID.
	Generation int64 `json:"generation"`

	// The epoch of the stored GroupInfo, null if there is none. A device
	// can join from it only while it equals Epoch.
	GroupInfoEpoch *int64 `json:"group_info_epoch"`

	Member bool   `json:"member"`
	Reason string `json:"reason,omitempty"`
}

// decodeGroupInfo reads an optional base64 GroupInfo. Empty means none.
func decodeGroupInfo(w http.ResponseWriter, raw string) (info []byte, ok bool) {
	if raw == "" {
		return nil, true
	}
	info, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(info) == 0 || len(info) > maxGroupInfoBytes {
		writeError(w, http.StatusBadRequest, "group_info must be base64 and at most 1 MiB")
		return nil, false
	}
	return info, true
}

// currentGroup reads a channel's group row for the conflict responses,
// so a client that lost a race learns where the group really is.
func (a *API) currentGroup(r *http.Request, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, channelID string) mlsGroupState {
	out := mlsGroupState{Exists: true}
	err := q.QueryRow(r.Context(),
		`SELECT epoch, generation, group_info_epoch FROM mls_groups WHERE channel_id = $1`,
		channelID,
	).Scan(&out.Epoch, &out.Generation, &out.GroupInfoEpoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return mlsGroupState{}
	}
	if err != nil {
		slog.Error("reading group state", "err", err)
	}
	return out
}

// requireChannelAccess checks the caller may view a channel and returns
// whether they may also post in it. The rule itself lives in access.go.
func (a *API) requireChannelAccess(
	w http.ResponseWriter, r *http.Request, channelID string,
) (canPost bool, ok bool) {
	p, err := a.channelPermsFor(r.Context(), sessionFrom(r.Context()).Role, channelID)
	switch {
	case errors.Is(err, errChannelNotFound):
		writeError(w, http.StatusNotFound, "channel not found")
		return false, false
	case err != nil:
		slog.Error("checking channel access", "err", err, "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not check permissions")
		return false, false
	}
	return p.CanPost, true
}

// ownDevice resolves the caller's device, verifying it belongs to them.
func (a *API) ownDevice(
	w http.ResponseWriter, r *http.Request, deviceID string,
) (ok bool) {
	session := sessionFrom(r.Context())

	var owner string
	err := a.pool.QueryRow(r.Context(),
		`SELECT user_id FROM devices WHERE id = $1 AND revoked_at IS NULL`,
		deviceID,
	).Scan(&owner)

	switch {
	case errors.Is(err, pgx.ErrNoRows), err == nil && owner != session.UserID:
		writeError(w, http.StatusForbidden, "unknown device")
		return false
	case err != nil:
		slog.Error("looking up device", "err", err)
		writeError(w, http.StatusInternalServerError, "could not verify the device")
		return false
	}

	return true
}

// groupState reports whether a channel has an MLS group and what epoch it
// is at, so a client knows whether to create, join, or catch up.
func (a *API) groupState(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}

	var out mlsGroupState
	err := a.pool.QueryRow(r.Context(),
		`SELECT epoch, generation, group_info_epoch FROM mls_groups WHERE channel_id = $1`,
		channelID,
	).Scan(&out.Epoch, &out.Generation, &out.GroupInfoEpoch)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		out.Exists = false
		out.Reason = "no group yet; the first member creates it"
	case err != nil:
		slog.Error("reading group state", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read group state")
		return
	default:
		out.Exists = true
	}

	writeJSON(w, http.StatusOK, out)
}

type createGroupRequest struct {
	DeviceID string `json:"device_id"`

	// The new group's GroupInfo at epoch 0, so a device can join from it
	// before anyone has committed.
	GroupInfo string `json:"group_info"`
}

// createGroup records that a channel now has an MLS group.
//
// The group itself is built on the client; this only establishes the
// epoch counter the server uses to order commits. Creation is
// first-come-first-served, and the unique primary key makes a race
// resolve to one winner: a second caller gets a conflict and joins the
// existing group instead of starting a rival one.
//
// Viewing the channel is enough. Group membership follows view access
// (docs/decisions.md, Encryption), so a view-only account is a member
// like any other and may be the first one there.
func (a *API) createGroup(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	var req createGroupRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	groupInfo, ok := decodeGroupInfo(w, req.GroupInfo)
	if !ok {
		return
	}
	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDevice(w, r, req.DeviceID) {
		return
	}

	tag, err := a.pool.Exec(r.Context(),
		`INSERT INTO mls_groups (channel_id, epoch, created_by_device,
		                         group_info, group_info_epoch)
		 VALUES ($1, 0, $2, $3, CASE WHEN $3::bytea IS NULL THEN NULL ELSE 0 END)
		 ON CONFLICT (channel_id) DO NOTHING`,
		channelID, req.DeviceID, groupInfo)
	if err != nil {
		slog.Error("creating group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create the group")
		return
	}

	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "this channel already has a group")
		return
	}

	slog.Info("mls group created", "channel_id", channelID, "device_id", req.DeviceID)
	writeJSON(w, http.StatusCreated, mlsGroupState{Exists: true, Epoch: 0})
}

type resetGroupRequest struct {
	DeviceID string `json:"device_id"`

	// The generation the caller saw. The reset happens only if it is
	// still current, so two devices resetting at once make one new group.
	Generation int64 `json:"generation"`

	// The replacement group's GroupInfo at epoch 0. Required: a reset
	// that published none would leave the next device to reset again.
	GroupInfo string `json:"group_info"`
}

// resetGroup replaces a channel's group that no permitted device can
// commit to (docs/decisions.md, "replaced, not rescued").
//
// Allowed only when external join is impossible: there is no stored
// GroupInfo, or it is older than the epoch the server has on record.
// While a current one exists the caller must join from it instead, which
// loses nothing, and its own reconciliation then removes members without
// access.
//
// The caller has already built the new group locally (its MLS group ID
// names the next generation) and sends its GroupInfo. The old group's
// handshake log and pending welcomes are deleted; devices still holding
// its state find out from the generation and rejoin.
func (a *API) resetGroup(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	var req resetGroupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	groupInfo, ok := decodeGroupInfo(w, req.GroupInfo)
	if !ok {
		return
	}
	if groupInfo == nil {
		writeError(w, http.StatusBadRequest, "group_info is required")
		return
	}
	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDevice(w, r, req.DeviceID) {
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting reset", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the group")
		return
	}
	defer tx.Rollback(r.Context())

	// Locked so a commit or another reset cannot slip in between the
	// check and the replacement.
	var cur mlsGroupState
	var hasInfo bool
	err = tx.QueryRow(r.Context(),
		`SELECT epoch, generation, group_info_epoch, group_info IS NOT NULL
		   FROM mls_groups WHERE channel_id = $1 FOR UPDATE`,
		channelID,
	).Scan(&cur.Epoch, &cur.Generation, &cur.GroupInfoEpoch, &hasInfo)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "this channel has no group; create one")
		return
	case err != nil:
		slog.Error("reading group for reset", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the group")
		return
	}
	cur.Exists = true

	if cur.Generation != req.Generation {
		cur.Reason = "the group was already replaced; join the new one"
		writeJSON(w, http.StatusConflict, cur)
		return
	}
	if hasInfo && cur.GroupInfoEpoch != nil && *cur.GroupInfoEpoch == cur.Epoch {
		cur.Reason = "the group can still be joined from its group info"
		writeJSON(w, http.StatusConflict, cur)
		return
	}

	var newGen int64
	if err := tx.QueryRow(r.Context(),
		`UPDATE mls_groups
		    SET generation = generation + 1, epoch = 0,
		        group_info = $2, group_info_epoch = 0,
		        created_by_device = $3, created_at = now(), updated_at = now()
		  WHERE channel_id = $1
		  RETURNING generation`,
		channelID, groupInfo, req.DeviceID,
	).Scan(&newGen); err != nil {
		slog.Error("replacing group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the group")
		return
	}
	for _, q := range []string{
		`DELETE FROM mls_handshakes WHERE channel_id = $1`,
		`DELETE FROM mls_welcomes WHERE channel_id = $1`,
	} {
		if _, err := tx.Exec(r.Context(), q, channelID); err != nil {
			slog.Error("clearing old group", "err", err)
			writeError(w, http.StatusInternalServerError, "could not reset the group")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing reset", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the group")
		return
	}

	// Connected devices catch up, learn the generation moved, and rejoin.
	a.NotifyGroupAdvanced(channelID, 0)

	slog.Warn("mls group replaced",
		"channel_id", channelID, "generation", newGen, "old_epoch", cur.Epoch,
		"device_id", req.DeviceID)

	zero := int64(0)
	writeJSON(w, http.StatusOK, mlsGroupState{
		Exists: true, Epoch: 0, Generation: newGen, GroupInfoEpoch: &zero,
	})
}

type groupInfoResponse struct {
	Generation     int64  `json:"generation"`
	Epoch          int64  `json:"epoch"`
	GroupInfoEpoch *int64 `json:"group_info_epoch"`
	// Base64, or empty when no member has uploaded one.
	GroupInfo string `json:"group_info"`
}

// getGroupInfo hands out the stored GroupInfo for an external join.
//
// View access is enough, the same as committing. The GroupInfo is enough
// on its own to join, which is why it goes only to accounts the channel
// allows; a join is still announced to every member and reconciled like
// any other add (docs/decisions.md, Known tensions).
func (a *API) getGroupInfo(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}

	var out groupInfoResponse
	var info []byte
	err := a.pool.QueryRow(r.Context(),
		`SELECT generation, epoch, group_info_epoch, group_info
		   FROM mls_groups WHERE channel_id = $1`,
		channelID,
	).Scan(&out.Generation, &out.Epoch, &out.GroupInfoEpoch, &info)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "this channel has no group")
		return
	case err != nil:
		slog.Error("reading group info", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read the group info")
		return
	}
	if info != nil {
		out.GroupInfo = base64.StdEncoding.EncodeToString(info)
	}

	writeJSON(w, http.StatusOK, out)
}

type putGroupInfoRequest struct {
	DeviceID   string `json:"device_id"`
	Generation int64  `json:"generation"`
	Epoch      int64  `json:"epoch"`
	GroupInfo  string `json:"group_info"`
}

// putGroupInfo stores a GroupInfo for the current epoch without a commit.
//
// Every commit already carries one; this covers a group that has none
// yet (created before external join existed) or whose upload was lost.
// A member sends it after catching up. Refused unless it names the
// current generation and epoch, so a slow device cannot replace a good
// GroupInfo with a stale one.
func (a *API) putGroupInfo(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	var req putGroupInfoRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	groupInfo, ok := decodeGroupInfo(w, req.GroupInfo)
	if !ok {
		return
	}
	if groupInfo == nil {
		writeError(w, http.StatusBadRequest, "group_info is required")
		return
	}
	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDevice(w, r, req.DeviceID) {
		return
	}

	tag, err := a.pool.Exec(r.Context(),
		`UPDATE mls_groups
		    SET group_info = $4, group_info_epoch = epoch
		  WHERE channel_id = $1 AND generation = $2 AND epoch = $3`,
		channelID, req.Generation, req.Epoch, groupInfo)
	if err != nil {
		slog.Error("storing group info", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the group info")
		return
	}
	if tag.RowsAffected() == 0 {
		cur := a.currentGroup(r, a.pool, channelID)
		cur.Reason = "the group has moved on; this group info is stale"
		writeJSON(w, http.StatusConflict, cur)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type welcomeEnvelope struct {
	DeviceID    string `json:"device_id"`
	Welcome     string `json:"welcome"`
	RatchetTree string `json:"ratchet_tree"`
}

type commitRequest struct {
	DeviceID string `json:"device_id"`

	// The epoch this commit was built on. The server advances only if
	// this is still current.
	Epoch int64 `json:"epoch"`

	// The group generation the commit belongs to. Checked with the
	// epoch, so a device holding a replaced group's state cannot land a
	// commit in the new group by having the same epoch number.
	Generation int64 `json:"generation"`

	Commit   string            `json:"commit"`
	Welcomes []welcomeEnvelope `json:"welcomes"`

	// The GroupInfo for the epoch this commit produces, so a device can
	// join externally from it. Optional for the server; the client
	// always sends one.
	GroupInfo string `json:"group_info"`
}

type commitResponse struct {
	Epoch int64 `json:"epoch"`
}

// submitCommit advances the group by one epoch, if the caller is building
// on the current one.
//
// This is the only thing the server does that MLS actually depends on.
// Groups advance in epochs and every member must apply the same sequence;
// two clients committing against the same epoch would produce two
// divergent groups with no way back. The compare-and-swap below picks one
// winner, and the loser is told the real epoch so it can catch up, rebase
// and retry.
//
// The blobs are opaque. The server cannot read the commit, cannot verify
// the epoch inside it, and does not try.
//
// Viewing the channel is enough to commit: commits change membership and
// keys, not content, and every member may need to make one (reconciling,
// joining from a GroupInfo). What a commit may NOT do is bring in someone
// without access, and that is checked on the welcomes below.
func (a *API) submitCommit(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	var req commitRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDevice(w, r, req.DeviceID) {
		return
	}

	groupInfo, ok := decodeGroupInfo(w, req.GroupInfo)
	if !ok {
		return
	}

	commit, err := base64.StdEncoding.DecodeString(req.Commit)
	if err != nil || len(commit) == 0 || len(commit) > maxHandshakeBytes {
		writeError(w, http.StatusBadRequest, "commit must be base64 and non-empty")
		return
	}
	if len(req.Welcomes) > maxWelcomesPerCommit {
		writeError(w, http.StatusBadRequest, "too many welcomes in one commit")
		return
	}

	type decodedWelcome struct {
		deviceID string
		welcome  []byte
		tree     []byte
	}

	welcomes := make([]decodedWelcome, 0, len(req.Welcomes))
	for _, env := range req.Welcomes {
		welcome, err := base64.StdEncoding.DecodeString(env.Welcome)
		if err != nil || len(welcome) == 0 || len(welcome) > maxWelcomeBytes {
			writeError(w, http.StatusBadRequest, "welcome must be base64 and non-empty")
			return
		}
		tree, err := base64.StdEncoding.DecodeString(env.RatchetTree)
		if err != nil || len(tree) == 0 || len(tree) > maxWelcomeBytes {
			writeError(w, http.StatusBadRequest, "ratchet_tree must be base64 and non-empty")
			return
		}
		welcomes = append(welcomes, decodedWelcome{
			deviceID: env.DeviceID, welcome: welcome, tree: tree,
		})
	}

	// Every welcome must go to a device that belongs in this channel's
	// group by the same rule the allowed-devices list uses. The server
	// cannot see who the commit itself adds (it is encrypted), but an
	// added device that gets no welcome cannot join, so refusing the
	// welcome is what enforces access. The whole commit is refused,
	// not just the welcome: accepting it would leave the group holding a
	// member who can never join, and the client would not know.
	if len(welcomes) > 0 {
		ids := make([]string, 0, len(welcomes))
		for _, env := range welcomes {
			ids = append(ids, env.deviceID)
		}
		allowed, err := a.allowedDevices(r.Context(), channelID, ids)
		if err != nil {
			slog.Error("checking welcome recipients", "err", err)
			writeError(w, http.StatusInternalServerError, "could not submit the commit")
			return
		}
		ok := make(map[string]bool, len(allowed))
		for _, d := range allowed {
			ok[d.DeviceID] = true
		}
		for _, id := range ids {
			if !ok[id] {
				writeError(w, http.StatusForbidden,
					"a welcome is addressed to a device without access to this channel")
				return
			}
		}
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting commit", "err", err)
		writeError(w, http.StatusInternalServerError, "could not submit the commit")
		return
	}
	defer tx.Rollback(r.Context())

	// The compare-and-swap. Nothing else in the transaction matters if
	// this does not match.
	// The GroupInfo is replaced in the same step, so the stored one is
	// never older than the epoch while commits carry one.
	var newEpoch int64
	err = tx.QueryRow(r.Context(),
		`UPDATE mls_groups
		    SET epoch = epoch + 1, updated_at = now(),
		        group_info = CASE WHEN $4::bytea IS NULL THEN group_info ELSE $4 END,
		        group_info_epoch = CASE WHEN $4::bytea IS NULL THEN group_info_epoch
		                                ELSE epoch + 1 END
		  WHERE channel_id = $1 AND epoch = $2 AND generation = $3
		  RETURNING epoch`,
		channelID, req.Epoch, req.Generation, groupInfo,
	).Scan(&newEpoch)

	if errors.Is(err, pgx.ErrNoRows) {
		// The group does not exist, someone else committed first, or it
		// was replaced. Report where it is so the client can decide
		// whether to create, catch up, rejoin, or rebase and retry.
		cur := a.currentGroup(r, tx, channelID)
		cur.Reason = "the group has moved on; catch up and rebase this commit"
		writeJSON(w, http.StatusConflict, cur)
		return
	}
	if err != nil {
		slog.Error("advancing epoch", "err", err)
		writeError(w, http.StatusInternalServerError, "could not submit the commit")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`INSERT INTO mls_handshakes (channel_id, epoch, sender_device_id, blob)
		 VALUES ($1, $2, $3, $4)`,
		channelID, req.Epoch, req.DeviceID, commit,
	); err != nil {
		slog.Error("recording handshake", "err", err)
		writeError(w, http.StatusInternalServerError, "could not submit the commit")
		return
	}

	for _, env := range welcomes {
		// A pending welcome for the same device is replaced: the newer
		// one is built on a later epoch, so the old one is already
		// useless.
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO mls_welcomes
			     (channel_id, recipient_device_id, welcome, ratchet_tree,
			      epoch, sender_device_id)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (channel_id, recipient_device_id) WHERE claimed_at IS NULL
			 DO UPDATE SET welcome = EXCLUDED.welcome,
			               ratchet_tree = EXCLUDED.ratchet_tree,
			               epoch = EXCLUDED.epoch,
			               created_at = now()`,
			channelID, env.deviceID, env.welcome, env.tree, newEpoch, req.DeviceID,
		); err != nil {
			slog.Error("storing welcome", "err", err, "device_id", env.deviceID)
			writeError(w, http.StatusInternalServerError, "could not deliver a welcome")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing", "err", err)
		writeError(w, http.StatusInternalServerError, "could not submit the commit")
		return
	}

	// Members with an open socket apply this without waiting to poll.
	a.NotifyGroupAdvanced(channelID, newEpoch)

	slog.Info("mls commit accepted",
		"channel_id", channelID, "epoch", newEpoch, "welcomes", len(welcomes))

	writeJSON(w, http.StatusOK, commitResponse{Epoch: newEpoch})
}

// listAllowedDevices returns every device that belongs in this channel's
// encryption group: each non-revoked device of each account that may view
// the channel.
//
// The server does not know who is actually in the group - commits are
// opaque - so it does not report "missing" or "revoked" itself. A member's
// client compares this list against its own ratchet tree and adds or
// removes the difference (build-order step 11).
func (a *API) listAllowedDevices(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}

	devices, err := a.allowedDevices(r.Context(), channelID, nil)
	if err != nil {
		slog.Error("listing allowed devices", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list devices")
		return
	}

	writeJSON(w, http.StatusOK, devices)
}

// maxDeviceLookup bounds one names lookup. A group's notices name at most
// the devices one commit added or removed, plus who committed.
const maxDeviceLookup = 100

// deviceName is who a device belongs to, for join and leave notices.
type deviceName struct {
	DeviceID string `json:"device_id"`
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	Label    string `json:"label"`
	Revoked  bool   `json:"revoked"`
}

// listDeviceNames resolves device IDs to account and label, so a member
// can announce "staff's laptop was removed" for a device that is no
// longer on the allowed list (which is usually why it was removed).
//
// Requires view access to the channel, like every MLS endpoint. Any
// device ID resolves, revoked ones included: the caller already holds
// the IDs, from the group's own ratchet tree, and the notice is the
// point. What is announced as authoritative is the device ID itself,
// which comes from the MLS credential; the name is the server's claim
// about it and the client shows both.
func (a *API) listDeviceNames(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}

	ids := make([]string, 0)
	for _, id := range strings.Split(r.URL.Query().Get("ids"), ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if !uuidPattern.MatchString(id) {
			writeError(w, http.StatusBadRequest, "ids must be UUIDs")
			return
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, []deviceName{})
		return
	}
	if len(ids) > maxDeviceLookup {
		writeError(w, http.StatusBadRequest, "too many ids")
		return
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT d.id::text, u.id::text,
		        CASE WHEN u.deleted_at IS NULL THEN u.username ELSE '[deleted]' END,
		        d.label, d.revoked_at IS NOT NULL
		   FROM devices d
		   JOIN users u ON u.id = d.user_id
		  WHERE d.id::text = ANY($1::text[])`,
		ids,
	)
	if err != nil {
		slog.Error("looking up device names", "err", err)
		writeError(w, http.StatusInternalServerError, "could not look up devices")
		return
	}
	defer rows.Close()

	out := make([]deviceName, 0, len(ids))
	for rows.Next() {
		var d deviceName
		if err := rows.Scan(&d.DeviceID, &d.UserID, &d.Username, &d.Label, &d.Revoked); err != nil {
			slog.Error("scanning device name", "err", err)
			writeError(w, http.StatusInternalServerError, "could not look up devices")
			return
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating device names", "err", err)
		writeError(w, http.StatusInternalServerError, "could not look up devices")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

type handshakeEntry struct {
	Epoch          int64     `json:"epoch"`
	SenderDeviceID *string   `json:"sender_device_id"`
	Blob           string    `json:"blob"`
	CreatedAt      time.Time `json:"created_at"`
}

// listHandshakes returns commits from a given epoch onwards, so a member
// who was offline can catch up.
//
// Only for members who were already in the group. Someone joining for the
// first time gets a welcome and sees nothing from before it, which is the
// forward secrecy guarantee rather than an oversight.
func (a *API) listHandshakes(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}

	// A device holding state from a replaced group must not apply the
	// new group's log; it is told to rejoin instead.
	if raw := r.URL.Query().Get("generation"); raw != "" {
		gen, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || gen < 0 {
			writeError(w, http.StatusBadRequest, "generation must be a non-negative integer")
			return
		}
		cur := a.currentGroup(r, a.pool, channelID)
		if cur.Exists && cur.Generation != gen {
			cur.Reason = "the group was replaced; rejoin"
			writeJSON(w, http.StatusGone, cur)
			return
		}
	}

	since := int64(0)
	if raw := r.URL.Query().Get("since_epoch"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeError(w, http.StatusBadRequest, "since_epoch must be a non-negative integer")
			return
		}
		since = parsed
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT epoch, sender_device_id, blob, created_at
		   FROM mls_handshakes
		  WHERE channel_id = $1 AND epoch >= $2
		  ORDER BY epoch
		  LIMIT $3`,
		channelID, since, maxHandshakeBatch)
	if err != nil {
		slog.Error("listing handshakes", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read the handshake log")
		return
	}
	defer rows.Close()

	out := make([]handshakeEntry, 0)
	for rows.Next() {
		var entry handshakeEntry
		var blob []byte
		if err := rows.Scan(&entry.Epoch, &entry.SenderDeviceID, &blob, &entry.CreatedAt); err != nil {
			slog.Error("scanning handshake", "err", err)
			writeError(w, http.StatusInternalServerError, "could not read the handshake log")
			return
		}
		entry.Blob = base64.StdEncoding.EncodeToString(blob)
		out = append(out, entry)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating handshakes", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read the handshake log")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

type pendingWelcome struct {
	ID          int64     `json:"id"`
	ChannelID   string    `json:"channel_id"`
	Welcome     string    `json:"welcome"`
	RatchetTree string    `json:"ratchet_tree"`
	Epoch       int64     `json:"epoch"`
	CreatedAt   time.Time `json:"created_at"`
}

// listWelcomes returns welcomes waiting for one of the caller's devices.
func (a *API) listWelcomes(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" || !a.ownDevice(w, r, deviceID) {
		if deviceID == "" {
			writeError(w, http.StatusBadRequest, "device_id is required")
		}
		return
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT id, channel_id, welcome, ratchet_tree, epoch, created_at
		   FROM mls_welcomes
		  WHERE recipient_device_id = $1 AND claimed_at IS NULL
		  ORDER BY created_at`,
		deviceID)
	if err != nil {
		slog.Error("listing welcomes", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read welcomes")
		return
	}
	defer rows.Close()

	out := make([]pendingWelcome, 0)
	for rows.Next() {
		var pw pendingWelcome
		var welcome, tree []byte
		if err := rows.Scan(&pw.ID, &pw.ChannelID, &welcome, &tree,
			&pw.Epoch, &pw.CreatedAt); err != nil {
			slog.Error("scanning welcome", "err", err)
			writeError(w, http.StatusInternalServerError, "could not read welcomes")
			return
		}
		pw.Welcome = base64.StdEncoding.EncodeToString(welcome)
		pw.RatchetTree = base64.StdEncoding.EncodeToString(tree)
		out = append(out, pw)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating welcomes", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read welcomes")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

type ackWelcomeRequest struct {
	DeviceID string `json:"device_id"`
}

// ackWelcome marks a welcome as used.
//
// Acknowledged by the client AFTER it has successfully joined and stored
// the group state, not when it fetches. A welcome marked used by a client
// that then failed to join would leave that device permanently outside a
// group with nothing to retry from.
func (a *API) ackWelcome(w http.ResponseWriter, r *http.Request) {
	var req ackWelcomeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !a.ownDevice(w, r, req.DeviceID) {
		return
	}

	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid welcome id")
		return
	}

	tag, err := a.pool.Exec(r.Context(),
		`UPDATE mls_welcomes SET claimed_at = now()
		  WHERE id = $1 AND recipient_device_id = $2 AND claimed_at IS NULL`,
		id, req.DeviceID)
	if err != nil {
		slog.Error("acknowledging welcome", "err", err)
		writeError(w, http.StatusInternalServerError, "could not acknowledge the welcome")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "welcome not found or already used")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
