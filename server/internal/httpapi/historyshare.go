// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// History sharing (docs/decisions.md, "History sharing is opt-in per
// channel"). With it on, a member's client bundles the plaintext it holds
// for a channel, encrypts the bundle to the group as an MLS application
// message, and leaves it here for each device that was just added. The
// server stores and forwards the bundle without reading it, like every
// other MLS message.

const (
	// A bundle is text plus attachment keys for every message the server
	// still holds. Generous for a small server; the cap only stops the
	// table being used as storage.
	maxHistoryShareBytes = 8 * 1024 * 1024

	// How many message IDs a sharer is told about, newest first.
	maxHistoryShareMessages = 5000
)

type setHistorySharingRequest struct {
	Enabled bool `json:"enabled"`
}

// setHistorySharing turns history sharing on or off for a channel.
// Turning it off also drops bundles not yet collected.
func (a *API) setHistorySharing(w http.ResponseWriter, r *http.Request) {
	var req setHistorySharingRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	channelID := r.PathValue("id")

	tag, err := a.pool.Exec(r.Context(),
		`UPDATE channels SET history_sharing = $1 WHERE id = $2 AND encrypted`,
		req.Enabled, channelID)
	if err != nil {
		slog.Error("setting history sharing", "err", err)
		writeError(w, http.StatusInternalServerError, "could not update channel")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "no encrypted channel with that id")
		return
	}
	if !req.Enabled {
		if _, err := a.pool.Exec(r.Context(),
			`DELETE FROM mls_history_shares WHERE channel_id = $1`, channelID); err != nil {
			slog.Error("dropping history shares", "err", err)
		}
	}

	slog.Info("channel history sharing changed", "channel_id", channelID, "enabled", req.Enabled)
	a.NotifyChannelChanged(channelID)
	w.WriteHeader(http.StatusNoContent)
}

// historySharingOn writes 409 and returns false when the channel does not
// share history. Clients ask on every membership change, so this is the
// cheap "not here" answer, not an error worth logging.
func (a *API) historySharingOn(w http.ResponseWriter, r *http.Request, channelID string) bool {
	var on bool
	err := a.pool.QueryRow(r.Context(),
		`SELECT history_sharing FROM channels WHERE id = $1`, channelID).Scan(&on)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "channel not found")
		return false
	case err != nil:
		slog.Error("reading history sharing", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read the channel")
		return false
	case !on:
		writeError(w, http.StatusConflict, "history sharing is off in this channel")
		return false
	}
	return true
}

