// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
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
  openvoxa-server                       run the server
  openvoxa-server grant-admin <username>  make an account a top-rank administrator
  openvoxa-server list-admins            show who holds the administrator switch`

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
	return nil
}

// exitWith prints a command error and exits non-zero.
func exitWith(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
