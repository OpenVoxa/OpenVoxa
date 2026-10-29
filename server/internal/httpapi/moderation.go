// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

const maxReasonRunes = 500

// deleteMessage removes a single message's content.
//
// Authors may delete their own; moderators may delete anyone's. The row
// survives as a tombstone so the conversation around it keeps its shape,
// and attachments are dropped so the blob collector reclaims the bytes.
// Deleting a message with an image in it has to take the image too,
// otherwise the deletion is cosmetic.
func (a *API) deleteMessage(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	messageID := r.PathValue("id")

	role, err := perm.Parse(session.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", session.Role)
		writeError(w, http.StatusInternalServerError, "could not delete the message")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting message deletion", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete the message")
		return
	}
	defer tx.Rollback(r.Context())

	var authorID *string
	var channelID string
	var deleted bool

	err = tx.QueryRow(r.Context(),
		`SELECT author_id, channel_id, deleted FROM messages WHERE id = $1 FOR UPDATE`,
		messageID,
	).Scan(&authorID, &channelID, &deleted)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "message not found")
		return
	case err != nil:
		slog.Error("loading message for deletion", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete the message")
		return
	}

	isAuthor := authorID != nil && *authorID == session.UserID
	isModerator := perm.AtLeast(role, perm.Moderator)

	if !isAuthor && !isModerator {
		writeError(w, http.StatusForbidden, "you can only delete your own messages")
		return
	}

	if deleted {
		// Already a tombstone. Treat as success rather than an error: the
		// caller wanted it gone and it is gone.
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE messages SET body = ''::bytea, deleted = true WHERE id = $1`,
		messageID,
	); err != nil {
		slog.Error("tombstoning message", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete the message")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`DELETE FROM attachments WHERE message_id = $1`, messageID,
	); err != nil {
		slog.Error("removing attachments", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete the message")
		return
	}

	if isModerator && !isAuthor {
		if err := logModeration(r.Context(), tx, session.UserID,
			"delete_message", messageID, ""); err != nil {
			slog.Error("recording moderation action", "err", err)
			writeError(w, http.StatusInternalServerError, "could not delete the message")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing message deletion", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete the message")
		return
	}

	a.NotifyMessageDeleted(channelID, messageID)
	w.WriteHeader(http.StatusNoContent)
}

type reportRequest struct {
	Reason string `json:"reason"`
	Body   string `json:"body"`
}

// reportMessage files a report against a message.
//
// The reporter's client supplies what it believes the message said. That
// claim is never trusted: in a plaintext channel the server compares it
// against its own stored copy, and once channels are encrypted it will
// verify the author's signature over the claimed bytes instead.
//
// Without that check, anyone could edit a message before reporting it and
// have a moderator act on words the accused never wrote.
func (a *API) reportMessage(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	messageID := r.PathValue("id")

	var req reportRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if utf8.RuneCountInString(req.Reason) > maxReasonRunes {
		writeError(w, http.StatusBadRequest, "reason is too long")
		return
	}

	var authorID *string
	var channelID string
	var storedBody []byte
	var encrypted bool

	err := a.pool.QueryRow(r.Context(),
		`SELECT m.author_id, m.channel_id, m.body, c.encrypted
		   FROM messages m
		   JOIN channels c ON c.id = m.channel_id
		  WHERE m.id = $1 AND m.deleted = false`,
		messageID,
	).Scan(&authorID, &channelID, &storedBody, &encrypted)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "message not found")
		return
	case err != nil:
		slog.Error("loading message for report", "err", err)
		writeError(w, http.StatusInternalServerError, "could not file the report")
		return
	}

	if authorID != nil && *authorID == session.UserID {
		writeError(w, http.StatusBadRequest, "you cannot report your own message")
		return
	}

	// Verification. Plaintext channels compare against the stored copy.
	//
	// Encrypted channels will verify an MLS signature over the claimed
	// bytes; until that exists, verified stays NULL, which a moderator
	// reads as "could not be checked" rather than "checked and passed".
	var verified *bool
	if !encrypted {
		match := string(storedBody) == req.Body
		verified = &match

		if !match {
			// A mismatch means the reporter altered the message before
			// reporting it. Recorded rather than silently dropped: filing
			// a provably false report is itself actionable.
			if _, err := a.pool.Exec(r.Context(),
				`INSERT INTO reports
				     (message_id, channel_id, reporter_id, accused_id,
				      reason, claimed_body, verified, status)
				 VALUES ($1, $2, $3, $4, $5, $6, false, 'rejected')
				 ON CONFLICT DO NOTHING`,
				messageID, channelID, session.UserID, authorID,
				req.Reason, req.Body,
			); err != nil {
				slog.Error("recording rejected report", "err", err)
			}

			slog.Warn("report rejected: claimed body does not match stored message",
				"reporter_id", session.UserID, "message_id", messageID)

			writeError(w, http.StatusBadRequest,
				"the reported text does not match the message on record")
			return
		}
	}

	var reportID string
	err = a.pool.QueryRow(r.Context(),
		`INSERT INTO reports
		     (message_id, channel_id, reporter_id, accused_id,
		      reason, claimed_body, verified)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		messageID, channelID, session.UserID, authorID,
		req.Reason, req.Body, verified,
	).Scan(&reportID)

	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "you have already reported this message")
			return
		}
		slog.Error("filing report", "err", err)
		writeError(w, http.StatusInternalServerError, "could not file the report")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"id": reportID})
}

