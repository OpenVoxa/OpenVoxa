// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// Server mute (decisions.md Feature decisions, "Server mute"): a holder
// of server_mute takes away someone's microphone and screen share audio
// in every voice channel, until unmuted or for a while. Screen video
// stays allowed.
//
// Why this and not "real" force-PTT: only the client knows whether a
// push-to-talk key is down, and voice is end-to-end encrypted, so the
// server cannot check what a client claims. Taking the microphone away
// is something LiveKit enforces whatever the client does.
//
// The database row is the truth. Every path that changes it (mute,
// unmute, expiry) then calls applyVoiceMute, which brings the live calls
// in line; the join token reads the row too, so rejoining is no way out.

// voiceMuteSweepInterval is how late a timed mute may lift.
const voiceMuteSweepInterval = 15 * time.Second

// mutedSources are what a server mute takes away.
var mutedSources = []string{"MICROPHONE", "SCREEN_SHARE_AUDIO"}

type voiceMuteRequest struct {
	// Postgres interval syntax ("10 minutes", "1 hour"). Empty means
	// until unmuted.
	Duration string `json:"duration"`
}

type voiceMuteResponse struct {
	ExpiresAt *time.Time `json:"expires_at"`
}

// voiceMuteState reports whether an account is server-muted now, and
// until when (nil: until unmuted).
func voiceMuteState(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, userID string) (bool, *time.Time, error) {
	var until *time.Time
	err := q.QueryRow(ctx,
		`SELECT expires_at FROM voice_mutes
		  WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
		userID).Scan(&until)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, err
	}
	return true, until, nil
}

// muteVoice server-mutes an account, or changes how long an existing
// mute lasts.
func (a *API) muteVoice(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")

	var req voiceMuteRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if subjectID == actor.UserID {
		writeError(w, http.StatusForbidden, "you cannot server-mute yourself")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting voice mute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not mute the user")
		return
	}
	defer tx.Rollback(r.Context())

	rank, err := subjectRank(r.Context(), tx, subjectID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "user not found")
		return
	case err != nil:
		slog.Error("loading subject for voice mute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not mute the user")
		return
	}
	// Same rule as bans: moderators cannot mute each other.
	if !perm.Outranks(actor.Rank, rank) {
		writeError(w, http.StatusForbidden,
			"you cannot server-mute someone at or above your own rank")
		return
	}

	var expires *time.Time
	if req.Duration != "" {
		var t time.Time
		var future bool
		err := tx.QueryRow(r.Context(),
			`SELECT now() + $1::interval, now() + $1::interval > now()`,
			req.Duration).Scan(&t, &future)
		if (err != nil && isInvalidInput(err)) || (err == nil && !future) {
			writeError(w, http.StatusBadRequest,
				`duration must be like "10 minutes" or "1 hour", or empty for until unmuted`)
			return
		}
		if err != nil {
			slog.Error("parsing voice mute duration", "err", err)
			writeError(w, http.StatusInternalServerError, "could not mute the user")
			return
		}
		expires = &t
	}

	if _, err := tx.Exec(r.Context(),
		`INSERT INTO voice_mutes (user_id, actor_id, expires_at) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE
		    SET actor_id = EXCLUDED.actor_id, created_at = now(),
		        expires_at = EXCLUDED.expires_at`,
		subjectID, actor.UserID, expires,
	); err != nil {
		slog.Error("recording voice mute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not mute the user")
		return
	}
	if err := logModeration(r.Context(), tx, actor.UserID, "voice_mute", subjectID, req.Duration); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, "could not mute the user")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing voice mute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not mute the user")
		return
	}

	a.applyVoiceMute(subjectID, "")
	slog.Info("user server-muted", "actor_id", actor.UserID, "subject_id", subjectID,
		"duration", req.Duration)
	writeJSON(w, http.StatusOK, voiceMuteResponse{ExpiresAt: expires})
}

// unmuteVoice lifts a server mute. Like unban, it works on anyone: a
// mute by someone senior is undone by whoever notices it is no longer
// needed.
func (a *API) unmuteVoice(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting voice unmute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not unmute the user")
		return
	}
	defer tx.Rollback(r.Context())

	tag, err := tx.Exec(r.Context(),
		`DELETE FROM voice_mutes
		  WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
		subjectID)
	if err != nil {
		slog.Error("removing voice mute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not unmute the user")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "that account is not server-muted")
		return
	}
	if err := logModeration(r.Context(), tx, actor.UserID, "voice_unmute", subjectID, ""); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, "could not unmute the user")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing voice unmute", "err", err)
		writeError(w, http.StatusInternalServerError, "could not unmute the user")
		return
	}

	a.applyVoiceMute(subjectID, "")
	slog.Info("user server-unmuted", "actor_id", actor.UserID, "subject_id", subjectID)
	w.WriteHeader(http.StatusNoContent)
}

// applyVoiceMute brings a user's live calls in line with the database:
// muted, the microphone and screen share audio are taken away; not, they
// are given back (screen audio only while screen sharing itself is still
// allowed, since the share limit may have taken that away). room limits
// it to one call; "" means every call.
//
// Runs in the background with its own deadline, like kickFromLostVoice.
func (a *API) applyVoiceMute(userID, room string) {
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		muted, _, err := voiceMuteState(ctx, a.pool, userID)
		if err != nil {
			slog.Error("reading voice mute", "err", err, "user_id", userID)
			return
		}
		rooms := []string{room}
		if room == "" {
			live, err := a.liveKitRooms(ctx)
			if err != nil {
				slog.Warn("listing voice rooms", "err", err)
				return
			}
			rooms = rooms[:0]
			for _, r := range live {
				rooms = append(rooms, r.Name)
			}
		}
		for _, name := range rooms {
			people, err := a.liveKitParticipants(ctx, name)
			if err != nil {
				slog.Warn("listing voice participants", "err", err, "channel_id", name)
				continue
			}
			for _, p := range people {
				if p.Identity != userID {
					continue
				}
				cur, can := publishSources(p)
				if !can {
					continue // listen-only: nothing to take away
				}
				var next []string
				var changed bool
				if muted {
					next, changed = editSources(cur, mutedSources, nil)
				} else {
					add := []string{"MICROPHONE"}
					if slices.Contains(cur, "SCREEN_SHARE") {
						add = append(add, "SCREEN_SHARE_AUDIO")
					}
					next, changed = editSources(cur, nil, add)
				}
				if !changed {
					continue
				}
				if _, err := a.setPublishSources(ctx, name, p, next); err != nil {
					slog.Error("applying server mute", "err", err,
						"channel_id", name, "user_id", userID, "muted", muted)
				}
			}
		}
	}()
}

// StartVoiceMuteSweep lifts timed server mutes when they run out, giving
// the microphone back in any call in progress.
func (a *API) StartVoiceMuteSweep(ctx context.Context) {
	go func() {
		t := time.NewTicker(voiceMuteSweepInterval)
		defer t.Stop()
		for {
			a.sweepVoiceMutes(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

func (a *API) sweepVoiceMutes(ctx context.Context) {
	rows, err := a.pool.Query(ctx,
		`DELETE FROM voice_mutes WHERE expires_at <= now() RETURNING user_id::text`)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("sweeping voice mutes", "err", err)
		}
		return
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		slog.Error("sweeping voice mutes", "err", err)
		return
	}
	for _, id := range ids {
		slog.Info("server mute ran out", "user_id", id)
		a.applyVoiceMute(id, "")
	}
}
