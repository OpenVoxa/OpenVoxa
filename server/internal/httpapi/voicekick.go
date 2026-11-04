// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"log/slog"
	"strings"
	"time"
)

// kickFromLostVoice removes a user from every voice call they may no
// longer be in (banned, demoted below a channel's view role, deleted).
//
// A LiveKit token only gates joining. Once connected, a participant stays
// until removed, and found on Docker 2026-10-31: a banned account stayed
// in the call and stayed audible. Its device is reconciled out of the
// voice channel's MLS group too, which rotates the media key, but clients
// keep old keys for a short handover; removing the participant is what
// takes it out at once.
//
// Runs in the background with its own deadline, so a slow or missing
// LiveKit never holds up the request that caused it. Participants are
// keyed by user ID (see voiceToken), so this acts on the account, not a
// device: revoking one device does not kick, because the account's other
// device may be the one in the call.
func (a *API) kickFromLostVoice(userID string) {
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		rows, err := a.pool.Query(ctx, `SELECT id::text FROM channels WHERE kind = 'voice'`)
		if err != nil {
			slog.Error("listing voice channels", "err", err)
			return
		}
		var rooms []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil {
				rooms = append(rooms, id)
			}
		}
		rows.Close()

		for _, room := range rooms {
			ok, err := a.userCanView(ctx, userID, room)
			if err != nil {
				slog.Error("re-checking voice access", "err", err, "channel_id", room)
				continue
			}
			if ok {
				continue
			}
			removed, err := a.removeParticipant(ctx, room, userID)
			if err != nil {
				slog.Error("removing voice participant", "err", err,
					"channel_id", room, "user_id", userID)
				continue
			}
			if removed {
				a.notifyVoiceChanged(room)
				slog.Info("removed from voice after losing access",
					"channel_id", room, "user_id", userID)
			}
		}
	}()
}

// kickLostFromAllVoice removes, from every voice call, each participant
// who may no longer view that channel. For changes that can move many
// accounts at once (a group edited or deleted, a channel's allow-list
// replaced): asking LiveKit who is in each room costs one call per room,
// where kickFromLostVoice per account would cost one per account per
// room.
func (a *API) kickLostFromAllVoice() {
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		rows, err := a.pool.Query(ctx, `SELECT id::text FROM channels WHERE kind = 'voice'`)
		if err != nil {
			slog.Error("listing voice channels", "err", err)
			return
		}
		var rooms []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil {
				rooms = append(rooms, id)
			}
		}
		rows.Close()

		for _, room := range rooms {
			people, err := a.listParticipants(ctx, room)
			if err != nil {
				slog.Error("listing voice participants", "err", err, "channel_id", room)
				continue
			}
			for _, userID := range people {
				ok, err := a.userCanView(ctx, userID, room)
				if err != nil || ok {
					continue
				}
				if removed, err := a.removeParticipant(ctx, room, userID); err != nil {
					slog.Error("removing voice participant", "err", err,
						"channel_id", room, "user_id", userID)
				} else if removed {
					a.notifyVoiceChanged(room)
					slog.Info("removed from voice after losing access",
						"channel_id", room, "user_id", userID)
				}
			}
		}
	}()
}

// listParticipants returns the identities (user IDs, see voiceToken) in
// a LiveKit room. A room nobody is in does not exist, which is not an
// error.
func (a *API) listParticipants(ctx context.Context, room string) ([]string, error) {
	people, err := a.liveKitParticipants(ctx, room)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(people))
	for _, p := range people {
		ids = append(ids, p.Identity)
	}
	return ids, nil
}

// liveKitAPIURL is where this server reaches LiveKit's HTTP API.
func (a *API) liveKitAPIURL() string {
	if a.livekit.APIURL != "" {
		return strings.TrimRight(a.livekit.APIURL, "/")
	}
	u := strings.TrimRight(a.livekit.URL, "/")
	u = strings.Replace(u, "wss://", "https://", 1)
	return strings.Replace(u, "ws://", "http://", 1)
}

// removeParticipant takes a user out of a LiveKit room. Reports false
// when the user was not in that room, which is the usual case.
func (a *API) removeParticipant(ctx context.Context, room, identity string) (bool, error) {
	return a.roomService(ctx, "RemoveParticipant", roomAdmin(room),
		map[string]string{"room": room, "identity": identity}, nil)
}
