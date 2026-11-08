// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Message history, edits and channel activity (build order 13, M2).
//
// The websocket sends the latest page of history on connect; older pages
// come from GET /channels/{id}/messages, so scrolling up never has to
// reopen the socket. Edits replace the body in place (no edit history is
// kept). In an encrypted channel the body is opaque ciphertext either
// way, so none of this needs to know whether a channel is encrypted.

// maxPageLimit caps ?limit= on the history endpoint.
const maxPageLimit = 100

// messageCursor is where a page of older history starts: strictly before
// this (created_at, id).
type messageCursor struct {
	createdAt time.Time
	id        string
}

// loadMessages returns up to limit messages of a channel, oldest first,
// ending just before the cursor (or at the newest message when cursor is
// nil). hasMore reports whether anything older remains.
func (a *API) loadMessages(
	ctx context.Context, channelID string, before *messageCursor, limit int,
) ([]messageFrame, bool, error) {
	var beforeAt *time.Time
	var beforeID *string
	if before != nil {
		beforeAt, beforeID = &before.createdAt, &before.id
	}

	// One extra row tells us whether there is more without a COUNT.
	rows, err := a.pool.Query(ctx,
		`SELECT m.id, m.author_id, COALESCE(u.username, ''), m.body, m.sealed,
		        m.deleted, m.created_at, m.edited_at,
		        COALESCE(
		          (SELECT json_agg(json_build_object(
		                     'id', at.id,
		                     'filename', at.filename,
		                     'content_type', at.content_type,
		                     'size', at.size,
		                     'uploader_id', at.uploader_id,
		                     'blob_hash', encode(at.blob_hash, 'base64'),
		                     'sealed_name', encode(at.sealed_name, 'base64'))
		                   ORDER BY at.created_at)
		             FROM attachments at WHERE at.message_id = m.id),
		          '[]'::json),`+mentionsJSON+`,`+reactionsJSON+`
		   FROM messages m
		   LEFT JOIN users u ON u.id = m.author_id
		  WHERE m.channel_id = $1
		    AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2, $3::uuid))
		  ORDER BY m.created_at DESC, m.id DESC
		  LIMIT $4`,
		channelID, beforeAt, beforeID, limit+1,
	)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	messages := make([]messageFrame, 0, limit+1)
	for rows.Next() {
		var m messageFrame
		var authorID *string
		var body []byte
		var sealed bool

		if err := rows.Scan(&m.ID, &authorID, &m.Username, &body, &sealed, &m.Deleted,
			&m.CreatedAt, &m.EditedAt, &m.Attachments, &m.Mentions, &m.Reactions); err != nil {
			return nil, false, err
		}

		m.Type = "message"
		m.ChannelID = channelID
		m.Body = a.openBody(ctx, channelID, authorID, body, sealed)
		if authorID != nil {
			m.AuthorID = *authorID
		} else {
			// Author was shredded. The message keeps its place in the
			// thread with no attribution.
			m.Username = "[deleted]"
		}

		// Links are minted per delivery, so a client that reconnects
		// after a long gap gets fresh ones rather than expired ones.
		for i := range m.Attachments {
			a.finishAttachment(ctx, channelID, &m.Attachments[i])
		}

		messages = append(messages, m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	// Queried newest-first for the LIMIT; reverse so the client renders
	// oldest to newest.
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	return messages, hasMore, nil
}

type messagePage struct {
	Messages []messageFrame `json:"messages"`
	HasMore  bool           `json:"has_more"`
}

// listMessages serves GET /channels/{id}/messages?before=<message id>&limit=N.
// Without before it returns the newest page, the same one the websocket
// sends on connect.
func (a *API) listMessages(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	channelID := r.PathValue("id")

	p, err := a.channelPermsFor(r.Context(), session, channelID)
	switch {
	case errors.Is(err, errChannelNotFound):
		writeError(w, http.StatusNotFound, "channel not found")
		return
	case err != nil:
		slog.Error("checking channel access", "err", err, "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not load messages")
		return
	case !hasMessages(p.Kind):
		writeError(w, http.StatusBadRequest, "not a text channel")
		return
	}

	limit := historyLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "limit must be a positive number")
			return
		}
		limit = min(n, maxPageLimit)
	}

	var cursor *messageCursor
	if before := r.URL.Query().Get("before"); before != "" {
		// The cursor is a message ID; its position comes from the
		// database, and it must be in this channel. IDs compare as text
		// so a malformed one is "not found", not a cast error.
		var c messageCursor
		err := a.pool.QueryRow(r.Context(),
			`SELECT id::text, created_at FROM messages
			  WHERE id::text = $1 AND channel_id = $2`,
			before, channelID,
		).Scan(&c.id, &c.createdAt)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "message not found")
			return
		}
		if err != nil {
			slog.Error("loading history cursor", "err", err)
			writeError(w, http.StatusInternalServerError, "could not load messages")
			return
		}
		cursor = &c
	}

	messages, hasMore, err := a.loadMessages(r.Context(), channelID, cursor, limit)
	if err != nil {
		slog.Error("loading history page", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load messages")
		return
	}
	writeJSON(w, http.StatusOK, messagePage{Messages: messages, HasMore: hasMore})
}

