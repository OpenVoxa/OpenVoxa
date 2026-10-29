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

	// Guards against closing Send twice, which would panic.
	closeOnce sync.Once
}

func NewClient() *Client {
	return &Client{Send: make(chan []byte, sendBuffer)}
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

// SubscriberCount is used by the health endpoint and tests.
func (h *Hub) SubscriberCount(channelID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.channels[channelID])
}