type reportSummary struct {
	ID          string    `json:"id"`
	MessageID   *string   `json:"message_id"`
	ChannelID   *string   `json:"channel_id"`
	Reporter    string    `json:"reporter"`
	Accused     string    `json:"accused"`
	AccusedID   *string   `json:"accused_id"`
	Reason      string    `json:"reason"`
	ClaimedBody string    `json:"claimed_body"`
	Verified    *bool     `json:"verified"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

// listReports returns the moderation queue, open reports first.
func (a *API) listReports(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "open"
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT rp.id, rp.message_id, rp.channel_id,
		        COALESCE(ru.username, '[deleted]'),
		        COALESCE(au.username, '[deleted]'),
		        rp.accused_id, rp.reason, rp.claimed_body,
		        rp.verified, rp.status, rp.created_at
		   FROM reports rp
		   LEFT JOIN users ru ON ru.id = rp.reporter_id
		   LEFT JOIN users au ON au.id = rp.accused_id
		  WHERE rp.status = $1
		  ORDER BY rp.created_at DESC
		  LIMIT 100`, status)
	if err != nil {
		slog.Error("listing reports", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list reports")
		return
	}
	defer rows.Close()

	out := make([]reportSummary, 0)
	for rows.Next() {
		var rs reportSummary
		if err := rows.Scan(&rs.ID, &rs.MessageID, &rs.ChannelID,
			&rs.Reporter, &rs.Accused, &rs.AccusedID, &rs.Reason,
			&rs.ClaimedBody, &rs.Verified, &rs.Status, &rs.CreatedAt); err != nil {
			slog.Error("scanning report", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list reports")
			return
		}
		out = append(out, rs)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating reports", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list reports")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

type resolveRequest struct {
	// dismiss or action. Deleting the message or banning the author are
	// separate calls, so a moderator decides each one explicitly rather
	// than triggering several consequences from one button.
	Resolution string `json:"resolution"`
}

func (a *API) resolveReport(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	var req resolveRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	status := ""
	switch req.Resolution {
	case "dismiss":
		status = "dismissed"
	case "action":
		status = "actioned"
	default:
		writeError(w, http.StatusBadRequest, "resolution must be dismiss or action")
		return
	}

	tag, err := a.pool.Exec(r.Context(),
		`UPDATE reports
		    SET status = $1, resolved_by = $2, resolved_at = now()
		  WHERE id = $3 AND status = 'open'`,
		status, session.UserID, r.PathValue("id"))
	if err != nil {
		slog.Error("resolving report", "err", err)
		writeError(w, http.StatusInternalServerError, "could not resolve the report")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "report not found or already resolved")
		return
	}

	if _, err := a.pool.Exec(r.Context(),
		`INSERT INTO moderation_log (actor_id, action, subject_id, detail)
		 VALUES ($1, 'resolve_report', $2, $3)`,
		session.UserID, r.PathValue("id"), status,
	); err != nil {
		slog.Error("recording moderation action", "err", err)
	}

	w.WriteHeader(http.StatusNoContent)
}

type banRequest struct {
	Reason string `json:"reason"`
	// Postgres interval syntax. Empty means permanent.
	Duration string `json:"duration"`
}

// banUser locks an account and ends its sessions.
//
// The account is not deleted. Deletion is the user's own right, and using
// it as a punishment would destroy both the evidence a moderator may need
// and content other people are still reading.
func (a *API) banUser(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")

	var req banRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if utf8.RuneCountInString(req.Reason) > maxReasonRunes {
		writeError(w, http.StatusBadRequest, "reason is too long")
		return
	}

	if subjectID == actor.UserID {
		writeError(w, http.StatusForbidden, "you cannot ban yourself")
		return
	}

	actorRole, err := perm.Parse(actor.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", actor.Role)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting ban", "err", err)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}
	defer tx.Rollback(r.Context())

	var subjectRoleName string
	err = tx.QueryRow(r.Context(),
		`SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
		subjectID,
	).Scan(&subjectRoleName)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "user not found")
		return
	case err != nil:
		slog.Error("loading subject for ban", "err", err)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}

	subjectRole, err := perm.Parse(subjectRoleName)
	if err != nil {
		slog.Error("stored role is unknown", "role", subjectRoleName)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}

	// Same rank rule as role changes: moderators cannot ban each other,
	// so one compromised moderator account cannot clear the staff list.
	if !perm.Outranks(actorRole, subjectRole) {
		writeError(w, http.StatusForbidden,
			"you cannot ban someone at or above your own rank")
		return
	}

	// The unique index only covers permanent bans, since an index
	// predicate cannot reference now(). Temporary overlaps are caught
	// here, inside the same transaction that holds a lock on the user row.
	var active bool
	if err := tx.QueryRow(r.Context(),
		`SELECT EXISTS (
		     SELECT 1 FROM bans
		      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())
		 )`, subjectID).Scan(&active); err != nil {
		slog.Error("checking existing ban", "err", err)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}
	if active {
		writeError(w, http.StatusConflict, "that account is already banned")
		return
	}

	var expires *time.Time
	if req.Duration != "" {
		var t time.Time
		if err := tx.QueryRow(r.Context(),
			`SELECT now() + $1::interval`, req.Duration).Scan(&t); err != nil {
			if isInvalidInput(err) {
				writeError(w, http.StatusBadRequest,
					`duration must be like "7 days" or "12 hours", or empty for permanent`)
				return
			}
			slog.Error("parsing ban duration", "err", err)
			writeError(w, http.StatusInternalServerError, "could not ban the user")
			return
		}
		expires = &t
	}

	if _, err := tx.Exec(r.Context(),
		`INSERT INTO bans (user_id, actor_id, reason, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		subjectID, actor.UserID, req.Reason, expires,
	); err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "that account is already banned")
			return
		}
		slog.Error("recording ban", "err", err)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}

	// End every session immediately. A ban that waits for a token to
	// expire is not a ban.
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM sessions WHERE user_id = $1`, subjectID,
	); err != nil {
		slog.Error("revoking sessions", "err", err)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}

	if err := logModeration(r.Context(), tx, actor.UserID,
		"ban", subjectID, req.Reason); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing ban", "err", err)
		writeError(w, http.StatusInternalServerError, "could not ban the user")
		return
	}

	slog.Info("user banned", "actor_id", actor.UserID,
		"subject_id", subjectID, "permanent", expires == nil)

	w.WriteHeader(http.StatusNoContent)
}

func (a *API) unbanUser(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")

	tag, err := a.pool.Exec(r.Context(),
		`DELETE FROM bans
		  WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
		subjectID)
	if err != nil {
		slog.Error("removing ban", "err", err)
		writeError(w, http.StatusInternalServerError, "could not unban the user")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "that account is not banned")
		return
	}

	if _, err := a.pool.Exec(r.Context(),
		`INSERT INTO moderation_log (actor_id, action, subject_id)
		 VALUES ($1, 'unban', $2)`, actor.UserID, subjectID,
	); err != nil {
		slog.Error("recording moderation action", "err", err)
	}

	slog.Info("user unbanned", "actor_id", actor.UserID, "subject_id", subjectID)
	w.WriteHeader(http.StatusNoContent)
}

