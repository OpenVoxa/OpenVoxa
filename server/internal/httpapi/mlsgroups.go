// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	// Handshake and welcome blobs are a few hundred bytes to a few
	// kilobytes. Generous enough for a large group, small enough that
	// these tables cannot be used as storage.
	maxHandshakeBytes = 256 * 1024
	maxWelcomeBytes   = 1024 * 1024

	// How many members may be added in one commit. A larger add is split
	// across several commits by the client.
	maxWelcomesPerCommit = 50

	// Catch-up page size.
	maxHandshakeBatch = 200
)

type mlsGroupState struct {
	Exists bool   `json:"exists"`
	Epoch  int64  `json:"epoch"`
	Member bool   `json:"member"`
	Reason string `json:"reason,omitempty"`
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
		`SELECT epoch FROM mls_groups WHERE channel_id = $1`, channelID,
	).Scan(&out.Epoch)

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

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDevice(w, r, req.DeviceID) {
		return
	}

	tag, err := a.pool.Exec(r.Context(),
		`INSERT INTO mls_groups (channel_id, epoch, created_by_device)
		 VALUES ($1, 0, $2)
		 ON CONFLICT (channel_id) DO NOTHING`,
		channelID, req.DeviceID)
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

	Commit   string            `json:"commit"`
	Welcomes []welcomeEnvelope `json:"welcomes"`
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
	var newEpoch int64
	err = tx.QueryRow(r.Context(),
		`UPDATE mls_groups
		    SET epoch = epoch + 1, updated_at = now()
		  WHERE channel_id = $1 AND epoch = $2
		  RETURNING epoch`,
		channelID, req.Epoch,
	).Scan(&newEpoch)

	if errors.Is(err, pgx.ErrNoRows) {
		// Either the group does not exist, or someone else committed
		// first. Report the current epoch either way so the client can
		// decide whether to create, catch up, or rebase and retry.
		var current int64
		exists := true
		if scanErr := tx.QueryRow(r.Context(),
			`SELECT epoch FROM mls_groups WHERE channel_id = $1`, channelID,
		).Scan(&current); errors.Is(scanErr, pgx.ErrNoRows) {
			exists = false
		}

		writeJSON(w, http.StatusConflict, mlsGroupState{
			Exists: exists,
			Epoch:  current,
			Reason: "the group has moved on; catch up and rebase this commit",
		})
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
