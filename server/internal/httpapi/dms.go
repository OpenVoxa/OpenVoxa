// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Direct messages and blocks (decisions.md Feature decisions, "Direct
// messages"; migration 0036).
//
// A DM is an ordinary encrypted channel of kind 'dm' with exactly two
// people, so messages, attachments, reactions, mentions, reports and the
// MLS endpoints all work on it unchanged. What is special lives in
// access.go (only the two may view it; administrators get no way in;
// posting needs both still able to DM and no block) and here: the list,
// get-or-create, and blocks. listChannels never shows DMs.

// dmChangedEvent tells an account its DM list or a DM's read-only state
// may have moved, so it refetches GET /dms. Carries nothing.
type dmChangedEvent struct {
	Type string `json:"type"`
}

func (a *API) notifyDMsChanged(userIDs ...string) {
	users := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		users[id] = true
	}
	a.emitUsers(users, dmChangedEvent{Type: "dms_changed"})
}

type dmUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Deleted  bool   `json:"deleted,omitempty"`
}

type dmResponse struct {
	ChannelID string `json:"channel_id"`
	// The other person.
	User    dmUser `json:"user"`
	CanPost bool   `json:"can_post"`

	// Why it is read-only, when it is, from the caller's side:
	//   you_blocked  the caller blocks them (Unblock lifts it)
	//   you_cannot   the caller may not send DMs
	//   deleted      their account was deleted
	//   unavailable  anything else on their side: no switch, banned, or
	//                they block the caller. Deliberately one reason, so a
	//                block stays silent.
	ReadOnlyReason string `json:"read_only_reason,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	// Newest message, deleted ones included (as for channels); and the
	// newest one from the other person, which alerts like a mention.
	LastMessageAt  *time.Time `json:"last_message_at,omitempty"`
	LastIncomingAt *time.Time `json:"last_incoming_at,omitempty"`
}

// dmSelectSQL selects one dmResponse per DM of the caller ($1) as row
// fields; the FROM gives aliases c (channel), dc (pair), u (caller) and o
// (the other person). Callers add WHERE conditions after it.
const dmSelectSQL = `
	SELECT c.id::text, o.id::text, o.username, o.deleted_at IS NOT NULL,
	       ` + canPostSQL + `,
	       EXISTS (SELECT 1 FROM user_blocks ub
	                WHERE ub.blocker_id = u.id AND ub.blocked_id = o.id),
	       EXISTS (SELECT 1 FROM users x WHERE x.id = u.id AND ` + mayDMSQL + `),
	       c.created_at,
	       (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id),
	       (SELECT max(m.created_at) FROM messages m
	         WHERE m.channel_id = c.id AND m.author_id = o.id)
	  FROM dm_channels dc
	  JOIN channels c ON c.id = dc.channel_id
	  JOIN users u ON u.id = $1
	  JOIN users o ON o.id = CASE WHEN dc.user_low = u.id
	                              THEN dc.user_high ELSE dc.user_low END
	 WHERE u.id IN (dc.user_low, dc.user_high)`

func scanDM(row pgx.Row) (dmResponse, error) {
	var d dmResponse
	var youBlocked, youMay bool
	err := row.Scan(&d.ChannelID, &d.User.ID, &d.User.Username, &d.User.Deleted,
		&d.CanPost, &youBlocked, &youMay, &d.CreatedAt, &d.LastMessageAt, &d.LastIncomingAt)
	if err != nil {
		return d, err
	}
	if d.User.Deleted {
		// A deleted account's name is a tombstone, as everywhere else.
		d.User.Username = ""
	}
	switch {
	case d.CanPost:
	case youBlocked:
		d.ReadOnlyReason = "you_blocked"
	case !youMay:
		d.ReadOnlyReason = "you_cannot"
	case d.User.Deleted:
		d.ReadOnlyReason = "deleted"
	default:
		d.ReadOnlyReason = "unavailable"
	}
	return d, nil
}

// listDMs serves GET /dms: the caller's DMs, newest activity first.
// One with someone the caller blocks is left out (they asked not to see
// it); the other side still sees it, read-only.
func (a *API) listDMs(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	rows, err := a.pool.Query(r.Context(),
		dmSelectSQL+`
		   AND NOT EXISTS (SELECT 1 FROM user_blocks ub
		                    WHERE ub.blocker_id = u.id AND ub.blocked_id = o.id)
		 ORDER BY COALESCE((SELECT max(m.created_at) FROM messages m
		                     WHERE m.channel_id = c.id), c.created_at) DESC`,
		session.UserID)
	if err != nil {
		slog.Error("listing direct messages", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list direct messages")
		return
	}
	defer rows.Close()

	out := make([]dmResponse, 0)
	for rows.Next() {
		d, err := scanDM(rows)
		if err != nil {
			slog.Error("scanning direct message", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list direct messages")
			return
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating direct messages", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list direct messages")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// dmWith loads the caller's DM with another account, or pgx.ErrNoRows.
func (a *API) dmWith(ctx context.Context, callerID, otherID string) (dmResponse, error) {
	return scanDM(a.pool.QueryRow(ctx, dmSelectSQL+` AND o.id::text = $2`, callerID, otherID))
}

type startDMRequest struct {
	UserID string `json:"user_id"`
}

// startDM serves POST /dms {user_id}: the caller's DM with that person,
// created if there is none yet (201) or the existing one (200), which is
// returned even when it is read-only, so its history can still be read.
//
// Creating one needs both people able to send DMs and no block either
// way. When the other person can't be messaged the answer is the same
// whatever the reason, so a block stays silent.
func (a *API) startDM(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	var req startDMRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.UserID = strings.ToLower(req.UserID)
	if !uuidPattern.MatchString(req.UserID) {
		writeError(w, http.StatusBadRequest, "user_id must be a user ID")
		return
	}
	if req.UserID == session.UserID {
		writeError(w, http.StatusBadRequest, "you cannot message yourself")
		return
	}

	d, err := a.dmWith(r.Context(), session.UserID, req.UserID)
	if err == nil {
		writeJSON(w, http.StatusOK, d)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		slog.Error("looking up direct message", "err", err)
		writeError(w, http.StatusInternalServerError, "could not open the conversation")
		return
	}

	// Who may start one. All three answers in one query, so the decision
	// is made on a single snapshot.
	var exists, youMay, theyMay, youBlocked, theyBlocked bool
	err = a.pool.QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM users WHERE id::text = $2 AND deleted_at IS NULL),
		        EXISTS (SELECT 1 FROM users x WHERE x.id = $1 AND `+mayDMSQL+`),
		        EXISTS (SELECT 1 FROM users x WHERE x.id::text = $2 AND `+mayDMSQL+`),
		        EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id::text = $2),
		        EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id::text = $2 AND blocked_id = $1)`,
		session.UserID, req.UserID,
	).Scan(&exists, &youMay, &theyMay, &youBlocked, &theyBlocked)
	if err != nil {
		slog.Error("checking direct message rights", "err", err)
		writeError(w, http.StatusInternalServerError, "could not open the conversation")
		return
	}
	switch {
	case !exists:
		writeError(w, http.StatusNotFound, "user not found")
		return
	case !youMay:
		writeError(w, http.StatusForbidden, "you cannot send direct messages")
		return
	case youBlocked:
		writeError(w, http.StatusForbidden, "you have blocked this person; unblock them first")
		return
	case !theyMay || theyBlocked:
		writeError(w, http.StatusForbidden, "this person cannot receive direct messages")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting direct message creation", "err", err)
		writeError(w, http.StatusInternalServerError, "could not open the conversation")
		return
	}
	defer tx.Rollback(r.Context())

	// The name is the ordered pair and unique, so two people starting a
	// DM with each other at once end up in the same one: the loser's
	// insert does nothing and it reads the winner's below.
	var channelID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO channels (name, kind, encrypted)
		 VALUES ('dm:' || LEAST($1::uuid, $2::uuid) || ':' || GREATEST($1::uuid, $2::uuid),
		         'dm', true)
		 ON CONFLICT (name) DO NOTHING
		 RETURNING id::text`,
		session.UserID, req.UserID).Scan(&channelID)
	created := err == nil
	if created {
		_, err = tx.Exec(r.Context(),
			`INSERT INTO dm_channels (channel_id, user_low, user_high)
			 VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))`,
			channelID, session.UserID, req.UserID)
		if err == nil {
			err = tx.Commit(r.Context())
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	if err != nil {
		slog.Error("creating direct message", "err", err)
		writeError(w, http.StatusInternalServerError, "could not open the conversation")
		return
	}

	d, err = a.dmWith(r.Context(), session.UserID, req.UserID)
	if err != nil {
		slog.Error("loading new direct message", "err", err)
		writeError(w, http.StatusInternalServerError, "could not open the conversation")
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
		slog.Info("direct message started", "channel_id", d.ChannelID)
		a.notifyDMsChanged(session.UserID, req.UserID)
	}
	writeJSON(w, status, d)
}

// dmCandidate is someone the caller could start a DM with.
type dmCandidate struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

// listDMCandidates serves GET /dm-candidates, for the New Message picker:
// every account that may receive DMs, except the caller and anyone the
// caller blocks. Empty when the caller may not send DMs. Someone who
// blocks the caller is still listed, so the list says nothing about who
// has blocked whom; starting a DM with them fails like any other refusal.
func (a *API) listDMCandidates(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	rows, err := a.pool.Query(r.Context(),
		`SELECT x.id::text, x.username FROM users x
		  WHERE x.id <> $1 AND `+mayDMSQL+`
		    AND EXISTS (SELECT 1 FROM users x WHERE x.id = $1 AND `+mayDMSQL+`)
		    AND NOT EXISTS (SELECT 1 FROM user_blocks ub
		                     WHERE ub.blocker_id = $1 AND ub.blocked_id = x.id)
		  ORDER BY lower(x.username)`,
		session.UserID)
	if err != nil {
		slog.Error("listing direct message candidates", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list people")
		return
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[dmCandidate])
	if err != nil {
		slog.Error("listing direct message candidates", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list people")
		return
	}
	if out == nil {
		out = []dmCandidate{}
	}
	writeJSON(w, http.StatusOK, out)
}

type blockResponse struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"created_at"`
}