type banSummary struct {
	Username  string     `json:"username"`
	UserID    string     `json:"user_id"`
	Actor     string     `json:"actor"`
	Reason    string     `json:"reason"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at"`
}

func (a *API) listBans(w http.ResponseWriter, r *http.Request) {
	rows, err := a.pool.Query(r.Context(),
		`SELECT COALESCE(bu.username, '[deleted]'), b.user_id,
		        COALESCE(au.username, '[deleted]'),
		        b.reason, b.created_at, b.expires_at
		   FROM bans b
		   LEFT JOIN users bu ON bu.id = b.user_id
		   LEFT JOIN users au ON au.id = b.actor_id
		  WHERE b.expires_at IS NULL OR b.expires_at > now()
		  ORDER BY b.created_at DESC`)
	if err != nil {
		slog.Error("listing bans", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list bans")
		return
	}
	defer rows.Close()

	out := make([]banSummary, 0)
	for rows.Next() {
		var b banSummary
		if err := rows.Scan(&b.Username, &b.UserID, &b.Actor,
			&b.Reason, &b.CreatedAt, &b.ExpiresAt); err != nil {
			slog.Error("scanning ban", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list bans")
			return
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating bans", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list bans")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

// logModeration records an action inside the caller's transaction, so the
// log entry and the action it describes commit or roll back together.
func logModeration(ctx context.Context, tx pgx.Tx, actorID, action, subjectID, detail string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO moderation_log (actor_id, action, subject_id, detail)
		 VALUES ($1, $2, $3, $4)`,
		actorID, action, subjectID, detail)
	return err
}
