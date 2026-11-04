// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/livekit/protocol/auth"
)

// Calls to LiveKit's admin API (RoomService), shared by voice kicks,
// voice presence, the screen share limit and server mute.
//
// The API is Twirp: a POST of JSON to /twirp/livekit.RoomService/<Method>,
// authorised by a short-lived token signed with the same secret as join
// tokens. That needs no client library beyond the token signer.
//
// What LiveKit reports about a track (found by experiment on Docker,
// 2026-11-04, LiveKit v1.13.11): width, height and, per simulcast layer,
// width, height and bitrate. All of them are what the publishing browser
// declared when it published, not what LiveKit measured; the API has no
// measured bitrate. Snake_case field names, enums as strings.

// roomAdmin is the grant for acting on participants in one room.
func roomAdmin(room string) *auth.VideoGrant {
	return &auth.VideoGrant{RoomAdmin: true, Room: room}
}

// roomService calls one RoomService method and decodes the answer into
// out (when not nil). Reports false, with no error, when LiveKit answers
// 404: the room or participant does not exist, the usual case for a
// room nobody is in.
func (a *API) roomService(ctx context.Context, method string, grant *auth.VideoGrant, body, out any) (bool, error) {
	token, err := auth.NewAccessToken(a.livekit.APIKey, a.livekit.APISecret).
		SetVideoGrant(grant).
		SetValidFor(time.Minute).
		ToJWT()
	if err != nil {
		return false, fmt.Errorf("minting admin token: %w", err)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		a.liveKitAPIURL()+"/twirp/livekit.RoomService/"+method, bytes.NewReader(payload))
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
	case res.StatusCode == http.StatusNotFound:
		return false, nil
	case res.StatusCode != http.StatusOK:
		return false, fmt.Errorf("livekit %s answered %s", method, res.Status)
	}
	if out != nil {
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			return false, fmt.Errorf("decoding %s: %w", method, err)
		}
	}
	return true, nil
}

// lkLayer is one simulcast layer of a video track, as declared.
type lkLayer struct {
	Width   uint32 `json:"width"`
	Height  uint32 `json:"height"`
	Bitrate uint32 `json:"bitrate"`
}

// lkTrack is a published track, as LiveKit reports it.
type lkTrack struct {
	SID    string    `json:"sid"`
	Type   string    `json:"type"`   // AUDIO, VIDEO, DATA
	Source string    `json:"source"` // MICROPHONE, SCREEN_SHARE, ...
	Width  uint32    `json:"width"`
	Height uint32    `json:"height"`
	Layers []lkLayer `json:"layers"`
	Codecs []struct {
		Layers []lkLayer `json:"layers"`
	} `json:"codecs"`
}

// lkParticipant is one person in a room. Permission is kept raw so a
// change to one field can send every other field back unchanged:
// UpdateParticipant replaces the whole permission.
type lkParticipant struct {
	Identity   string                     `json:"identity"`
	Permission map[string]json.RawMessage `json:"permission"`
	Tracks     []lkTrack                  `json:"tracks"`
}

// liveKitParticipants lists who is in a room, with their tracks. A room
// that does not exist has nobody in it.
func (a *API) liveKitParticipants(ctx context.Context, room string) ([]lkParticipant, error) {
	var out struct {
		Participants []lkParticipant `json:"participants"`
	}
	if _, err := a.roomService(ctx, "ListParticipants", roomAdmin(room),
		map[string]string{"room": room}, &out); err != nil {
		return nil, err
	}
	return out.Participants, nil
}

// lkRoom is a live room.
type lkRoom struct {
	Name          string `json:"name"`
	NumPublishers uint32 `json:"num_publishers"`
}

// liveKitRooms lists every live room (a room exists while anyone is in it).
func (a *API) liveKitRooms(ctx context.Context) ([]lkRoom, error) {
	var out struct {
		Rooms []lkRoom `json:"rooms"`
	}
	if _, err := a.roomService(ctx, "ListRooms", &auth.VideoGrant{RoomList: true},
		map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out.Rooms, nil
}

// Track sources, as LiveKit names them. An empty can_publish_sources
// list means all of these.
var allSources = []string{"CAMERA", "MICROPHONE", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"}

// publishSources reads what a participant may publish now: can is false
// for a listen-only participant (no post permission), and sources is
// never empty (LiveKit's empty list is expanded to allSources).
// can_publish is omitted from LiveKit's JSON when false.
func publishSources(p lkParticipant) (sources []string, can bool) {
	if raw, ok := p.Permission["can_publish"]; ok {
		_ = json.Unmarshal(raw, &can)
	}
	if raw, ok := p.Permission["can_publish_sources"]; ok {
		_ = json.Unmarshal(raw, &sources)
	}
	if len(sources) == 0 {
		sources = allSources
	}
	return sources, can
}

// editSources returns cur without remove and with add, in allSources
// order. Never empty: with nothing left it returns {"CAMERA"}, a source
// the app never publishes, because an empty list would mean "any".
// Reports whether anything changed.
func editSources(cur, remove, add []string) ([]string, bool) {
	out := make([]string, 0, len(allSources))
	for _, s := range allSources {
		on := slices.Contains(cur, s)
		if slices.Contains(remove, s) {
			on = false
		}
		if slices.Contains(add, s) {
			on = true
		}
		if on {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		out = []string{"CAMERA"}
	}
	changed := len(out) != len(cur)
	for _, s := range out {
		if !slices.Contains(cur, s) {
			changed = true
		}
	}
	return out, changed
}

// setPublishSources limits what a participant may publish, for the rest
// of this connection (rejoining mints a fresh token from the database's
// state). LiveKit unpublishes any track whose source is no longer
// allowed, at once, and refuses new ones ("insufficient permissions").
// Every other permission field is sent back as it was. An empty list
// would mean "any source", so callers must pass at least one (see
// editSources).
func (a *API) setPublishSources(ctx context.Context, room string, p lkParticipant, sources []string) (bool, error) {
	perm := make(map[string]json.RawMessage, len(p.Permission)+1)
	for k, v := range p.Permission {
		perm[k] = v
	}
	list, err := json.Marshal(sources)
	if err != nil {
		return false, err
	}
	perm["can_publish_sources"] = list
	return a.roomService(ctx, "UpdateParticipant", roomAdmin(room),
		map[string]any{"room": room, "identity": p.Identity, "permission": perm}, nil)
}