type editMessageRequest struct {
	Body string `json:"body"`
	// The edited text's mentions (mentions.go). Absent leaves them as
	// they were; present replaces them, and anyone newly mentioned is
	// told.
	Mentions *[]string `json:"mentions"`
}

type messageEditedEvent struct {
	Type      string    `json:"type"`
	ChannelID string    `json:"channel_id"`
	MessageID string    `json:"message_id"`
	Body      string    `json:"body"`
	EditedAt  time.Time `json:"edited_at"`
	// The mentions after the edit; absent when the edit left them alone.
	Mentions *[]mentionInfo `json:"mentions,omitempty"`
}

type editMessageResponse struct {
	EditedAt time.Time `json:"edited_at"`
}

// editMessage serves PATCH /messages/{id}. Only the author may edit, only
// while they may still post in the channel, and never a deleted message.
// Moderators remove; they do not rewrite other people's words.
func (a *API) editMessage(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	messageID := r.PathValue("id")

	if !a.editLimit.Allow(session.UserID) {
		writeError(w, http.StatusTooManyRequests, "slow down")
		return
	}

	var req editMessageRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	n := utf8.RuneCountInString(req.Body)
	if n == 0 {
		writeError(w, http.StatusBadRequest, "message is empty; delete it instead")
		return
	}
	if n > maxMessageRunes {
		writeError(w, http.StatusBadRequest, "message must be at most 4000 characters")
		return
	}

	var authorID *string
	var channelID string
	var deleted, encrypted bool
	err := a.pool.QueryRow(r.Context(),
		`SELECT m.author_id, m.channel_id, m.deleted, c.encrypted
		   FROM messages m JOIN channels c ON c.id = m.channel_id
		  WHERE m.id = $1`,
		messageID,
	).Scan(&authorID, &channelID, &deleted, &encrypted)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "message not found")
		return
	case err != nil:
		slog.Error("loading message for edit", "err", err)
		writeError(w, http.StatusInternalServerError, "could not edit the message")
		return
	}

	if authorID == nil || *authorID != session.UserID {
		writeError(w, http.StatusForbidden, "you can only edit your own messages")
		return
	}
	if deleted {
		writeError(w, http.StatusConflict, "the message was deleted")
		return
	}

	p, err := a.channelPermsFor(r.Context(), session, channelID)
	switch {
	case errors.Is(err, errChannelNotFound):
		writeError(w, http.StatusNotFound, "message not found")
		return
	case err != nil:
		slog.Error("checking channel access", "err", err, "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not edit the message")
		return
	case !p.CanPost:
		writeError(w, http.StatusForbidden, "you do not have permission to post in this channel")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting edit", "err", err)
		writeError(w, http.StatusInternalServerError, "could not edit the message")
		return
	}
	defer tx.Rollback(r.Context())

	// Same treatment as a new message: sealed under the author's key in a
	// plaintext channel (sealing.go), stored as sent in an encrypted one.
	stored, sealed, err := a.sealBody(channelID, session.UserID, req.Body, encrypted)
	if err != nil {
		slog.Error("sealing edited message", "err", err)
		writeError(w, http.StatusInternalServerError, "could not edit the message")
		return
	}

	// deleted is checked again in the UPDATE: a deletion that lands
	// between the read above and here must win.
	var editedAt, createdAt time.Time
	err = tx.QueryRow(r.Context(),
		`UPDATE messages SET body = $2, sealed = $3, edited_at = now()
		  WHERE id = $1 AND NOT deleted
		  RETURNING edited_at, created_at`,
		messageID, stored, sealed,
	).Scan(&editedAt, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "the message was deleted")
		return
	}
	if err != nil {
		slog.Error("editing message", "err", err)
		writeError(w, http.StatusInternalServerError, "could not edit the message")
		return
	}

	// Replace the mention set, remembering who is new to it: only they
	// are told. Someone already mentioned heard about it the first time.
	var mentions *[]mentionInfo
	var added []mentionInfo
	if req.Mentions != nil {
		list, err := mentionTargets(r.Context(), tx, channelID, session.UserID, *req.Mentions)
		if errors.Is(err, errTooManyMentions) {
			writeError(w, http.StatusBadRequest, "too many mentions in one message")
			return
		}
		if err != nil {
			slog.Error("checking mentions", "err", err)
			writeError(w, http.StatusInternalServerError, "could not edit the message")
			return
		}
		before := make(map[string]bool)
		rows, err := tx.Query(r.Context(),
			`DELETE FROM message_mentions WHERE message_id = $1 RETURNING user_id::text`, messageID)
		if err == nil {
			for rows.Next() {
				var id string
				if err = rows.Scan(&id); err != nil {
					break
				}
				before[id] = true
			}
			rows.Close()
			if err == nil {
				err = rows.Err()
			}
		}
		if err == nil {
			err = saveMentions(r.Context(), tx, messageID, list)
		}
		if err != nil {
			slog.Error("replacing mentions", "err", err)
			writeError(w, http.StatusInternalServerError, "could not edit the message")
			return
		}
		for _, m := range list {
			if !before[m.UserID] {
				added = append(added, m)
			}
		}
		mentions = &list
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing edit", "err", err)
		writeError(w, http.StatusInternalServerError, "could not edit the message")
		return
	}

	a.emitChannel(channelID, messageEditedEvent{
		Type:      "message_edited",
		ChannelID: channelID,
		MessageID: messageID,
		Body:      req.Body,
		EditedAt:  editedAt,
		Mentions:  mentions,
	})
	a.notifyMentions(added, channelID, messageID, session.UserID, session.Username, createdAt)
	writeJSON(w, http.StatusOK, editMessageResponse{EditedAt: editedAt})
}

