// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/json"
	"log/slog"
	"time"
)

// Server-to-client events.
//
// Without these, anything that changes outside the normal message flow is
// invisible until a client reconnects: deleted content stays on screen,
// settings changes go unnoticed, and a revoked permission still looks
// granted. For a project whose promise is that users control their own
// data, content lingering on other people's screens after deletion is the
// version of that which actually matters.
//
// Every event is advisory for display purposes. None of them grant or
// revoke anything on their own; the server re-checks permissions on each
// request regardless of what a client believes.

type userPurgedEvent struct {
	Type   string `json:"type"`
	UserID string `json:"user_id"`
}

type channelPurgedEvent struct {
	Type      string    `json:"type"`
	ChannelID string    `json:"channel_id"`
	Before    time.Time `json:"before"`
}

type messageDeletedEvent struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
}

type channelChangedEvent struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
}

type groupAdvancedEvent struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	Epoch     int64  `json:"epoch"`
}

type roleChangedEvent struct {
	Type   string `json:"type"`
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

func (a *API) emitAll(v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		slog.Error("marshalling event", "err", err)
		return
	}
	a.hub.BroadcastAll(payload)
}

func (a *API) emitChannel(channelID string, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		slog.Error("marshalling event", "err", err)
		return
	}
	a.hub.Broadcast(channelID, payload)
}

// NotifyUserPurged tells every connected client that an account and its
// content are gone, so open sessions replace that user's messages with
// tombstones immediately rather than at next reconnect.
//
// This cannot reach a client that is offline, and it cannot undo a
// screenshot. It covers the case it can cover.
func (a *API) NotifyUserPurged(userID string) {
	a.emitAll(userPurgedEvent{Type: "user_purged", UserID: userID})
}

// NotifyChannelPurged reports that everything in a channel older than a
// cutoff has been removed. Sent once per sweep per channel rather than
// once per message, because a retention sweep can remove thousands of rows
// and clients only need the cutoff to drop them locally.
func (a *API) NotifyChannelPurged(channelID string, before time.Time) {
	a.emitChannel(channelID, channelPurgedEvent{
		Type:      "channel_purged",
		ChannelID: channelID,
		Before:    before,
	})
}

// NotifyMessageDeleted reports a single message removal.
func (a *API) NotifyMessageDeleted(channelID, messageID string) {
	a.emitChannel(channelID, messageDeletedEvent{
		Type:      "message_deleted",
		ChannelID: channelID,
		MessageID: messageID,
	})
}

// NotifyChannelChanged tells clients a channel's settings moved, so they
// refetch the list. The event carries only the ID: what each client is
// allowed to see differs by role, so the authoritative answer has to come
// from the channels endpoint rather than from a broadcast.
func (a *API) NotifyChannelChanged(channelID string) {
	a.emitAll(channelChangedEvent{Type: "channel_changed", ChannelID: channelID})
}

func (a *API) NotifyChannelDeleted(channelID string) {
	a.emitAll(channelChangedEvent{Type: "channel_deleted", ChannelID: channelID})
}

// NotifyGroupAdvanced tells members of a channel that the MLS group moved
// to a new epoch, so they fetch and apply the commit immediately rather
// than discovering it when their next message fails to decrypt.
//
// Carries the epoch only. The commit itself is fetched over HTTP, because
// a client that was offline may need several and the websocket is not the
// right place to replay a log.
func (a *API) NotifyGroupAdvanced(channelID string, epoch int64) {
	a.emitChannel(channelID, groupAdvancedEvent{
		Type:      "group_advanced",
		ChannelID: channelID,
		Epoch:     epoch,
	})
}

// NotifyRoleChanged lets a client discover a promotion or demotion
// promptly. The server already re-reads the role on every request, so this
// only keeps the interface honest.
func (a *API) NotifyRoleChanged(userID, role string) {
	a.emitAll(roleChangedEvent{Type: "role_changed", UserID: userID, Role: role})
}
