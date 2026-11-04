// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
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
	// ServerMuted: a moderator took the microphone away (voicemute.go);
	// ServerMutedUntil is nil for "until unmuted".
	ServerMuted      bool       `json:"server_muted"`
	ServerMutedUntil *time.Time `json:"server_muted_until"`
}

// voiceToken issues a LiveKit join token for a voice channel.
//
// This is the whole reason the server sits in front of LiveKit. LiveKit
// itself has no idea who your users are or what a moderator is; it only
// checks that a token was signed with the right secret and honours the
// grants inside it. All the policy lives here:
//
//   - being allowed to view the channel decides whether you may listen
//     (canSubscribe)
//   - being allowed to post in it decides whether you may speak
//     (canPublish)
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

	p, err := a.channelPermsFor(r.Context(), session, channelID)
	switch {
	case errors.Is(err, errChannelNotFound):
		// Consistent with text channels: something you cannot access is
		// not confirmed to exist.
		writeError(w, http.StatusNotFound, "channel not found")
		return
	case err != nil:
		slog.Error("checking channel access", "err", err, "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not join channel")
		return
	case p.Kind != "voice":
		writeError(w, http.StatusBadRequest, "not a voice channel")
		return
	}
	canPublish := p.CanPost
	forcePTT := p.ForcePTT
	canSubscribe := true

	muted, mutedUntil, err := voiceMuteState(r.Context(), a.pool, session.UserID)
	if err != nil {
		slog.Error("reading voice mute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not join channel")
		return
	}

	grant := &auth.VideoGrant{
		Room:           channelID,
		RoomJoin:       true,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublish,
	}
	// Server-muted: everything but the microphone and screen audio.
	// Camera is listed because the app never publishes it and the list
	// must name something (empty would mean any source).
	if muted && canPublish {
		grant.SetCanPublishSources([]livekit.TrackSource{
			livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE})
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

		ServerMuted:      muted && canPublish,
		ServerMutedUntil: mutedUntil,
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

	a.NotifyChannelChanged(r.PathValue("id"))

	writeJSON(w, http.StatusOK, forcePTTRequest{ForcePTT: req.ForcePTT})
}