// channelActivityEvent tells a client that a channel it may view has a
// new message, so it can mark the channel unread without having it open.
// Carries no content: in an encrypted channel there is nothing it could
// carry anyway, and for the others the channel socket is the place.
type channelActivityEvent struct {
	Type      string    `json:"type"`
	ChannelID string    `json:"channel_id"`
	MessageID string    `json:"message_id"`
	AuthorID  string    `json:"author_id"`
	CreatedAt time.Time `json:"created_at"`
}

// notifyActivity sends channel_activity to every connected account that
// may view the channel, and to nobody else: that a hidden channel is busy
// is itself something its outsiders should not learn. Runs in the
// background so a slow permission query never delays the message.
func (a *API) notifyActivity(channelID, messageID, authorID string, createdAt time.Time) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		viewers, err := a.channelViewers(ctx, channelID)
		if err != nil {
			slog.Warn("listing channel viewers for activity", "err", err, "channel_id", channelID)
			return
		}
		a.emitUsers(viewers, channelActivityEvent{
			Type:      "channel_activity",
			ChannelID: channelID,
			MessageID: messageID,
			AuthorID:  authorID,
			CreatedAt: createdAt,
		})
	}()
}

// channelViewers lists the accounts that may view a channel, by the same
// rule as everything else in access.go.
func (a *API) channelViewers(ctx context.Context, channelID string) (map[string]bool, error) {
	rows, err := a.pool.Query(ctx,
		`SELECT u.id::text`+viewerJoins+viewerFilter, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}