// listBlocks serves GET /blocks: whom the caller blocks, for Settings.
func (a *API) listBlocks(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	rows, err := a.pool.Query(r.Context(),
		`SELECT u.id::text, u.username, ub.created_at
		   FROM user_blocks ub JOIN users u ON u.id = ub.blocked_id
		  WHERE ub.blocker_id = $1 AND u.deleted_at IS NULL
		  ORDER BY lower(u.username)`,
		session.UserID)
	if err != nil {
		slog.Error("listing blocks", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list blocked people")
		return
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[blockResponse])
	if err != nil {
		slog.Error("listing blocks", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list blocked people")
		return
	}
	if out == nil {
		out = []blockResponse{}
	}
	writeJSON(w, http.StatusOK, out)
}

// putBlock serves PUT /blocks/{id}. Blocking twice is fine. Both people
// get dms_changed (their DM, if any, turned read-only), which carries
// nothing, so the blocked person learns no more than the read-only box
// already shows them.
func (a *API) putBlock(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	target := strings.ToLower(r.PathValue("id"))
	if !uuidPattern.MatchString(target) {
		writeError(w, http.StatusBadRequest, "not a user ID")
		return
	}
	if target == session.UserID {
		writeError(w, http.StatusBadRequest, "you cannot block yourself")
		return
	}
	tag, err := a.pool.Exec(r.Context(),
		`INSERT INTO user_blocks (blocker_id, blocked_id)
		 SELECT $1, u.id FROM users u WHERE u.id::text = $2 AND u.deleted_at IS NULL
		 ON CONFLICT DO NOTHING`,
		session.UserID, target)
	if err != nil {
		slog.Error("blocking", "err", err)
		writeError(w, http.StatusInternalServerError, "could not block")
		return
	}
	if tag.RowsAffected() == 0 {
		// Either already blocked or no such account; tell them apart.
		var exists bool
		if err := a.pool.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM users WHERE id::text = $1 AND deleted_at IS NULL)`,
			target).Scan(&exists); err != nil || !exists {
			writeError(w, http.StatusNotFound, "user not found")
			return
		}
	} else {
		a.notifyDMsChanged(session.UserID, target)
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteBlock serves DELETE /blocks/{id}. Unblocking someone not blocked
// is fine.
func (a *API) deleteBlock(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	target := strings.ToLower(r.PathValue("id"))
	if !uuidPattern.MatchString(target) {
		writeError(w, http.StatusBadRequest, "not a user ID")
		return
	}
	tag, err := a.pool.Exec(r.Context(),
		`DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id::text = $2`,
		session.UserID, target)
	if err != nil {
		slog.Error("unblocking", "err", err)
		writeError(w, http.StatusInternalServerError, "could not unblock")
		return
	}
	if tag.RowsAffected() > 0 {
		a.notifyDMsChanged(session.UserID, target)
	}
	w.WriteHeader(http.StatusNoContent)
}
