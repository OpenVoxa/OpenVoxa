// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/config"
	"github.com/openvoxa/openvoxa/server/internal/db"
	"github.com/openvoxa/openvoxa/server/internal/httpapi"
)

// Server-host commands. Run inside the running container:
//
//	docker compose exec server /openvoxa-server grant-admin <username>
//
// Whoever can run this controls the server anyway (they hold the
// database), so this is the recovery path when no administrator is left
// (docs/decisions.md, "There is always an administrator"). Nothing here
// is reachable over the network.

const usage = `usage:
  openvoxa-server                          run the server
  openvoxa-server grant-admin <username>   make an account a top-rank administrator
  openvoxa-server list-admins              show who holds the administrator switch
  openvoxa-server list-users               show every account
  openvoxa-server delete-user <username>...  delete accounts for good (no undo)
      --force   allow going below two administrators`

// runCommand handles a command-line subcommand. ok is false when args
// name no command, so main runs the server instead.
func runCommand(args []string) (ok bool, err error) {
	if len(args) == 0 {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch args[0] {
	case "grant-admin":
		if len(args) != 2 {
			return true, errors.New(usage)
		}
		return true, withDB(ctx, func(conn *pgx.Conn) error { return grantAdmin(ctx, conn, args[1]) })
	case "list-admins":
		return true, withDB(ctx, func(conn *pgx.Conn) error { return listAdmins(ctx, conn) })
	case "list-users":
		return true, withDB(ctx, func(conn *pgx.Conn) error { return listUsers(ctx, conn) })
	case "delete-user":
		force := false
		var names []string
		for _, a := range args[1:] {
			if a == "--force" {
				force = true
			} else {
				names = append(names, a)
			}
		}
		if len(names) == 0 {
			return true, errors.New(usage)
		}
		return true, withDB(ctx, func(conn *pgx.Conn) error { return deleteUsers(ctx, conn, names, force) })
	case "-h", "--help", "help":
		fmt.Println(usage)
		return true, nil
	default:
		return true, fmt.Errorf("unknown command %q\n%s", args[0], usage)
	}
}

func withDB(ctx context.Context, fn func(*pgx.Conn) error) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	return fn(conn.Conn())
}

