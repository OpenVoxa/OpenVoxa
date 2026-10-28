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

	"github.com/openvoxa/openvoxa/server/internal/auth"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// Session is the authenticated caller, attached to the request context by
// requireAuth and read by handlers via sessionFrom.
type Session struct {
	SessionID string
	UserID    string
	Username  string
	Role      string
}

// contextKey is unexported so no other package can collide with our key.
// This is the standard Go idiom for context values.
type contextKey struct{}

var sessionKey contextKey

// sessionFrom returns the session attached by requireAuth. It panics if
// called from a handler that is not behind requireAuth, which is a
// programming error rather than a runtime condition worth handling.
func sessionFrom(ctx context.Context) Session {
	s, ok := ctx.Value(sessionKey).(Session)
	if !ok {
		panic("httpapi: handler requires authentication but is not wrapped in requireAuth")
	}
	return s
}

// requireAuth rejects requests without a valid, unexpired session token.
func (a *API) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		var s Session
		var expiresAt time.Time

		err := a.pool.QueryRow(r.Context(),
			`SELECT s.id, s.user_id, u.username, u.role, s.expires_at
			   FROM sessions s
			   JOIN users u ON u.id = s.user_id
			  WHERE s.token_hash = $1
			    AND u.deleted_at IS NULL`,
			auth.HashSessionToken(token),
		).Scan(&s.SessionID, &s.UserID, &s.Username, &s.Role, &expiresAt)

		switch {
		case errors.Is(err, pgx.ErrNoRows):
			writeError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		case err != nil:
			slog.Error("looking up session", "err", err)
			writeError(w, http.StatusInternalServerError, "could not verify session")
			return
		}

		if time.Now().After(expiresAt) {
			// Clean up on sight rather than waiting for a sweep job.
			if _, err := a.pool.Exec(r.Context(),
				`DELETE FROM sessions WHERE id = $1`, s.SessionID); err != nil {
				slog.Error("deleting expired session", "err", err)
			}
			writeError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		}

		// Fire-and-forget liveness update. A failure here is not worth
		// failing the request over, and context.Background keeps it alive
		// if the client disconnects mid-write.
		go func(id string) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := a.pool.Exec(ctx,
				`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, id); err != nil {
				slog.Warn("updating session last_seen_at", "err", err)
			}
		}(s.SessionID)

		next(w, r.WithContext(context.WithValue(r.Context(), sessionKey, s)))
	}
}

func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	// Scheme is case-insensitive per RFC 7235.
	scheme, token, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

// requireRole wraps requireAuth and additionally demands a minimum role.
//
// The role is read fresh from the database on every request rather than
// baked into the session, so a demotion takes effect immediately instead of
// waiting 30 days for the token to expire.
func (a *API) requireRole(min perm.Role, next http.HandlerFunc) http.HandlerFunc {
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		session := sessionFrom(r.Context())

		role, err := perm.Parse(session.Role)
		if err != nil {
			slog.Error("session carries an unknown role", "role", session.Role)
			writeError(w, http.StatusInternalServerError, "could not check permissions")
			return
		}

		if !perm.AtLeast(role, min) {
			// 403 rather than 404: the caller is authenticated and we are
			// not hiding the route's existence, only refusing the action.
			writeError(w, http.StatusForbidden, "insufficient permissions")
			return
		}

		next(w, r)
	})
}
