// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
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
	admin := auth.NewAccessToken(a.livekit.APIKey, a.livekit.APISecret).
		SetVideoGrant(&auth.VideoGrant{RoomAdmin: true, Room: room}).
		SetValidFor(time.Minute)
	token, err := admin.ToJWT()
	if err != nil {
		return nil, fmt.Errorf("minting admin token: %w", err)
	}

	body, _ := json.Marshal(map[string]string{"room": room})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		a.liveKitAPIURL()+"/twirp/livekit.RoomService/ListParticipants",
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	switch {
	case res.StatusCode == http.StatusNotFound:
		return nil, nil
	case res.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("livekit answered %s", res.Status)
	}

	var out struct {
		Participants []struct {
			Identity string `json:"identity"`
		} `json:"participants"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decoding participants: %w", err)
	}
	ids := make([]string, 0, len(out.Participants))
	for _, p := range out.Participants {
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

// removeParticipant calls LiveKit's RoomService.RemoveParticipant over
// Twirp with JSON, which needs no client library beyond the token signer
// already used for join tokens. Reports false when the user was not in
// that room, which is the usual case.
func (a *API) removeParticipant(ctx context.Context, room, identity string) (bool, error) {
	admin := auth.NewAccessToken(a.livekit.APIKey, a.livekit.APISecret).
		SetVideoGrant(&auth.VideoGrant{RoomAdmin: true, Room: room}).
		SetValidFor(time.Minute)
	token, err := admin.ToJWT()
	if err != nil {
		return false, fmt.Errorf("minting admin token: %w", err)
	}

	body, _ := json.Marshal(map[string]string{"room": room, "identity": identity})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		a.liveKitAPIURL()+"/twirp/livekit.RoomService/RemoveParticipant",
		bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()

	switch {
	case res.StatusCode == http.StatusOK:
		return true, nil
	case res.StatusCode == http.StatusNotFound:
		return false, nil // not in this room, or the room does not exist
	default:
		return false, fmt.Errorf("livekit answered %s", res.Status)
	}
}
