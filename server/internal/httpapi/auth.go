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
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)

// isUniqueViolation reports whether err is Postgres error 23505.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

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
	Role      string    `json:"role"`
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

	// The first account to register becomes the administrator, because
	// otherwise nobody can grant that role to anyone.
	//
	// The advisory lock makes this safe under concurrent registration: two
	// simultaneous first registrations would otherwise both see an empty
	// users table and both become administrator. The lock is transaction
	// scoped and released on commit or rollback.
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting registration", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(4242)`); err != nil {
		slog.Error("taking registration lock", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	var anyUsers bool
	if err := tx.QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM users)`).Scan(&anyUsers); err != nil {
		slog.Error("checking for existing users", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	role := perm.User
	if !anyUsers {
		role = perm.Administrator
	}

	var userID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO users (username, password_hash, role)
		 VALUES ($1, $2, $3) RETURNING id`,
		req.Username, hash, role.String(),
	).Scan(&userID)

	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "username is taken")
			return
		}
		slog.Error("creating user", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing registration", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	if role == perm.Administrator {
		slog.Info("first account created as administrator", "user_id", userID)
	}

	a.issueSession(w, r, userID, req.Username, role.String(), req.DeviceName)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var req registerRequest // same shape
	if !decodeJSON(w, r, &req) {
		return
	}

	// Keyed on the submitted username, consumed on failure only. Applied
	// whether or not the account exists, so a 429 does not reveal which
	// usernames are real.
	userKey := strings.ToLower(strings.TrimSpace(req.Username))
	if !a.authUser.Allow(userKey) {
		writeTooManyRequests(w, a.authUser.RetryAfter(userKey))
		return
	}

	var userID, username, storedHash, role string
	err := a.pool.QueryRow(r.Context(),
		`SELECT id, username, password_hash, role FROM users
		 WHERE username = $1 AND deleted_at IS NULL`,
		strings.TrimSpace(req.Username),
	).Scan(&userID, &username, &storedHash, &role)

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

	// Correct password clears the per-account budget, so someone who
	// mistyped a few times is not left throttled afterwards. This is also
	// what stops the account limiter becoming a lockout weapon.
	a.authUser.Reset(userKey)

	a.issueSession(w, r, userID, username, role, req.DeviceName)
}

func (a *API) issueSession(w http.ResponseWriter, r *http.Request, userID, username, role, deviceName string) {
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
		Role:      role,
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
	Role     string `json:"role"`
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	writeJSON(w, http.StatusOK, meResponse{
		UserID:   session.UserID,
		Username: session.Username,
		Role:     session.Role,
	})
}

// A real argon2id hash of a throwaway value, used only to burn equivalent
// CPU time when a username does not exist. See login above.
const dummyHash = `$argon2id$v=19$m=65536,t=3,p=2$c29tZXNhbHR2YWx1ZTAx$` +
	`Q2hhbmdlTWVUaGlzSXNOb3RBUmVhbFBhc3N3b3Jk`
