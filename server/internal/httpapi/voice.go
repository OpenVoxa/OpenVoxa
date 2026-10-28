// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/livekit/protocol/auth"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// voiceTokenTTL is how long a minted token may be used to join. It bounds
// the join attempt, not the session: once connected, a participant stays
// connected until they leave or are removed.
const voiceTokenTTL = 10 * time.Minute

type voiceTokenResponse struct {
	URL        string `json:"url"`
	Token      string `json:"token"`
	Room       string `json:"room"`
	CanPublish bool   `json:"can_publish"`
	ForcePTT   bool   `json:"force_ptt"`
}

// voiceToken issues a LiveKit join token for a voice channel.
//
// This is the whole reason the server sits in front of LiveKit. LiveKit
// itself has no idea who your users are or what a moderator is; it only
// checks that a token was signed with the right secret and honours the
// grants inside it. All the policy lives here:
//
//   - min_role_view decides whether you may listen (canSubscribe)
//   - min_role_post decides whether you may speak (canPublish)
//
// The API secret never leaves the server. Clients only ever see a
// short-lived token scoped to one room.
func (a *API) voiceToken(w http.ResponseWriter, r *http.Request) {
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		writeError(w, http.StatusServiceUnavailable, "voice is not configured on this server")
		return
	}

	session := sessionFrom(r.Context())
	channelID := r.PathValue("id")

	var kind, minView, minPost string
	var forcePTT bool

	err := a.pool.QueryRow(r.Context(),
		`SELECT kind, min_role_view, min_role_post, force_ptt
		   FROM channels WHERE id = $1`,
		channelID,
	).Scan(&kind, &minView, &minPost, &forcePTT)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "channel not found")
		return
	case err != nil:
		slog.Error("looking up voice channel", "err", err)
		writeError(w, http.StatusInternalServerError, "could not join channel")
		return
	case kind != "voice":
		writeError(w, http.StatusBadRequest, "not a voice channel")
		return
	}

	role, err := perm.Parse(session.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", session.Role)
		writeError(w, http.StatusInternalServerError, "could not join channel")
		return
	}

	viewRole, err := perm.Parse(minView)
	if err != nil {
		slog.Error("channel has an unknown min_role_view", "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not join channel")
		return
	}
	if !perm.AtLeast(role, viewRole) {
		// Consistent with text channels: something you cannot access is
		// not confirmed to exist.
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}

	postRole, err := perm.Parse(minPost)
	if err != nil {
		slog.Error("channel has an unknown min_role_post", "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not join channel")
		return
	}
	canPublish := perm.AtLeast(role, postRole)
	canSubscribe := true

	grant := &auth.VideoGrant{
		Room:           channelID,
		RoomJoin:       true,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublish,
	}

	// Identity is the user ID, not the username. It is what LiveKit uses to
	// deduplicate participants, and a stable ID survives a future rename.
	// The display name is carried separately.
	at := auth.NewAccessToken(a.livekit.APIKey, a.livekit.APISecret).
		SetVideoGrant(grant).
		SetIdentity(session.UserID).
		SetName(session.Username).
		SetValidFor(voiceTokenTTL)

	token, err := at.ToJWT()
	if err != nil {
		slog.Error("minting livekit token", "err", err)
		writeError(w, http.StatusInternalServerError, "could not join channel")
		return
	}

	writeJSON(w, http.StatusOK, voiceTokenResponse{
		URL:        a.livekit.URL,
		Token:      token,
		Room:       channelID,
		CanPublish: canPublish,
		ForcePTT:   forcePTT,
	})
}

type forcePTTRequest struct {
	ForcePTT bool `json:"force_ptt"`
}

// setForcePTT toggles the channel-wide push-to-talk requirement.
// Moderator and above.
func (a *API) setForcePTT(w http.ResponseWriter, r *http.Request) {
	var req forcePTTRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	tag, err := a.pool.Exec(r.Context(),
		`UPDATE channels SET force_ptt = $1 WHERE id = $2 AND kind = 'voice'`,
		req.ForcePTT, r.PathValue("id"))
	if err != nil {
		slog.Error("updating force_ptt", "err", err)
		writeError(w, http.StatusInternalServerError, "could not update channel")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "voice channel not found")
		return
	}

	// Participants already connected keep their current mode until they
	// rejoin. Pushing this change live needs a server-to-client signal,
	// which arrives with the rest of the realtime channel events.
	writeJSON(w, http.StatusOK, forcePTTRequest{ForcePTT: req.ForcePTT})
}
