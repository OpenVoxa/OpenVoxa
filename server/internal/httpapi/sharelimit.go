// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// Screen share quality limit (migration 0026; decisions.md Open items,
// "Screen share bitrate ceiling"). One limit for the whole server, set by
// an administrator in Server settings; none by default.
//
// Three layers:
//
//  1. The limit lives in server_settings.
//  2. The client asks for it before sharing, hides the presets above it
//     and caps its capture and encoder to it.
//  3. The server checks every few seconds what each live share declared
//     to LiveKit (picture size, bitrate per layer) and stops any share
//     over the limit by taking away that person's screen share permission
//     for the rest of the call.
//
// What 3 cannot do: LiveKit only knows what the browser declared, not
// what it actually sends, so a modified client that under-declares slips
// through. The backstop for that is traffic shaping on the host
// (deploy/README.md).

// shareLimit is the limit; nil means none.
type shareLimit struct {
	Res  int `json:"res"`
	FPS  int `json:"fps"`
	Kbps int `json:"kbps"`
}

type shareLimitBody struct {
	Limit *shareLimit `json:"limit"`
}

// How often live shares are checked against the limit. Only rooms with
// someone publishing are asked about, and nothing is asked while there
// is no limit.
const shareLimitInterval = 5 * time.Second

// Slack over the limit before a share counts as over it: browsers round
// sizes when scaling, and encoders declare bitrates loosely.
const (
	shareResSlack  = 8    // pixels
	shareKbpsSlack = 1.05 // 5%
)

func (a *API) loadShareLimit(ctx context.Context) (*shareLimit, error) {
	var res, fps, kbps *int
	err := a.pool.QueryRow(ctx,
		`SELECT share_max_res, share_max_fps, share_max_kbps FROM server_settings`).
		Scan(&res, &fps, &kbps)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (res == nil || fps == nil || kbps == nil)) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &shareLimit{Res: *res, FPS: *fps, Kbps: *kbps}, nil
}

// getShareLimit serves the limit to anyone signed in: the share dialog
// asks for it each time it opens.
func (a *API) getShareLimit(w http.ResponseWriter, r *http.Request) {
	limit, err := a.loadShareLimit(r.Context())
	if err != nil {
		slog.Error("reading share limit", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load the share limit")
		return
	}
	writeJSON(w, http.StatusOK, shareLimitBody{Limit: limit})
}

// putShareLimit sets or clears the limit. Administrator (route-level):
// it is about the host's own connection.
func (a *API) putShareLimit(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	var req shareLimitBody
	if !decodeJSON(w, r, &req) {
		return
	}
	var res, fps, kbps *int
	detail := "no limit"
	if l := req.Limit; l != nil {
		if l.Res < 144 || l.Res > 8640 || l.FPS < 1 || l.FPS > 240 || l.Kbps < 100 || l.Kbps > 1000000 {
			writeError(w, http.StatusBadRequest, "limit out of range")
			return
		}
		res, fps, kbps = &l.Res, &l.FPS, &l.Kbps
		detail = formatShareLimit(*l)
	}
	if _, err := a.pool.Exec(r.Context(),
		`UPDATE server_settings SET share_max_res = $1, share_max_fps = $2, share_max_kbps = $3`,
		res, fps, kbps); err != nil {
		slog.Error("saving share limit", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the setting")
		return
	}
	a.auditGroup(r.Context(), actor.UserID, "", "", "", "screen share limit: "+detail, "")
	slog.Info("screen share limit set", "actor_id", actor.UserID, "limit", detail)
	writeJSON(w, http.StatusOK, req)
}

func formatShareLimit(l shareLimit) string {
	return fmt.Sprintf("%dp %dfps %d kbps", l.Res, l.FPS, l.Kbps)
}

// overShareLimit reports whether a video track, as declared, is above
// the limit: the shorter side of the picture or of any layer, or any
// layer's bitrate. Audio tracks never are.
func overShareLimit(t lkTrack, l shareLimit) bool {
	if t.Type != "VIDEO" {
		return false
	}
	maxRes := uint32(l.Res + shareResSlack)
	maxBps := float64(l.Kbps) * 1000 * shareKbpsSlack
	short := func(w, h uint32) uint32 { return min(w, h) }
	if short(t.Width, t.Height) > maxRes {
		return true
	}
	layers := t.Layers
	for _, c := range t.Codecs {
		layers = append(layers, c.Layers...)
	}
	for _, ly := range layers {
		if short(ly.Width, ly.Height) > maxRes || float64(ly.Bitrate) > maxBps {
			return true
		}
	}
	return false
}

// StartShareLimitWatch checks live shares against the limit until ctx
// ends. Does nothing when voice is not configured.
func (a *API) StartShareLimitWatch(ctx context.Context) {
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		return
	}
	go func() {
		t := time.NewTicker(shareLimitInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				a.checkShareLimit(ctx)
			}
		}
	}()
}

func (a *API) checkShareLimit(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, shareLimitInterval)
	defer cancel()

	limit, err := a.loadShareLimit(ctx)
	if err != nil {
		slog.Error("reading share limit", "err", err)
		return
	}
	if limit == nil {
		return
	}
	rooms, err := a.liveKitRooms(ctx)
	if err != nil {
		slog.Warn("listing voice rooms", "err", err)
		return
	}
	for _, room := range rooms {
		if room.NumPublishers == 0 {
			continue
		}
		people, err := a.liveKitParticipants(ctx, room.Name)
		if err != nil {
			slog.Warn("listing voice participants", "err", err, "channel_id", room.Name)
			continue
		}
		for _, p := range people {
			for _, t := range p.Tracks {
				if !overShareLimit(t, *limit) {
					continue
				}
				// The share and its audio stop, and no new share is
				// allowed until they rejoin. Whatever else was taken away
				// (a server mute) stays away.
				cur, _ := publishSources(p)
				next, _ := editSources(cur, []string{"SCREEN_SHARE", "SCREEN_SHARE_AUDIO"}, nil)
				if _, err := a.setPublishSources(ctx, room.Name, p, next); err != nil {
					slog.Error("stopping a share over the limit", "err", err,
						"channel_id", room.Name, "user_id", p.Identity)
				} else {
					slog.Info("stopped a screen share over the limit",
						"channel_id", room.Name, "user_id", p.Identity,
						"width", t.Width, "height", t.Height, "limit", formatShareLimit(*limit))
				}
				break
			}
		}
	}
}
