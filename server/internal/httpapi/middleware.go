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

	// Perms and Rank are read fresh on every request, so a change to
	// someone's groups takes effect immediately rather than waiting for
	// the token to expire. Rank is the position of their highest group.
	Perms perm.Set
	Rank  int
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
		var permNames []string
		var twoFactorOn bool
		var twoFactorPolicy string

		// The ban check runs on every request rather than only at login.
		// Banning deletes existing sessions, but a token issued in the
		// gap between those two statements would otherwise stay valid.
		err := a.pool.QueryRow(r.Context(),
			`SELECT s.id, s.user_id, u.username, s.expires_at,
			        `+userPermsSQL+`,
			        u.totp_enabled_at IS NOT NULL,
			        (SELECT two_factor_required FROM server_settings)
			   FROM sessions s
			   JOIN users u ON u.id = s.user_id
			  WHERE s.token_hash = $1
			    AND u.deleted_at IS NULL
			    AND NOT EXISTS (
			          SELECT 1 FROM bans b
			           WHERE b.user_id = u.id
			             AND (b.expires_at IS NULL OR b.expires_at > now())
			    )`,
			auth.HashSessionToken(token),
		).Scan(&s.SessionID, &s.UserID, &s.Username, &expiresAt, &permNames, &s.Rank,
			&twoFactorOn, &twoFactorPolicy)

		switch {
		case errors.Is(err, pgx.ErrNoRows):
			writeError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		case err != nil:
			slog.Error("looking up session", "err", err)
			writeError(w, http.StatusInternalServerError, "could not verify session")
			return
		}

		s.Perms = perm.NewSet(permNames)

		// Held at the setup screen until two-factor is on (twofactor.go).
		if !twoFactorOn && policyCovers(twoFactorPolicy, s.Perms) && !twoFactorSetupAllowed(r) {
			writeTwoFactorSetupRequired(w)
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

// userPermsSQL selects, for the account u, the switches it holds and its
// rank, as two columns. Shared by requireAuth and anything that needs the
// same answer for another account (subjectRank).
const userPermsSQL = `
	COALESCE((SELECT array_agg(DISTINCT p)
	            FROM effective_groups eg
	            JOIN perm_groups g ON g.id = eg.group_id
	           CROSS JOIN unnest(g.permissions) AS p
	           WHERE eg.user_id = u.id), '{}'::text[]),
	COALESCE((SELECT max(g.position)
	            FROM effective_groups eg
	            JOIN perm_groups g ON g.id = eg.group_id
	           WHERE eg.user_id = u.id), 0)`

// requirePerm wraps requireAuth and additionally demands a permission
// switch. Holders of Administrator pass every check.
func (a *API) requirePerm(need perm.Perm, next http.HandlerFunc) http.HandlerFunc {
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if !sessionFrom(r.Context()).Perms.Has(need) {
			// 403 rather than 404: the caller is authenticated and we are
			// not hiding the route's existence, only refusing the action.
			writeError(w, http.StatusForbidden, "insufficient permissions")
			return
		}
		next(w, r)
	})
}

// requireStaff demands any permission switch at all: the line between
// ordinary accounts and power users.
func (a *API) requireStaff(next http.HandlerFunc) http.HandlerFunc {
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if !sessionFrom(r.Context()).Perms.Staff() {
			writeError(w, http.StatusForbidden, "insufficient permissions")
			return
		}
		next(w, r)
	})
}

// subjectRank returns another account's rank, or pgx.ErrNoRows when it
// does not exist or is deleted. tx may be the pool or a transaction.
func subjectRank(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, userID string) (int, error) {
	var names []string
	var rank int
	err := q.QueryRow(ctx,
		`SELECT `+userPermsSQL+`
		   FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
		userID,
	).Scan(&names, &rank)
	return rank, err
}
