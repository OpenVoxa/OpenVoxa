// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/json"
	"log/slog"
	"time"
)

// Typing indicators ("bot-mod is typing…").
//
// While someone types, their client sends {"type":"typing"} on the
// channel's socket, at most every few seconds, and {"type":"typing_stop"}
// when they empty the box. The server passes each one on to everyone
// watching the channel and keeps nothing: no table, no memory past this
// connection. Viewers drop a name on their own after a few seconds without
// a signal, or when that person's message arrives.
//
// In encrypted channels and DMs this tells the server who is typing where
// and when (never what), the same kind of metadata as mentions
// (decisions.md, "Typing indicators"). Someone who turns "Show when I'm
// typing" off sends nothing at all.

// typingInterval is the least time between two typing signals the server
// passes on for one connection. The client sends every 3 seconds; a
// little slack covers timer jitter. Anything faster is dropped silently.
const typingInterval = 2500 * time.Millisecond

type typingFrame struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	// The person stopped (emptied the box): remove them at once.
	Stop bool `json:"stop,omitempty"`
}

// typingGate decides which of one connection's typing signals go out, so
// a client can't flood a channel with them. Not safe for concurrent use:
// each connection's read loop owns one.
type typingGate struct {
	last   time.Time
	active bool
}

// allow reports whether a typing (stop false) or typing_stop (stop true)
// signal arriving at now should be passed on.
func (g *typingGate) allow(stop bool, now time.Time) bool {
	if stop {
		// Only after a start, once: a stop can't be repeated as a flood.
		if !g.active {
			return false
		}
		g.active = false
		g.last = time.Time{} // typing again right away is a fresh start
		return true
	}
	if g.active && now.Sub(g.last) < typingInterval {
		return false
	}
	g.last, g.active = now, true
	return true
}

// sent records that the connection posted a message, which clears the
// typing line on every screen; the next keystroke starts afresh.
func (g *typingGate) sent() {
	g.last, g.active = time.Time{}, false
}

func (a *API) broadcastTyping(s Session, channelID string, stop bool) {
	payload, err := json.Marshal(typingFrame{
		Type: "typing", ChannelID: channelID, UserID: s.UserID, Username: s.Username, Stop: stop,
	})
	if err != nil {
		slog.Error("encoding typing frame", "err", err)
		return
	}
	// The sender's own socket gets it too; clients skip their own name.
	a.hub.Broadcast(channelID, payload)
}