// listShareableMessageIDs tells a sharer which messages still exist, so
// the bundle never revives something deleted or past retention.
func (a *API) listShareableMessageIDs(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")
	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDeviceParam(w, r, r.URL.Query().Get("device_id")) {
		return
	}
	if !a.historySharingOn(w, r, channelID) {
		return
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT id::text FROM messages
		  WHERE channel_id = $1 AND NOT deleted
		  ORDER BY created_at DESC
		  LIMIT $2`,
		channelID, maxHistoryShareMessages)
	if err != nil {
		slog.Error("listing shareable messages", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list messages")
		return
	}
	defer rows.Close()

	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			slog.Error("scanning message id", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list messages")
			return
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating message ids", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list messages")
		return
	}
	writeJSON(w, http.StatusOK, ids)
}

type shareHistoryRequest struct {
	DeviceID   string   `json:"device_id"`
	Recipients []string `json:"recipients"`
	// Base64 MLS application message.
	Body string `json:"body"`
}

type historyShareFrame struct {
	Type       string   `json:"type"`
	ChannelID  string   `json:"channel_id"`
	Recipients []string `json:"recipients"`
}

// shareHistory stores one bundle for each recipient that does not already
// have one waiting. Recipients must be allowed in the channel by the same
// rule as a welcome.
func (a *API) shareHistory(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	// Read here rather than with decodeJSON: a bundle is far larger than
	// the usual request cap.
	r.Body = http.MaxBytesReader(w, r.Body, maxHistoryShareBytes*4/3+64*1024)
	var req shareHistoryRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "history bundle too large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDeviceParam(w, r, req.DeviceID) {
		return
	}
	if !a.historySharingOn(w, r, channelID) {
		return
	}

	body, err := base64.StdEncoding.DecodeString(req.Body)
	if err != nil || len(body) == 0 || len(body) > maxHistoryShareBytes {
		writeError(w, http.StatusBadRequest, "body must be base64 and at most 8 MB")
		return
	}
	if len(req.Recipients) == 0 || len(req.Recipients) > maxDeviceLookup {
		writeError(w, http.StatusBadRequest, "recipients must list 1 to 100 devices")
		return
	}

	allowed, err := a.allowedDevices(r.Context(), channelID, req.Recipients)
	if err != nil {
		slog.Error("checking history recipients", "err", err)
		writeError(w, http.StatusInternalServerError, "could not share history")
		return
	}
	ok := make(map[string]bool, len(allowed))
	for _, d := range allowed {
		ok[d.DeviceID] = true
	}
	stored := make([]string, 0, len(req.Recipients))
	for _, id := range req.Recipients {
		if !ok[id] || id == req.DeviceID {
			continue
		}
		tag, err := a.pool.Exec(r.Context(),
			`INSERT INTO mls_history_shares (channel_id, recipient_device_id, sender_device_id, body)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (channel_id, recipient_device_id) DO NOTHING`,
			channelID, id, req.DeviceID, body)
		if err != nil {
			slog.Error("storing history share", "err", err)
			writeError(w, http.StatusInternalServerError, "could not share history")
			return
		}
		if tag.RowsAffected() > 0 {
			stored = append(stored, id)
		}
	}

	if len(stored) > 0 {
		a.emitChannel(channelID, historyShareFrame{
			Type: "history_shared", ChannelID: channelID, Recipients: stored,
		})
	}
	writeJSON(w, http.StatusOK, map[string]int{"stored": len(stored)})
}

type historyShareEntry struct {
	ID             string  `json:"id"`
	SenderDeviceID *string `json:"sender_device_id"`
	Body           string  `json:"body"`
}

// listHistoryShares returns the bundles waiting for one of the caller's
// devices in a channel.
func (a *API) listHistoryShares(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")
	deviceID := r.URL.Query().Get("device_id")
	if _, ok := a.requireChannelAccess(w, r, channelID); !ok {
		return
	}
	if !a.ownDeviceParam(w, r, deviceID) {
		return
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT id::text, sender_device_id::text, body FROM mls_history_shares
		  WHERE channel_id = $1 AND recipient_device_id = $2`,
		channelID, deviceID)
	if err != nil {
		slog.Error("listing history shares", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list history")
		return
	}
	defer rows.Close()

	out := make([]historyShareEntry, 0)
	for rows.Next() {
		var e historyShareEntry
		var body []byte
		if err := rows.Scan(&e.ID, &e.SenderDeviceID, &body); err != nil {
			slog.Error("scanning history share", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list history")
			return
		}
		e.Body = base64.StdEncoding.EncodeToString(body)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating history shares", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list history")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ackHistoryShare deletes a bundle its recipient has imported.
func (a *API) ackHistoryShare(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	if !a.ownDeviceParam(w, r, deviceID) {
		return
	}
	if !uuidPattern.MatchString(r.PathValue("share")) {
		writeError(w, http.StatusBadRequest, "share id must be a UUID")
		return
	}
	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM mls_history_shares
		  WHERE id = $1 AND channel_id = $2 AND recipient_device_id = $3`,
		r.PathValue("share"), r.PathValue("id"), deviceID); err != nil {
		slog.Error("deleting history share", "err", err)
		writeError(w, http.StatusInternalServerError, "could not acknowledge")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ownDeviceParam is ownDevice for an ID taken from the request, checked
// for shape first so a malformed one is a 400, not a Postgres cast error.
func (a *API) ownDeviceParam(w http.ResponseWriter, r *http.Request, deviceID string) bool {
	if !uuidPattern.MatchString(deviceID) {
		writeError(w, http.StatusBadRequest, "device_id must be a UUID")
		return false
	}
	return a.ownDevice(w, r, deviceID)
}
