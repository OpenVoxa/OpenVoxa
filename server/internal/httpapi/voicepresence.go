// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Who is in which voice channel (build order 13, M3), so a client can list
// the people in each call under the channel without joining it.
//
// LiveKit is the authority: GET /voice/participants asks it, room by
// room, for the voice channels the caller may view. Answers are cached for
// a couple of seconds, because every client asks at once whenever someone
// joins or leaves.
//
// There are no LiveKit webhooks to tell us when that happens. Instead a
// client that has just joined or left calls POST
// /channels/{id}/voice/changed, and the server forwards voice_changed to
// the accounts that may view the channel, who then ask again. A client
// that vanishes without saying so (a closed laptop) is caught by the slow
// poll clients keep up as well. The hint carries nothing and grants
// nothing: the list always comes from LiveKit.

const voicePresenceTTL = 2 * time.Second

type voicePresenceCache struct {
	mu    sync.Mutex
	rooms map[string]voicePresenceEntry
}

type voicePresenceEntry struct {
	at     time.Time
	people []string
}

type voiceParticipant struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

type voiceChangedEvent struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
}

func (c *voicePresenceCache) get(room string) ([]string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.rooms[room]
	if !ok || time.Since(e.at) > voicePresenceTTL {
		return nil, false
	}
	return e.people, true
}

func (c *voicePresenceCache) put(room string, people []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rooms == nil {
		c.rooms = make(map[string]voicePresenceEntry)
	}
	c.rooms[room] = voicePresenceEntry{at: time.Now(), people: people}
}

func (c *voicePresenceCache) forget(room string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.rooms, room)
}

// voiceParticipants serves GET /voice/participants: for every voice
// channel the caller may view and that has anyone in it, who is there.
// Empty when voice is not configured.
func (a *API) voiceParticipants(w http.ResponseWriter, r *http.Request) {
	out := map[string][]voiceParticipant{}
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		writeJSON(w, http.StatusOK, out)
		return
	}
	session := sessionFrom(r.Context())

	rows, err := a.pool.Query(r.Context(),
		`SELECT c.id::text FROM channels c, users u
		  WHERE c.kind = 'voice' AND u.id = $1 AND `+canViewSQL,
		session.UserID)
	if err != nil {
		slog.Error("listing voice channels", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list voice participants")
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

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	ids := map[string]bool{}
	byRoom := map[string][]string{}
	for _, room := range rooms {
		people, ok := a.voicePresence.get(room)
		if !ok {
			people, err = a.listParticipants(ctx, room)
			if err != nil {
				// One unreachable answer should not hide the others.
				slog.Warn("listing voice participants", "err", err, "channel_id", room)
				continue
			}
			a.voicePresence.put(room, people)
		}
		if len(people) == 0 {
			continue
		}
		byRoom[room] = people
		for _, id := range people {
			ids[id] = true
		}
	}

	// Names from our own database: LiveKit's display name is whatever the
	// token said at join time.
	names := map[string]string{}
	if len(ids) > 0 {
		list := make([]string, 0, len(ids))
		for id := range ids {
			list = append(list, id)
		}
		rows, err := a.pool.Query(r.Context(),
			`SELECT id::text, username FROM users WHERE id::text = ANY($1::text[])`, list)
		if err == nil {
			for rows.Next() {
				var id, name string
				if rows.Scan(&id, &name) == nil {
					names[id] = name
				}
			}
			rows.Close()
		}
	}

	for room, people := range byRoom {
		list := make([]voiceParticipant, 0, len(people))
		for _, id := range people {
			name, ok := names[id]
			if !ok {
				continue // not one of our accounts (or deleted meanwhile)
			}
			list = append(list, voiceParticipant{UserID: id, Username: name})
		}
		if len(list) > 0 {
			out[room] = list
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// voiceChanged serves POST /channels/{id}/voice/changed: the caller just
// joined or left the call, so viewers should refresh who is in it.
func (a *API) voiceChanged(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	channelID := r.PathValue("id")

	if !a.voiceHintLimit.Allow(session.UserID) {
		writeError(w, http.StatusTooManyRequests, "slow down")
		return
	}
	p, err := a.channelPermsFor(r.Context(), session, channelID)
	if err != nil || p.Kind != "voice" {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}
	a.notifyVoiceChanged(channelID)
	// Sent right after joining: catches a mute or unmute that landed
	// between minting this caller's token and their arrival in the call.
	a.applyVoiceMute(session.UserID, channelID)
	w.WriteHeader(http.StatusNoContent)
}

// notifyVoiceChanged drops the cached list for a room and tells the
// accounts that may view it to ask again.
func (a *API) notifyVoiceChanged(channelID string) {
	a.voicePresence.forget(channelID)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		viewers, err := a.channelViewers(ctx, channelID)
		if err != nil {
			slog.Warn("listing channel viewers for voice", "err", err, "channel_id", channelID)
			return
		}
		a.emitUsers(viewers, voiceChangedEvent{Type: "voice_changed", ChannelID: channelID})
	}()
}
