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

type accessChangedEvent struct {
	Type string `json:"type"`
}

// permsChangedEvent says someone's groups or a group's switches moved.
// UserID empty means it may affect anyone, so every client refetches.
type permsChangedEvent struct {
	Type   string `json:"type"`
	UserID string `json:"user_id"`
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

// emitUsers sends an event only to the connections of the given accounts.
func (a *API) emitUsers(users map[string]bool, v any) {
	if len(users) == 0 {
		return
	}
	payload, err := json.Marshal(v)
	if err != nil {
		slog.Error("marshalling event", "err", err)
		return
	}
	a.hub.BroadcastUsers(users, payload)
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
// allowed to see differs by account, so the authoritative answer has to come
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

// NotifyPermsChanged lets clients discover a change to someone's groups
// (userID set) or to a group itself (userID empty) promptly: the affected
// client refetches /me and the channel list, and members reconcile their
// open encryption groups. The server already re-reads permissions on
// every request, so this only keeps the interface honest. Carries no
// permissions: what changed is for each client to ask.
func (a *API) NotifyPermsChanged(userID string) {
	a.emitAll(permsChangedEvent{Type: "perms_changed", UserID: userID})
}

// NotifyAccessChanged tells clients that who belongs in some encryption
// groups may have changed: an account was banned or unbanned, a device
// was revoked, or a device published key packages (which is how a new
// device, or one that ran out, becomes addable). Members' clients
// reconcile the groups they have open in response.
//
// Carries nothing. Which channels are affected depends on permissions
// each client has to ask about anyway, and the allowed-devices endpoint
// is the authoritative answer. Permission changes have their own event,
// perms_changed, which clients treat the same way.
func (a *API) NotifyAccessChanged() {
	a.emitAll(accessChangedEvent{Type: "access_changed"})
}
