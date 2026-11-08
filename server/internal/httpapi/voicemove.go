// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// Moving people between voice channels (decisions.md Feature decisions,
// "Move and disconnect"). A holder of move_members moves someone below
// their rank who is already in a call to another voice channel, or
// disconnects them. Nobody is pulled into a call they did not join.
//
// Why the client moves itself: voice is end-to-end encrypted with one
// MLS group per channel, so arriving in another channel means joining
// that channel's group and taking its key, which only the client can
// do. LiveKit's own MoveParticipant would put them in the new room with
// the old room's key, hearing nothing. So the server tells the account's
// devices "go to X" (voice_moved), and the one in the call leaves and
// joins X. A client that does not act on it (a tab still running an
// older build) is taken out of the old call after voiceMoveGrace, so
// the "out" half is enforced whatever the client does.
//
// Disconnect is enforced at once by LiveKit (RemoveParticipant). It is
// not a ban: they may join again.

// voiceMoveGrace is how long a moved client has to leave the old call
// by itself before the server removes it.
const voiceMoveGrace = 10 * time.Second

type voiceMoveRequest struct {
	// FromChannelID is the call they are in, as the moderator saw it.
	FromChannelID string `json:"from_channel_id"`
	// ToChannelID is where they go; empty disconnects instead.
	ToChannelID string `json:"to_channel_id"`
}

// voiceMovedEvent goes to the moved account's connections only. ToChannelID
// empty: disconnected, not moved. Username is who did it, for the notice.
type voiceMovedEvent struct {
	Type          string `json:"type"`
	FromChannelID string `json:"from_channel_id"`
	ToChannelID   string `json:"to_channel_id"`
	Username      string `json:"username"`
}

// moveVoice serves POST /users/{id}/voice-move.
func (a *API) moveVoice(w http.ResponseWriter, r *http.Request) {
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		writeError(w, http.StatusServiceUnavailable, "voice is not configured on this server")
		return
	}
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")

	var req voiceMoveRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !uuidPattern.MatchString(req.FromChannelID) ||
		(req.ToChannelID != "" && !uuidPattern.MatchString(req.ToChannelID)) {
		writeError(w, http.StatusBadRequest, "from_channel_id and to_channel_id must be channel IDs")
		return
	}
	if req.ToChannelID == req.FromChannelID {
		writeError(w, http.StatusBadRequest, "they are already in that channel")
		return
	}
	if subjectID == actor.UserID {
		writeError(w, http.StatusForbidden, "you cannot move yourself; join the other channel instead")
		return
	}

	rank, err := subjectRank(r.Context(), a.pool, subjectID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "user not found")
		return
	case err != nil:
		slog.Error("loading subject for voice move", "err", err)
		writeError(w, http.StatusInternalServerError, "could not move the user")
		return
	}
	// Same rule as bans and server mute: moderators cannot move each other.
	if !perm.Outranks(actor.Rank, rank) {
		writeError(w, http.StatusForbidden, "you cannot move someone at or above your own rank")
		return
	}

	// The moderator must see both channels; a channel they cannot see is
	// not confirmed to exist.
	from, err := a.channelPermsFor(r.Context(), actor, req.FromChannelID)
	if err != nil || from.Kind != "voice" {
		writeError(w, http.StatusNotFound, "voice channel not found")
		return
	}
	var toName string
	if req.ToChannelID != "" {
		to, err := a.channelPermsFor(r.Context(), actor, req.ToChannelID)
		if err != nil || to.Kind != "voice" {
			writeError(w, http.StatusNotFound, "voice channel not found")
			return
		}
		ok, err := a.userCanView(r.Context(), subjectID, req.ToChannelID)
		if err != nil {
			slog.Error("checking voice move target", "err", err)
			writeError(w, http.StatusInternalServerError, "could not move the user")
			return
		}
		if !ok {
			writeError(w, http.StatusForbidden, "they are not allowed in that channel")
			return
		}
		if err := a.pool.QueryRow(r.Context(),
			`SELECT name FROM channels WHERE id = $1`, req.ToChannelID).Scan(&toName); err != nil {
			slog.Error("reading voice move target name", "err", err)
			writeError(w, http.StatusInternalServerError, "could not move the user")
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	in, err := a.inRoom(ctx, req.FromChannelID, subjectID)
	if err != nil {
		slog.Error("checking voice move subject", "err", err)
		writeError(w, http.StatusBadGateway, "could not reach the voice server")
		return
	}
	if !in {
		writeError(w, http.StatusConflict, "they are not in that call any more")
		return
	}

	action, detail := "voice_move", toName
	if req.ToChannelID == "" {
		action = "voice_disconnect"
		detail = ""
	}
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting voice move", "err", err)
		writeError(w, http.StatusInternalServerError, "could not move the user")
		return
	}
	defer tx.Rollback(r.Context())
	if err := logModeration(r.Context(), tx, actor.UserID, action, subjectID, detail); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, "could not move the user")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing voice move", "err", err)
		writeError(w, http.StatusInternalServerError, "could not move the user")
		return
	}

	// The event first, so the client can say who did it before the call
	// drops under it.
	a.emitUsers(map[string]bool{subjectID: true}, voiceMovedEvent{
		Type: "voice_moved", FromChannelID: req.FromChannelID,
		ToChannelID: req.ToChannelID, Username: actor.Username,
	})
	grace := voiceMoveGrace
	if req.ToChannelID == "" {
		grace = 300 * time.Millisecond
	}
	a.removeAfter(req.FromChannelID, subjectID, grace)

	slog.Info("user moved in voice", "actor_id", actor.UserID, "subject_id", subjectID,
		"from", req.FromChannelID, "to", req.ToChannelID)
	w.WriteHeader(http.StatusNoContent)
}

// inRoom reports whether an account is in a LiveKit room now.
func (a *API) inRoom(ctx context.Context, room, userID string) (bool, error) {
	people, err := a.listParticipants(ctx, room)
	if err != nil {
		return false, err
	}
	for _, id := range people {
		if id == userID {
			return true, nil
		}
	}
	return false, nil
}

// removeAfter takes an account out of a room after a delay, unless it
// has left by then. In the background, like kickFromLostVoice.
func (a *API) removeAfter(room, userID string, delay time.Duration) {
	go func() {
		time.Sleep(delay)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		removed, err := a.removeParticipant(ctx, room, userID)
		if err != nil {
			slog.Error("removing moved voice participant", "err", err,
				"channel_id", room, "user_id", userID)
			return
		}
		if removed {
			a.notifyVoiceChanged(room)
		}
	}()
}
