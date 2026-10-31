// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package hub broadcasts messages to the clients currently watching a
// channel.
//
// This is deliberately in-memory and single-process. It works for one server
// instance, which is all we need. Running several instances would need a
// shared bus (Redis pub/sub, Postgres LISTEN/NOTIFY) so a message published
// on one reaches subscribers on another. Not a concern at our target scale,
// but worth knowing this is the piece that would change.
package hub

import (
	"log/slog"
	"sync"
)

// sendBuffer is how many messages may queue for one client before we give
// up on it. A client this far behind is stalled or malicious; dropping it
// protects everyone else from head-of-line blocking.
const sendBuffer = 32

// Client is one connected websocket. Send is closed by the hub when the
// client is removed, so the writer goroutine can exit cleanly.
type Client struct {
	Send chan []byte

	// Who this connection belongs to, so a ban or an account deletion can
	// find and close it. An authenticated connection that outlives its
	// account is a connection that keeps working after the account should
	// have stopped.
	UserID string

	// Guards against closing Send twice, which would panic.
	closeOnce sync.Once
}

func NewClient(userID string) *Client {
	return &Client{
		Send:   make(chan []byte, sendBuffer),
		UserID: userID,
	}
}

func (c *Client) close() {
	c.closeOnce.Do(func() { close(c.Send) })
}

type Hub struct {
	mu       sync.RWMutex
	channels map[string]map[*Client]struct{}

	// Every connected client, regardless of which channel they are
	// watching. Server-wide events (an account deleted, a channel's
	// settings changed) go here so clients can react without reconnecting.
	all map[*Client]struct{}
}

func New() *Hub {
	return &Hub{
		channels: make(map[string]map[*Client]struct{}),
		all:      make(map[*Client]struct{}),
	}
}

// Subscribe adds c to a channel's subscriber set.
func (h *Hub) Subscribe(channelID string, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.channels[channelID] == nil {
		h.channels[channelID] = make(map[*Client]struct{})
	}
	h.channels[channelID][c] = struct{}{}
	h.all[c] = struct{}{}
}

// Unsubscribe removes c and closes its send channel. Safe to call twice.
func (h *Hub) Unsubscribe(channelID string, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if subs, ok := h.channels[channelID]; ok {
		delete(subs, c)
		if len(subs) == 0 {
			delete(h.channels, channelID)
		}
	}
	delete(h.all, c)
	c.close()
}

// Broadcast delivers payload to every subscriber of channelID.
//
// The send is non-blocking: a client whose buffer is full gets dropped
// rather than stalling the broadcast. One slow connection must never be
// able to freeze a channel for everyone in it.
func (h *Hub) Broadcast(channelID string, payload []byte) {
	h.mu.RLock()
	stalled := make([]*Client, 0)
	for c := range h.channels[channelID] {
		select {
		case c.Send <- payload:
		default:
			stalled = append(stalled, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range stalled {
		slog.Warn("dropping stalled websocket client", "channel_id", channelID)
		h.Unsubscribe(channelID, c)
	}
}

// BroadcastAll delivers payload to every connected client.
//
// Used for events that are not scoped to one channel: an account was
// deleted, a channel's settings changed, someone's role moved. Same
// non-blocking send as Broadcast, for the same reason.
func (h *Hub) BroadcastAll(payload []byte) {
	h.mu.RLock()
	stalled := make([]*Client, 0)
	for c := range h.all {
		select {
		case c.Send <- payload:
		default:
			stalled = append(stalled, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range stalled {
		slog.Warn("dropping stalled websocket client")
		c.close()
	}
}

// DisconnectUser closes every connection belonging to a user and reports
// how many it closed.
//
// Needed because a websocket is authenticated once, at upgrade, and then
// runs until it is closed. Deleting sessions stops the next login; it does
// nothing to a socket that is already open. Without this, a banned user
// keeps posting until they happen to disconnect.
func (h *Hub) DisconnectUser(userID string) int {
	h.mu.Lock()

	doomed := make([]*Client, 0)
	for c := range h.all {
		if c.UserID == userID {
			doomed = append(doomed, c)
		}
	}

	// Remove from every channel set before closing, so a broadcast racing
	// this cannot send on a closed channel.
	for _, c := range doomed {
		for id, subs := range h.channels {
			if _, ok := subs[c]; ok {
				delete(subs, c)
				if len(subs) == 0 {
					delete(h.channels, id)
				}
			}
		}
		delete(h.all, c)
	}

	h.mu.Unlock()

	for _, c := range doomed {
		c.close()
	}

	if len(doomed) > 0 {
		slog.Info("closed websocket connections", "user_id", userID, "count", len(doomed))
	}
	return len(doomed)
}

// UserChannels lists the channels a user has a connection open to.
func (h *Hub) UserChannels(userID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	out := make([]string, 0)
	for id, subs := range h.channels {
		for c := range subs {
			if c.UserID == userID {
				out = append(out, id)
				break
			}
		}
	}
	return out
}

// DisconnectUserFrom closes a user's connections to one channel and
// reports how many it closed. Their other connections stay up.
//
// For a revocation narrower than a ban: a demoted account loses some
// channels and keeps the rest, so closing everything would be wrong in
// the other direction.
func (h *Hub) DisconnectUserFrom(userID, channelID string) int {
	h.mu.Lock()

	doomed := make([]*Client, 0)
	if subs, ok := h.channels[channelID]; ok {
		for c := range subs {
			if c.UserID == userID {
				doomed = append(doomed, c)
			}
		}
		for _, c := range doomed {
			delete(subs, c)
			delete(h.all, c)
		}
		if len(subs) == 0 {
			delete(h.channels, channelID)
		}
	}

	h.mu.Unlock()

	for _, c := range doomed {
		c.close()
	}
	return len(doomed)
}

// SubscriberCount is used by the health endpoint and tests.
func (h *Hub) SubscriberCount(channelID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.channels[channelID])
}
