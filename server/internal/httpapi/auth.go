// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
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
	"github.com/openvoxa/openvoxa/server/internal/password"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)

// isUniqueViolation reports whether err is Postgres error 23505.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// isInvalidInput reports whether err is Postgres class 22, which covers
// malformed values such as an uninterpretable interval string. Those are
// the client's fault, not the server's.
func isInvalidInput(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && len(pgErr.Code) >= 2 && pgErr.Code[:2] == "22"
}

type registerRequest struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	DeviceName string `json:"device_name"`
	// Only for the first account on an empty server (lastadmin.go).
	SetupCode string `json:"setup_code,omitempty"`
	// When the server's sign-up mode asks for it (signup.go).
	ServerPassword string `json:"server_password,omitempty"`
}

type sessionResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	accountPerms
	// The server requires two-factor for this account and it has none:
	// the client shows the setup screen first (twofactor.go).
	TwoFactorSetupRequired bool `json:"two_factor_setup_required"`
}

// accountPerms is what a client shows about its own permissions. Advisory:
// the server checks again on every request.
type accountPerms struct {
	// Permissions is every switch held, expanded: an administrator gets
	// the full list, so clients never have to know the implication.
	Permissions []string        `json:"permissions"`
	Rank        int             `json:"rank"`
	Groups      []userGroupName `json:"groups"`
}

func (a *API) loadAccountPerms(ctx context.Context, userID string) (accountPerms, error) {
	var out accountPerms
	var names []string
	err := a.pool.QueryRow(ctx,
		`SELECT `+userPermsSQL+`,
		        COALESCE((SELECT json_agg(json_build_object('id', g.id, 'name', g.name)
		                            ORDER BY g.position DESC, g.name)
		                    FROM user_perm_groups ug
		                    JOIN perm_groups g ON g.id = ug.group_id
		                   WHERE ug.user_id = u.id), '[]'::json)
		   FROM users u WHERE u.id = $1`,
		userID,
	).Scan(&names, &out.Rank, &out.Groups)
	out.Permissions = perm.NewSet(names).List()
	return out, err
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
	// Rules in password.go.
	if msg := password.Problem(req.Password, req.Username); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	// Once the server has accounts, the sign-up mode decides: open, server
	// password, closed. Before hashing, so wrong guesses cost no argon2
	// time. (The empty-server case is settled under the lock below.)
	var hasUsers bool
	if err := a.pool.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&hasUsers); err != nil {
		slog.Error("checking for existing users", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}
	if hasUsers && !a.signupAllowed(w, r, req.ServerPassword) {
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		slog.Error("hashing password", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	// The first account to register becomes the administrator, because
	// otherwise nobody can grant that permission to anyone.
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

	// An empty server is claimed with the setup code from the server
	// log, not by whoever happens to register first.
	if !anyUsers && !a.setupCodeMatches(req.SetupCode) {
		a.logSetupCode()
		writeError(w, http.StatusForbidden,
			"this server has no accounts yet: enter the setup code from the server log "+
				"to create the first (administrator) account")
		return
	}

	var userID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO users (username, password_hash)
		 VALUES ($1, $2) RETURNING id`,
		req.Username, hash,
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

	// New accounts join the auto-assign groups (Member, after the upgrade).
	// The very first account also joins every group carrying the
	// administrator switch.
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO user_perm_groups (user_id, group_id)
		 SELECT $1, id FROM perm_groups
		  WHERE auto_assign OR ($2 AND 'administrator' = ANY(permissions))`,
		userID, !anyUsers,
	); err != nil {
		slog.Error("assigning groups", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	// At most three new accounts per address an hour, counted only when
	// one is actually made (a taken username costs nothing).
	if anyUsers {
		if ip := a.clientIP(r); !a.signupIP.Allow(ip) {
			slog.Warn("sign-up refused: too many new accounts from this address", "ip", ip)
			writeTooManyRequests(w, a.signupIP.RetryAfter(ip))
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing registration", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	if !anyUsers {
		slog.Info("first account created as administrator", "user_id", userID)
	}

	a.issueSession(w, r, userID, req.Username, req.DeviceName)
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

	// Checked after the password, deliberately. Telling an unauthenticated
	// caller that an account is banned would confirm the account exists.
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

	var banReason string
	var banExpires *time.Time
	err = a.pool.QueryRow(r.Context(),
		`SELECT reason, expires_at FROM bans
		  WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
		userID,
	).Scan(&banReason, &banExpires)

	switch {
	case err == nil:
		msg := "this account is banned"
		if banReason != "" {
			msg += ": " + banReason
		}
		if banExpires != nil {
			msg += " (until " + banExpires.Format(time.RFC1123) + ")"
		}
		writeError(w, http.StatusForbidden, msg)
		return
	case !errors.Is(err, pgx.ErrNoRows):
		slog.Error("checking ban", "err", err)
		writeError(w, http.StatusInternalServerError, "could not log in")
		return
	}

	// Two-factor on: the password earns a ticket, the code a session
	// (twofactor.go, loginTwoFactor).
	var twoFactor bool
	if err := a.pool.QueryRow(r.Context(),
		`SELECT totp_enabled_at IS NOT NULL FROM users WHERE id = $1`, userID,
	).Scan(&twoFactor); err != nil {
		slog.Error("checking two-factor", "err", err)
		writeError(w, http.StatusInternalServerError, "could not log in")
		return
	}
	if twoFactor {
		ticket, err := a.pendingLogins.issue(userID, username, req.DeviceName)
		if err != nil {
			slog.Error("issuing two-factor ticket", "err", err)
			writeError(w, http.StatusInternalServerError, "could not log in")
			return
		}
		writeJSON(w, http.StatusOK, twoFactorChallenge{TwoFactorTicket: ticket})
		return
	}

	a.issueSession(w, r, userID, username, req.DeviceName)
}

// twoFactorChallenge answers a right password on an account with
// two-factor: send the code with this ticket to /auth/login/two-factor.
type twoFactorChallenge struct {
	TwoFactorTicket string `json:"two_factor_ticket"`
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

	perms, err := a.loadAccountPerms(r.Context(), userID)
	if err != nil {
		slog.Error("loading permissions", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	setup, err := a.twoFactorSetupNeeded(r.Context(), userID)
	if err != nil {
		slog.Error("checking two-factor requirement", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	writeJSON(w, http.StatusOK, sessionResponse{
		Token:                  token,
		ExpiresAt:              expiresAt,
		UserID:                 userID,
		Username:               username,
		accountPerms:           perms,
		TwoFactorSetupRequired: setup,
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
	accountPerms
	TwoFactorSetupRequired bool `json:"two_factor_setup_required"`
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	perms, err := a.loadAccountPerms(r.Context(), session.UserID)
	if err != nil {
		slog.Error("loading permissions", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load account")
		return
	}
	setup, err := a.twoFactorSetupNeeded(r.Context(), session.UserID)
	if err != nil {
		slog.Error("checking two-factor requirement", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load account")
		return
	}
	writeJSON(w, http.StatusOK, meResponse{
		UserID:                 session.UserID,
		Username:               session.Username,
		accountPerms:           perms,
		TwoFactorSetupRequired: setup,
	})
}

// A real argon2id hash of a throwaway value, used only to burn equivalent
// CPU time when a username does not exist. See login above.
const dummyHash = `$argon2id$v=19$m=65536,t=3,p=2$c29tZXNhbHR2YWx1ZTAx$` +
	`Q2hhbmdlTWVUaGlzSXNOb3RBUmVhbFBhc3N3b3Jk`
