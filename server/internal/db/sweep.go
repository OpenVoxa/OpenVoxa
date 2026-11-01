// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package db

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const sweepInterval = time.Hour

// StartSessionSweep deletes expired sessions in the background until ctx is
// cancelled.
//
// Expired sessions are already rejected at request time, so this is about
// not accumulating dead rows indefinitely. It also matters for the deletion
// promise: a row holding a user's ID should not outlive its usefulness just
// because nobody tried to use that token again.
func StartSessionSweep(ctx context.Context, pool *pgxpool.Pool) {
	go func() {
		ticker := time.NewTicker(sweepInterval)
		defer ticker.Stop()

		// Run once at startup so a long-stopped server cleans up promptly
		// rather than waiting an hour.
		sweepSessions(ctx, pool)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweepSessions(ctx, pool)
			}
		}
	}()
}

func sweepSessions(ctx context.Context, pool *pgxpool.Pool) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	tag, err := pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	if err != nil {
		slog.Error("sweeping expired sessions", "err", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		slog.Info("expired sessions removed", "count", n)
	}

	// History bundles nobody collected: the device never came back, so
	// the bundle is just ciphertext taking up space.
	tag, err = pool.Exec(ctx,
		`DELETE FROM mls_history_shares WHERE created_at < now() - interval '7 days'`)
	if err != nil {
		slog.Error("sweeping history shares", "err", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		slog.Info("uncollected history shares removed", "count", n)
	}
}
