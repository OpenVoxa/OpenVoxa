// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// The server keeps at least two administrators once it has two
// (docs/decisions.md, "There is always an administrator"). One is not
// enough: someone who takes over an administrator account could remove
// every other administrator and be the sole controller. With a floor of
// two there is always another who can act. Three pieces:
//
//  1. adminGuard, run inside every transaction that could take the
//     administrator switch away from someone (including a ban), refuses
//     the change if it would drop the count below MinAdmins.
//  2. The command line on the server host can always grant it
//     (`openvoxa-server grant-admin <username>`, cli.go). Control of the
//     host is the real "root", as with a Linux console.
//  3. An empty server is claimed with a setup code printed in the server
//     log, not by whoever registers first.

// MinAdmins is the floor the guard keeps. Shared with cli.go.
const MinAdmins = 2

var errLastAdmin = errors.New("too few administrators")

const lastAdminMessage = "the server must keep at least two administrators; " +
	"make someone else an administrator first"

// ActiveAdminsSQL counts accounts that hold the administrator switch
// through any group and are neither deleted nor banned. A banned
// administrator cannot sign in, so they do not count. Shared with cli.go.
const ActiveAdminsSQL = `
	SELECT count(DISTINCT u.id)
	  FROM users u
	  JOIN effective_groups eg ON eg.user_id = u.id
	  JOIN perm_groups g ON g.id = eg.group_id
	 WHERE 'administrator' = ANY(g.permissions)
	   AND u.deleted_at IS NULL
	   AND NOT EXISTS (
	         SELECT 1 FROM bans b
	          WHERE b.user_id = u.id
	            AND (b.expires_at IS NULL OR b.expires_at > now()))`

// adminGuard refuses a change that takes the server from having an
// administrator to having none. Start it right after Begin, before any
// change, and check it just before Commit.
//
// The advisory lock, held to the end of the transaction, serialises
// these changes: two administrators deleting themselves at the same
// moment would otherwise each see the other still there and both
// succeed.
//
// A change is refused only if it lowers the count AND ends below the
// floor. So a server with one administrator (a new server, or one from
// before this rule) cannot drop to none, but is not frozen either: the
// fix for being under the floor is adding one (grant-admin, or the admin
// pane), and nobody else is trapped meanwhile.
type adminGuard struct{ before int }

func startAdminGuard(ctx context.Context, tx pgx.Tx) (adminGuard, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(4243)`); err != nil {
		return adminGuard{}, err
	}
	var n int
	err := tx.QueryRow(ctx, ActiveAdminsSQL).Scan(&n)
	return adminGuard{before: n}, err
}

// check returns errLastAdmin when tx's changes lowered the count below
// MinAdmins.
func (g adminGuard) check(ctx context.Context, tx pgx.Tx) error {
	var n int
	if err := tx.QueryRow(ctx, ActiveAdminsSQL).Scan(&n); err != nil {
		return err
	}
	if n < g.before && n < MinAdmins {
		return errLastAdmin
	}
	return nil
}

// newSetupCode makes a code like "K7QM-3XPA-9FDT-WE2H": 80 random bits in
// an alphabet without look-alike characters (no 0/O, 1/I/L).
func newSetupCode() string {
	const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("httpapi: could not generate setup code: " + err.Error())
	}
	var sb strings.Builder
	for i, c := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(alphabet[int(c)%len(alphabet)])
	}
	return sb.String()
}

// setupCodeMatches compares ignoring case, spaces and dashes.
func (a *API) setupCodeMatches(typed string) bool {
	norm := func(s string) string {
		return strings.NewReplacer("-", "", " ", "").Replace(strings.ToUpper(strings.TrimSpace(s)))
	}
	return subtle.ConstantTimeCompare([]byte(norm(typed)), []byte(norm(a.setupCode))) == 1
}

// LogSetupCodeIfEmpty prints the setup code when the server has no
// accounts yet. Called at startup; the code changes on every restart.
// It also warns when the server has fewer than MinAdmins administrators.
func (a *API) LogSetupCodeIfEmpty(ctx context.Context) {
	var exists bool
	if err := a.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&exists); err != nil {
		slog.Error("checking for accounts", "err", err)
		return
	}
	if !exists {
		a.logSetupCode()
		return
	}
	var n int
	if err := a.pool.QueryRow(ctx, ActiveAdminsSQL).Scan(&n); err != nil {
		slog.Error("counting administrators", "err", err)
		return
	}
	if n < MinAdmins {
		slog.Warn("fewer than two administrators: if this account is lost or taken over, "+
			"nobody else can act. Add one with grant-admin", "administrators", n)
	}
}

func (a *API) logSetupCode() {
	slog.Warn("no accounts yet: register the first (administrator) account with this setup code",
		"setup_code", a.setupCode)
}

// setupStatus tells the sign-up form whether to ask for the setup code.
// Only reveals whether the server has any account at all.
func (a *API) setupStatus(w http.ResponseWriter, r *http.Request) {
	var exists bool
	if err := a.pool.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&exists); err != nil {
		slog.Error("checking for accounts", "err", err)
		writeError(w, http.StatusInternalServerError, "could not check setup")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"needs_setup_code": !exists})
}
