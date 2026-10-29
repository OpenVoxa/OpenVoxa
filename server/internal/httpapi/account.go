// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/auth"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

type deleteAccountRequest struct {
	Password string `json:"password"`
}

// deleteOwnAccount destroys the caller's account and everything they wrote.
//
// There is no grace period, no soft delete and no recovery. That is the
// promise the project makes, and a thirty-day undo window would quietly
// break it.
//
// The password is required even though the caller already holds a valid
// session. A borrowed laptop should not be enough to erase someone's
// account.
func (a *API) deleteOwnAccount(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	var req deleteAccountRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	var storedHash string
	err := a.pool.QueryRow(r.Context(),
		`SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
		session.UserID,
	).Scan(&storedHash)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusUnauthorized, "account not found")
		return
	case err != nil:
		slog.Error("loading account for deletion", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete account")
		return
	}

	if err := auth.VerifyPassword(req.Password, storedHash); err != nil {
		writeError(w, http.StatusUnauthorized, "password is incorrect")
		return
	}

	if err := a.purgeUser(r.Context(), session.UserID); err != nil {
		slog.Error("deleting account", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete account")
		return
	}

	slog.Info("account deleted", "user_id", session.UserID, "by", "self")
	a.hub.DisconnectUser(session.UserID)
	a.NotifyUserPurged(session.UserID)
	w.WriteHeader(http.StatusNoContent)
}

// deleteUser removes someone else's account. Administrator only.
//
// Same destruction as self-deletion. The rank rules match role changes:
// you cannot delete yourself through this route, and you cannot delete
// someone at or above your own rank.
func (a *API) deleteUser(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")

	if subjectID == actor.UserID {
		writeError(w, http.StatusForbidden,
			"use the account deletion endpoint to delete your own account")
		return
	}

	actorRole, err := perm.Parse(actor.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", actor.Role)
		writeError(w, http.StatusInternalServerError, "could not delete account")
		return
	}

	var subjectRoleName string
	err = a.pool.QueryRow(r.Context(),
		`SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL`,
		subjectID,
	).Scan(&subjectRoleName)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "user not found")
		return
	case err != nil:
		slog.Error("loading subject for deletion", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete account")
		return
	}

	subjectRole, err := perm.Parse(subjectRoleName)
	if err != nil {
		slog.Error("stored role is unknown", "role", subjectRoleName)
		writeError(w, http.StatusInternalServerError, "could not delete account")
		return
	}

	if !perm.Outranks(actorRole, subjectRole) {
		writeError(w, http.StatusForbidden,
			"you cannot delete someone at or above your own rank")
		return
	}

	if err := a.purgeUser(r.Context(), subjectID); err != nil {
		slog.Error("deleting account", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete account")
		return
	}

	slog.Info("account deleted", "user_id", subjectID, "by", actor.UserID)
	a.hub.DisconnectUser(subjectID)
	a.NotifyUserPurged(subjectID)
	w.WriteHeader(http.StatusNoContent)
}

// purgeUser destroys an account and its content in one transaction.
//
// Message rows survive as tombstones. Deleting them outright would tear
// holes in conversations other people are still having: replies would
// point at nothing and counts would stop matching. The content is gone
// either way, which is what was actually promised.
//
// Once channels are encrypted this changes shape. Destroying the user's
// key material makes their ciphertext permanently unreadable without
// rewriting rows at all, and the tombstone flag is set the same way. The
// visible result is identical; only the mechanism differs.
func (a *API) purgeUser(ctx context.Context, userID string) error {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Empty the bodies rather than dropping the rows.
	if _, err := tx.Exec(ctx,
		`UPDATE messages SET body = ''::bytea, deleted = true WHERE author_id = $1`,
		userID,
	); err != nil {
		return err
	}

	// Deleting the user cascades to sessions, so every device is logged
	// out immediately, and sets author_id to NULL on the tombstones above.
	// The role_changes rows they were party to also lose their reference.
	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

type setRetentionRequest struct {
	// Postgres interval syntax: "30 days", "12 hours", "1 day".
	// Empty or absent means keep forever.
	Retention string `json:"retention"`
}

// setChannelRetention changes how long a channel keeps messages.
//
// The value is displayed to every member before they post, and the sweep
// job enforces it within fifteen minutes. Shortening a policy therefore
// deletes existing messages that now fall outside it, which is the point.
func (a *API) setChannelRetention(w http.ResponseWriter, r *http.Request) {
	var req setRetentionRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	var tag interface{ RowsAffected() int64 }
	var err error

	if req.Retention == "" {
		tag, err = a.pool.Exec(r.Context(),
			`UPDATE channels SET retention = NULL WHERE id = $1`, r.PathValue("id"))
	} else {
		// Cast in SQL so Postgres validates the interval syntax. An
		// invalid value is a client error, not a server one.
		tag, err = a.pool.Exec(r.Context(),
			`UPDATE channels SET retention = $1::interval WHERE id = $2`,
			req.Retention, r.PathValue("id"))
	}

	if err != nil {
		if isInvalidInput(err) {
			writeError(w, http.StatusBadRequest,
				`retention must be a duration like "30 days" or "12 hours", or empty for forever`)
			return
		}
		slog.Error("setting retention", "err", err)
		writeError(w, http.StatusInternalServerError, "could not update channel")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}

	slog.Info("channel retention changed",
		"channel_id", r.PathValue("id"), "retention", req.Retention)

	// Clients show the policy in the channel label, so a change has to
	// reach them promptly or the displayed promise goes stale.
	a.NotifyChannelChanged(r.PathValue("id"))

	w.WriteHeader(http.StatusNoContent)
}
