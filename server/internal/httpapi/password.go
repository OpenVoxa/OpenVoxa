// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/auth"
	"github.com/openvoxa/openvoxa/server/internal/password"
)

// The password rules live in internal/password; this file holds the
// change-password endpoint and the as-you-type strength check.

type passwordCheckRequest struct {
	Password string `json:"password"`
	Username string `json:"username"`
}

type passwordCheckResponse struct {
	// Problem is what registering or changing to this password would be
	// refused with, or "" when it would be accepted.
	Problem string `json:"problem"`
	// Score is zxcvbn's 0-4; MinScore is the lowest accepted.
	Score    int  `json:"score"`
	MinScore int  `json:"min_score"`
	Common   bool `json:"common"`
	// Warning and Suggestions are the hint under the strength meter.
	Warning     string   `json:"warning"`
	Suggestions []string `json:"suggestions"`
}

// checkPassword scores a password the user is typing, for the strength
// meter on sign-up and password change (decisions.md, "Password rules").
// Nothing is stored or logged. Open to anyone, since sign-up has no
// session yet; the scoring is cheap (under 15 ms even for 256
// characters), and pwCheckLimit keeps it that way per address.
func (a *API) checkPassword(w http.ResponseWriter, r *http.Request) {
	ip := a.clientIP(r)
	if !a.pwCheckLimit.Allow(ip) {
		writeTooManyRequests(w, a.pwCheckLimit.RetryAfter(ip))
		return
	}
	var req passwordCheckRequest
	if !decodeJSONLimit(w, r, &req, 4096) {
		return
	}
	c := password.Evaluate(req.Password, strings.TrimSpace(req.Username))
	resp := passwordCheckResponse{
		Problem:     c.Problem,
		Score:       c.Strength.Score,
		MinScore:    password.MinScore,
		Common:      c.Strength.Common,
		Warning:     c.Strength.Warning,
		Suggestions: c.Strength.Suggestions,
	}
	if resp.Suggestions == nil {
		resp.Suggestions = []string{}
	}
	writeJSON(w, http.StatusOK, resp)
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// changeOwnPassword sets a new password for the caller.
//
// The current password is required even with a valid session, as for
// account deletion: a borrowed laptop should not be enough. Every other
// session is signed out and every open socket closed, because a password
// change is what someone does when they think the account is in someone
// else's hands. The caller's own session stays; its sockets reconnect.
func (a *API) changeOwnPassword(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	var req changePasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	// Same per-account budget as login, so this cannot be used to guess
	// the current password faster than signing in could.
	userKey := strings.ToLower(session.Username)
	if !a.authUser.Allow(userKey) {
		writeTooManyRequests(w, a.authUser.RetryAfter(userKey))
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
		slog.Error("loading account for password change", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change password")
		return
	}

	if err := auth.VerifyPassword(req.CurrentPassword, storedHash); err != nil {
		if !errors.Is(err, auth.ErrMismatch) {
			slog.Error("verifying password", "err", err)
		}
		writeError(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}
	a.authUser.Reset(userKey)

	if msg := password.Problem(req.NewPassword, session.Username); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if req.NewPassword == req.CurrentPassword {
		writeError(w, http.StatusBadRequest, "new password must be different from the current one")
		return
	}

	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		slog.Error("hashing password", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change password")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("changing password", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change password")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(),
		`UPDATE users SET password_hash = $1 WHERE id = $2`, hash, session.UserID); err != nil {
		slog.Error("storing password", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change password")
		return
	}
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, session.UserID, session.SessionID)
	if err != nil {
		slog.Error("signing out other sessions", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change password")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing password change", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change password")
		return
	}

	slog.Info("password changed", "user_id", session.UserID,
		"other_sessions_ended", tag.RowsAffected())
	a.hub.DisconnectUser(session.UserID)
	writeJSON(w, http.StatusOK, map[string]int64{"other_sessions_ended": tag.RowsAffected()})
}
