// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/auth"
)

// Password rules (decided with Ryan 2026-11-01): 12 to 256 characters,
// with at least one upper-case letter, one lower-case letter, one digit
// and one symbol. Applied when a password is set (registration, change),
// never at login, so older accounts can still sign in and are asked to
// meet the rules only when they next change it.
//
// Length counts runes, not bytes, so a passphrase in any script is
// measured the way a person would measure it. A "symbol" is anything
// that is not a letter, digit or whitespace. Letters without case (most
// non-Latin scripts) count toward length only.
//
// client-web/src/password.ts mirrors this for live feedback; the server
// is the one that decides.

// passwordProblem returns a message fit to show the user, or "" when the
// password meets the rules.
func passwordProblem(p string) string {
	if n := utf8.RuneCountInString(p); n < minPasswordLen || n > maxPasswordLen {
		return "password must be between 12 and 256 characters"
	}
	var upper, lower, digit, symbol bool
	for _, r := range p {
		switch {
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsLower(r):
			lower = true
		case unicode.IsDigit(r):
			digit = true
		case unicode.IsLetter(r), unicode.IsSpace(r):
		default:
			symbol = true
		}
	}
	var missing []string
	if !upper {
		missing = append(missing, "an upper-case letter")
	}
	if !lower {
		missing = append(missing, "a lower-case letter")
	}
	if !digit {
		missing = append(missing, "a number")
	}
	if !symbol {
		missing = append(missing, "a symbol")
	}
	if len(missing) == 0 {
		return ""
	}
	return "password needs at least " + joinAnd(missing)
}

// joinAnd writes "a, b and c".
func joinAnd(items []string) string {
	if len(items) == 1 {
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
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

	if msg := passwordProblem(req.NewPassword); msg != "" {
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