// grantAdmin puts the account in a group that has the administrator
// switch AND the highest position on the server, so the account outranks
// everyone and can repair anything. If no such group exists (someone
// moved or emptied them), it creates one above all others.
func grantAdmin(ctx context.Context, conn *pgx.Conn, username string) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var userID string
	err = tx.QueryRow(ctx,
		`SELECT id::text FROM users WHERE username = $1 AND deleted_at IS NULL`,
		strings.TrimSpace(username)).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("no account named %q", username)
	}
	if err != nil {
		return err
	}

	var maxPos int
	if err := tx.QueryRow(ctx, `SELECT coalesce(max(position), 0) FROM perm_groups`).Scan(&maxPos); err != nil {
		return err
	}

	var groupID, groupName string
	err = tx.QueryRow(ctx,
		`SELECT id::text, name FROM perm_groups
		  WHERE 'administrator' = ANY(permissions) AND position = $1 AND NOT is_everyone
		  ORDER BY created_at LIMIT 1`, maxPos).Scan(&groupID, &groupName)
	if errors.Is(err, pgx.ErrNoRows) {
		groupName = "Administrator"
		var taken bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM perm_groups WHERE name = $1)`, groupName).Scan(&taken); err != nil {
			return err
		}
		if taken {
			groupName = "Administrator (recovered " + time.Now().UTC().Format("2006-01-02") + ")"
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO perm_groups (name, position, permissions)
			 VALUES ($1, $2, '{administrator}') RETURNING id::text`,
			groupName, maxPos+10).Scan(&groupID); err != nil {
			return fmt.Errorf("creating group %q: %w", groupName, err)
		}
		fmt.Printf("created group %q above all others\n", groupName)
	} else if err != nil {
		return err
	}

	tag, err := tx.Exec(ctx,
		`INSERT INTO user_perm_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		userID, groupID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		if _, err := tx.Exec(ctx,
			`INSERT INTO perm_group_changes (actor_id, subject_id, group_id, group_name, action, detail)
			 VALUES (NULL, $1, $2, $3, 'added', 'server command line')`,
			userID, groupID, groupName); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	if tag.RowsAffected() == 0 {
		fmt.Printf("%s is already in %q\n", username, groupName)
	} else {
		fmt.Printf("%s added to %q\n", username, groupName)
	}
	fmt.Println("they have it on their next request; reload any open page to see it")
	return nil
}

func listAdmins(ctx context.Context, conn *pgx.Conn) error {
	rows, err := conn.Query(ctx,
		`SELECT DISTINCT u.username FROM users u
		   JOIN effective_groups eg ON eg.user_id = u.id
		   JOIN perm_groups g ON g.id = eg.group_id
		  WHERE 'administrator' = ANY(g.permissions) AND u.deleted_at IS NULL
		  ORDER BY 1`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		fmt.Println(name)
		n++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var active int
	if err := conn.QueryRow(ctx, httpapi.ActiveAdminsSQL).Scan(&active); err != nil {
		return err
	}
	fmt.Printf("%d administrator(s), %d not banned\n", n, active)
	if active < httpapi.MinAdmins {
		fmt.Printf("warning: the server should have at least %d; add one with grant-admin\n",
			httpapi.MinAdmins)
	}
	return nil
}

// listUsers prints every account with its groups, whether it is banned,
// and when one of its devices was last seen.
func listUsers(ctx context.Context, conn *pgx.Conn) error {
	rows, err := conn.Query(ctx,
		`SELECT u.username,
		        coalesce((SELECT string_agg(g.name, ', ' ORDER BY g.position DESC)
		                    FROM user_perm_groups ug JOIN perm_groups g ON g.id = ug.group_id
		                   WHERE ug.user_id = u.id), ''),
		        EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id
		                   AND (b.expires_at IS NULL OR b.expires_at > now())),
		        u.created_at,
		        (SELECT max(d.last_seen_at) FROM devices d WHERE d.user_id = u.id)
		   FROM users u
		  WHERE u.deleted_at IS NULL
		  ORDER BY u.created_at`)
	if err != nil {
		return err
	}
	defer rows.Close()

	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "USERNAME\tGROUPS\tBANNED\tCREATED\tLAST SEEN")
	n := 0
	for rows.Next() {
		var name, groups string
		var banned bool
		var created time.Time
		var seen *time.Time
		if err := rows.Scan(&name, &groups, &banned, &created, &seen); err != nil {
			return err
		}
		b, s := "", "never"
		if banned {
			b = "yes"
		}
		if seen != nil {
			s = seen.UTC().Format("2006-01-02")
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", name, groups, b, created.UTC().Format("2006-01-02"), s)
		n++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	tw.Flush()
	fmt.Printf("%d account(s)\n", n)
	return nil
}

// deleteUsers deletes accounts exactly as self-deletion does: messages
// emptied (rows kept as tombstones), sessions ended, no undo. Each name is
// its own transaction, so one refusal does not stop the rest. The
// two-administrator floor applies unless --force: the host is trusted,
// but a typo should not quietly remove the last admins.
//
// This process cannot reach the running server's open connections, so a
// deleted user's already-open page stays connected until it next
// reconnects; every request after this fails.
func deleteUsers(ctx context.Context, conn *pgx.Conn, names []string, force bool) error {
	failed := 0
	for _, name := range names {
		if err := deleteUser(ctx, conn, name, force); err != nil {
			fmt.Printf("skipped %s: %v\n", name, err)
			failed++
			continue
		}
		fmt.Printf("deleted %s\n", name)
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d not deleted", failed, len(names))
	}
	return nil
}

func deleteUser(ctx context.Context, conn *pgx.Conn, name string, force bool) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var userID string
	err = tx.QueryRow(ctx,
		`SELECT id::text FROM users WHERE username = $1 AND deleted_at IS NULL`, name).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("no such account")
	}
	if err != nil {
		return err
	}

	guard, err := httpapi.StartAdminGuard(ctx, tx)
	if err != nil {
		return err
	}
	if err := httpapi.PurgeUserTx(ctx, tx, userID); err != nil {
		return err
	}
	if !force {
		if err := guard.Check(ctx, tx); err != nil {
			if httpapi.IsTooFewAdmins(err) {
				return errors.New("the server must keep at least two administrators (add one first, or use --force)")
			}
			return err
		}
	}
	return tx.Commit(ctx)
}

// exitWith prints a command error and exits non-zero.
func exitWith(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
