// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
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

// archiveEvent tells every device that may keep a local plaintext copy
// of an encrypted channel's messages that some of them are gone, so it
// can delete its copies while the app stays open, not only at the next
// start (Chat.pruneArchive in client-core). Types:
//
//   - "archive_message_gone": one message, by MessageID.
//   - "archive_channel_expired": a retention sweep removed messages
//     before Before; the client asks archive-check which ids went.
//
// These are separate from message_deleted and channel_purged because
// emitUsers reaches every socket of an account, channel sockets
// included, and the open channel's view must not apply a deletion twice.
type archiveEvent struct {
	Type      string     `json:"type"`
	ChannelID string     `json:"channel_id"`
	MessageID string     `json:"message_id,omitempty"`
	Before    *time.Time `json:"before,omitempty"`
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

type reportsChangedEvent struct {
	Type string `json:"type"`
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
	a.notifyArchives(channelID, archiveEvent{
		Type:      "archive_channel_expired",
		ChannelID: channelID,
		Before:    &before,
	})
}

// NotifyMessageDeleted reports a single message removal.
func (a *API) NotifyMessageDeleted(channelID, messageID string) {
	a.emitChannel(channelID, messageDeletedEvent{
		Type:      "message_deleted",
		ChannelID: channelID,
		MessageID: messageID,
	})
	a.notifyArchives(channelID, archiveEvent{
		Type:      "archive_message_gone",
		ChannelID: channelID,
		MessageID: messageID,
	})
}

// notifyArchives sends an archiveEvent to every connected account that may
// view the channel, if the channel is encrypted: plaintext channels have
// no local archive. Viewers only, as with channel_activity, so outsiders
// learn nothing about a hidden channel. Someone who has since lost access
// still holds old copies; their next start's archive-check removes them.
// Runs in the background so a slow query never delays the deletion.
func (a *API) notifyArchives(channelID string, ev archiveEvent) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		var encrypted bool
		err := a.pool.QueryRow(ctx,
			`SELECT encrypted FROM channels WHERE id = $1`, channelID).Scan(&encrypted)
		if err != nil {
			// A channel deleted meanwhile is covered by channel_deleted.
			slog.Debug("checking channel for archive event", "err", err, "channel_id", channelID)
			return
		}
		if !encrypted {
			return
		}
		viewers, err := a.channelViewers(ctx, channelID)
		if err != nil {
			slog.Warn("listing channel viewers for archive event", "err", err, "channel_id", channelID)
			return
		}
		a.emitUsers(viewers, ev)
	}()
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

// NotifyReportsChanged tells everyone who can read reports that the open
// queue changed (a report was filed or resolved), so their client can
// refetch it and show or clear the pending-report dot. Sent only to
// holders of View reports: ordinary accounts have no business knowing
// when someone is reported. Carries nothing; the list is fetched.
func (a *API) NotifyReportsChanged(ctx context.Context) {
	rows, err := a.pool.Query(ctx,
		`SELECT DISTINCT eg.user_id
		   FROM effective_groups eg
		   JOIN perm_groups g ON g.id = eg.group_id
		  WHERE g.permissions && ARRAY['view_reports', 'administrator']::text[]`)
	if err != nil {
		slog.Error("finding report readers", "err", err)
		return
	}
	defer rows.Close()
	users := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			slog.Error("scanning report reader", "err", err)
			return
		}
		users[id] = true
	}
	if rows.Err() != nil {
		slog.Error("iterating report readers", "err", rows.Err())
		return
	}
	a.emitUsers(users, reportsChangedEvent{Type: "reports_changed"})
}
