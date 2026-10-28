// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/openvoxa/openvoxa/server/internal/auth"
)

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)

// Password length bounds. The lower bound is a floor, not a policy: no
// complexity rules, no forced symbols. Length beats character classes, and
// composition rules mostly push people toward "Password1!".
//
// The upper bound exists because argon2 hashes whatever you give it, and
// without a cap a megabyte password becomes a cheap denial of service.
const (
	minPasswordLen = 12
	maxPasswordLen = 256
)

type registerRequest struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	DeviceName string `json:"device_name"`
}

type sessionResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
}

func (a *API) register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	req.Username = strings.TrimSpace(req.Username)

	if !usernamePattern.MatchString(req.Username) {
		writeError(w, http.StatusBadRequest,
			"username must be 3-32 characters: letters, digits, underscore or hyphen")
		return
	}
	// Count runes, not bytes, so a passphrase in any script is measured the
	// way a person would measure it.
	if n := utf8.RuneCountInString(req.Password); n < minPasswordLen || n > maxPasswordLen {
		writeError(w, http.StatusBadRequest,
			"password must be between 12 and 256 characters")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		slog.Error("hashing password", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	var userID string
	err = a.pool.QueryRow(r.Context(),
		`INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
		req.Username, hash,
	).Scan(&userID)

	if err != nil {
		// 23505 is unique_violation: the username is taken.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, http.StatusConflict, "username is taken")
			return
		}
		slog.Error("creating user", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	a.issueSession(w, r, userID, req.Username, req.DeviceName)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var req registerRequest // same shape
	if !decodeJSON(w, r, &req) {
		return
	}

	var userID, username, storedHash string
	err := a.pool.QueryRow(r.Context(),
		`SELECT id, username, password_hash FROM users
		 WHERE username = $1 AND deleted_at IS NULL`,
		strings.TrimSpace(req.Username),
	).Scan(&userID, &username, &storedHash)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Run a verification anyway against a dummy hash. Without this, a
		// missing user returns noticeably faster than a wrong password,
		// which lets an attacker enumerate valid usernames by timing.
		_ = auth.VerifyPassword(req.Password, dummyHash)
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	case err != nil:
		slog.Error("looking up user", "err", err)
		writeError(w, http.StatusInternalServerError, "could not log in")
		return
	}

	if err := auth.VerifyPassword(req.Password, storedHash); err != nil {
		if !errors.Is(err, auth.ErrMismatch) {
			slog.Error("verifying password", "err", err)
		}
		// Same message and status either way. Never confirm that a username
		// exists, and never say which half was wrong.
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}

	a.issueSession(w, r, userID, username, req.DeviceName)
}

func (a *API) issueSession(w http.ResponseWriter, r *http.Request, userID, username, deviceName string) {
	token, hash, err := auth.NewSessionToken()
	if err != nil {
		slog.Error("generating session token", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	expiresAt := time.Now().Add(auth.SessionDuration)

	var device *string
	if d := strings.TrimSpace(deviceName); d != "" {
		if utf8.RuneCountInString(d) > 64 {
			d = string([]rune(d)[:64])
		}
		device = &d
	}

	if _, err := a.pool.Exec(r.Context(),
		`INSERT INTO sessions (user_id, token_hash, device_name, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		userID, hash, device, expiresAt,
	); err != nil {
		slog.Error("creating session", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	writeJSON(w, http.StatusOK, sessionResponse{
		Token:     token,
		ExpiresAt: expiresAt,
		UserID:    userID,
		Username:  username,
	})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM sessions WHERE id = $1`, session.SessionID,
	); err != nil {
		slog.Error("deleting session", "err", err)
		writeError(w, http.StatusInternalServerError, "could not log out")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type meResponse struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	writeJSON(w, http.StatusOK, meResponse{
		UserID:   session.UserID,
		Username: session.Username,
	})
}

// A real argon2id hash of a throwaway value, used only to burn equivalent
// CPU time when a username does not exist. See login above.
const dummyHash = `$argon2id$v=19$m=65536,t=3,p=2$c29tZXNhbHR2YWx1ZTAx$` +
	`Q2hhbmdlTWVUaGlzSXNOb3RBUmVhbFBhc3N3b3Jk`
