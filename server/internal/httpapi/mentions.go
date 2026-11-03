// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// @mentions (migration 0018).
//
// The sender's client lists the accounts a message mentions, by user ID,
// next to the body. The server never looks for "@name" in the text: in an
// encrypted channel it cannot, and doing it only in plaintext channels
// would give two behaviours for one feature. What it does do is filter the
// list: anyone who may not view the channel (or is banned, or deleted) is
// dropped without a word, as is the author. So a mention reaches exactly
// the people who could read the message anyway, and naming someone outside
// the channel tells them nothing, not even that the channel exists.

// maxMentions caps one message's mention list.
const maxMentions = 20

var errTooManyMentions = errors.New("too many mentions in one message")

// mentionInfo is one mentioned account, as clients see it on a message.
type mentionInfo struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

// mentionEvent goes only to the mentioned account. No text: in an
// encrypted channel there is none to give, and in a plain one the client
// can read it from the channel.
type mentionEvent struct {
	Type      string    `json:"type"`
	ChannelID string    `json:"channel_id"`
	MessageID string    `json:"message_id"`
	AuthorID  string    `json:"author_id"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"created_at"`
}

// mentionTargets keeps the IDs in ids that may view the channel, minus
// the author, without duplicates. IDs are compared as text so a malformed
// one is simply not a viewer.
func mentionTargets(
	ctx context.Context, q pgx.Tx, channelID, authorID string, ids []string,
) ([]mentionInfo, error) {
	seen := make(map[string]bool, len(ids))
	wanted := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" || id == authorID || seen[id] {
			continue
		}
		seen[id] = true
		wanted = append(wanted, id)
	}
	if len(wanted) > maxMentions {
		return nil, errTooManyMentions
	}
	out := make([]mentionInfo, 0, len(wanted))
	if len(wanted) == 0 {
		return out, nil
	}

	rows, err := q.Query(ctx,
		`SELECT u.id::text, u.username`+viewerJoins+viewerFilter+`
		    AND u.id::text = ANY($2::text[])
		  ORDER BY u.username`,
		channelID, wanted,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m mentionInfo
		if err := rows.Scan(&m.UserID, &m.Username); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// saveMentions records a message's mentions. Call with the result of
// mentionTargets, inside the same transaction.
func saveMentions(ctx context.Context, q pgx.Tx, messageID string, mentions []mentionInfo) error {
	if len(mentions) == 0 {
		return nil
	}
	ids := make([]string, len(mentions))
	for i, m := range mentions {
		ids[i] = m.UserID
	}
	_, err := q.Exec(ctx,
		`INSERT INTO message_mentions (message_id, user_id)
		 SELECT $1, unnest($2::uuid[])
		 ON CONFLICT DO NOTHING`,
		messageID, ids,
	)
	return err
}

// notifyMentions tells each mentioned account, on every socket it has.
func (a *API) notifyMentions(
	mentions []mentionInfo, channelID, messageID, authorID, author string, createdAt time.Time,
) {
	if len(mentions) == 0 {
		return
	}
	users := make(map[string]bool, len(mentions))
	for _, m := range mentions {
		users[m.UserID] = true
	}
	a.emitUsers(users, mentionEvent{
		Type:      "mention",
		ChannelID: channelID,
		MessageID: messageID,
		AuthorID:  authorID,
		Username:  author,
		CreatedAt: createdAt,
	})
}

// channelMember is someone who may view a channel.
type channelMember struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

// listChannelMembers serves GET /channels/{id}/members: everyone who may
// view the channel, for the composer's @ list. Anyone who may view the
// channel may ask. In an encrypted channel they can work this out from
// the encryption group anyway; in a plain one it is the same list the
// mention filter uses, so the composer never offers a name that would be
// dropped.
func (a *API) listChannelMembers(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	channelID := r.PathValue("id")

	p, err := a.channelPermsFor(r.Context(), session, channelID)
	switch {
	case errors.Is(err, errChannelNotFound):
		writeError(w, http.StatusNotFound, "channel not found")
		return
	case err != nil:
		slog.Error("checking channel access", "err", err, "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not list members")
		return
	case p.Kind != "text":
		writeError(w, http.StatusBadRequest, "not a text channel")
		return
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT u.id::text, u.username`+viewerJoins+viewerFilter+`
		  ORDER BY lower(u.username)`,
		channelID,
	)
	if err != nil {
		slog.Error("listing channel members", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list members")
		return
	}
	defer rows.Close()

	out := make([]channelMember, 0)
	for rows.Next() {
		var m channelMember
		if err := rows.Scan(&m.UserID, &m.Username); err != nil {
			slog.Error("scanning channel member", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list members")
			return
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating channel members", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list members")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// mentionsJSON selects message m's mentions as a JSON array, for history.
const mentionsJSON = `
	COALESCE(
	  (SELECT json_agg(json_build_object('user_id', mu.id, 'username', mu.username)
	                   ORDER BY mu.username)
	     FROM message_mentions mm
	     JOIN users mu ON mu.id = mm.user_id
	    WHERE mm.message_id = m.id),
	  '[]'::json)`
