// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Emoji reactions (migration 0023).
//
// PUT /messages/{id}/reactions/{emoji} adds the caller's reaction and
// DELETE takes it away. Both are idempotent: adding twice or removing
// something absent succeeds and changes nothing. Anyone who may post in
// the channel may react.
//
// The emoji is stored in the clear in every channel, encrypted ones too
// (decisions.md, "Reactions are metadata the server sees"). It is not
// sealed under the reactor's key either: like mentions, it goes from the
// live database when the account is deleted, and is metadata rather than
// something the person wrote.

// maxReactionKinds caps how many different emoji one message can carry.
const maxReactionKinds = 20

// maxEmojiRunes is enough for the longest emoji sequences (a couple with
// two skin tones is 10 code points), short of anything resembling text.
const maxEmojiRunes = 10

// reactionInfo is one emoji on a message and who chose it, oldest first.
type reactionInfo struct {
	Emoji string        `json:"emoji"`
	Users []mentionInfo `json:"users"`
}

// reactionEvent goes to everyone with the channel open.
type reactionEvent struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	Emoji     string `json:"emoji"`
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	Added     bool   `json:"added"`
}

// reactionsJSON selects message m's reactions as a JSON array, for
// history: one entry per emoji, in the order each was first used.
const reactionsJSON = `
	COALESCE(
	  (SELECT json_agg(json_build_object('emoji', r.emoji, 'users', r.users)
	                   ORDER BY r.first, r.emoji)
	     FROM (SELECT mr.emoji, min(mr.created_at) AS first,
	                  json_agg(json_build_object('user_id', ru.id, 'username', ru.username)
	                           ORDER BY mr.created_at) AS users
	             FROM message_reactions mr
	             JOIN users ru ON ru.id = mr.user_id
	            WHERE mr.message_id = m.id
	            GROUP BY mr.emoji) r),
	  '[]'::json)`

// validEmoji reports whether s looks like one emoji: a short run of
// pictographs, flags, keycaps and their modifiers. It cannot know every
// emoji the clients do, so it errs on the side of letting odd but harmless
// sequences through; what it keeps out is text.
func validEmoji(s string) bool {
	if s == "" || !utf8.ValidString(s) || utf8.RuneCountInString(s) > maxEmojiRunes {
		return false
	}
	picture := false
	for _, r := range s {
		switch {
		case r == 0x200D, // zero-width joiner
			r == 0xFE0E, r == 0xFE0F, // text / emoji presentation
			r >= 0xE0020 && r <= 0xE007F: // tag sequences (subdivision flags)
		case r == 0x20E3: // combining keycap, after 0-9 # *
			picture = true
		case r >= '0' && r <= '9', r == '#', r == '*':
		case r >= 0x1F000 && r <= 0x1FAFF, // most emoji, skin tones, regional indicators
			r >= 0x2190 && r <= 0x21FF, // arrows
			r >= 0x2300 && r <= 0x23FF, // ⌚ ⏰ ...
			r >= 0x2460 && r <= 0x27BF, // enclosed, shapes, ☀ ✅ ➡ ...
			r >= 0x2900 && r <= 0x297F, // ⤴ ⤵
			r >= 0x2B00 && r <= 0x2BFF, // ⬆ ⭐ ...
			r == 0x00A9, r == 0x00AE, r == 0x203C, r == 0x2049, r == 0x2122, r == 0x2139,
			r == 0x3030, r == 0x303D, r == 0x3297, r == 0x3299,
			unicode.Is(unicode.So, r):
			picture = true
		default:
			return false
		}
	}
	return picture
}

// putReaction serves PUT /messages/{id}/reactions/{emoji}.
func (a *API) putReaction(w http.ResponseWriter, r *http.Request) {
	a.setReaction(w, r, true)
}

// deleteReaction serves DELETE /messages/{id}/reactions/{emoji}.
func (a *API) deleteReaction(w http.ResponseWriter, r *http.Request) {
	a.setReaction(w, r, false)
}

func (a *API) setReaction(w http.ResponseWriter, r *http.Request, add bool) {
	session := sessionFrom(r.Context())
	messageID := r.PathValue("id")
	emoji := r.PathValue("emoji")

	if !a.reactLimit.Allow(session.UserID) {
		writeError(w, http.StatusTooManyRequests, "slow down")
		return
	}
	if !validEmoji(emoji) {
		writeError(w, http.StatusBadRequest, "a reaction must be a single emoji")
		return
	}

	var channelID string
	var deleted bool
	err := a.pool.QueryRow(r.Context(),
		`SELECT channel_id, deleted FROM messages WHERE id = $1`, messageID,
	).Scan(&channelID, &deleted)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "message not found")
		return
	case err != nil:
		slog.Error("loading message for reaction", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change the reaction")
		return
	}

	// Someone who cannot view the channel gets the same answer as for a
	// message that does not exist.
	p, err := a.channelPermsFor(r.Context(), session, channelID)
	switch {
	case errors.Is(err, errChannelNotFound):
		writeError(w, http.StatusNotFound, "message not found")
		return
	case err != nil:
		slog.Error("checking channel access", "err", err, "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not change the reaction")
		return
	case !p.CanPost:
		writeError(w, http.StatusForbidden, "you do not have permission to react in this channel")
		return
	}
	if deleted && add {
		writeError(w, http.StatusConflict, "the message was deleted")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting reaction", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change the reaction")
		return
	}
	defer tx.Rollback(r.Context())

	changed := false
	if add {
		// Lock the message so two new emoji arriving at once cannot both
		// slip under the limit, and so a deletion in between wins.
		err := tx.QueryRow(r.Context(),
			`SELECT deleted FROM messages WHERE id = $1 FOR UPDATE`, messageID,
		).Scan(&deleted)
		if err == nil && deleted {
			writeError(w, http.StatusConflict, "the message was deleted")
			return
		}
		var kinds int
		var present bool
		if err == nil {
			err = tx.QueryRow(r.Context(),
				`SELECT count(DISTINCT emoji), COALESCE(bool_or(emoji = $2), false)
				   FROM message_reactions WHERE message_id = $1`,
				messageID, emoji,
			).Scan(&kinds, &present)
		}
		if err == nil && !present && kinds >= maxReactionKinds {
			writeError(w, http.StatusConflict, "this message has as many different reactions as it can take")
			return
		}
		if err == nil {
			var tag pgconn.CommandTag
			tag, err = tx.Exec(r.Context(),
				`INSERT INTO message_reactions (message_id, user_id, emoji)
				 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				messageID, session.UserID, emoji,
			)
			changed = err == nil && tag.RowsAffected() == 1
		}
		if err != nil {
			slog.Error("adding reaction", "err", err)
			writeError(w, http.StatusInternalServerError, "could not change the reaction")
			return
		}
	} else {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM message_reactions
			  WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
			messageID, session.UserID, emoji,
		)
		if err != nil {
			slog.Error("removing reaction", "err", err)
			writeError(w, http.StatusInternalServerError, "could not change the reaction")
			return
		}
		changed = tag.RowsAffected() == 1
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing reaction", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change the reaction")
		return
	}

	if changed {
		a.emitChannel(channelID, reactionEvent{
			Type:      "reaction",
			ChannelID: channelID,
			MessageID: messageID,
			Emoji:     emoji,
			UserID:    session.UserID,
			Username:  session.Username,
			Added:     add,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}
