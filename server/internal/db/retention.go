// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package db

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	retentionInterval = 15 * time.Minute

	// Rows removed per statement. Deleting a year of messages in one
	// transaction would hold locks long enough to stall live traffic, so
	// the work is split into chunks that each finish quickly.
	retentionBatch = 5000
)

// StartRetentionSweep enforces each channel's retention policy until ctx is
// cancelled.
//
// Every channel displays its policy to users before they post. That promise
// is only worth something if something actually enforces it, which is what
// this does. Expired messages are removed outright rather than tombstoned:
// in a channel that keeps thirty days, nobody needs to know a message
// existed on day thirty-one.
func StartRetentionSweep(ctx context.Context, pool *pgxpool.Pool) {
	go func() {
		ticker := time.NewTicker(retentionInterval)
		defer ticker.Stop()

		sweepRetention(ctx, pool)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweepRetention(ctx, pool)
			}
		}
	}()
}

func sweepRetention(ctx context.Context, pool *pgxpool.Pool) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	var total int64

	for {
		// NULL retention means keep forever, and the comparison skips
		// those rows without needing a separate query.
		tag, err := pool.Exec(ctx, `
			DELETE FROM messages
			 WHERE id IN (
			       SELECT m.id
			         FROM messages m
			         JOIN channels c ON c.id = m.channel_id
			        WHERE c.retention IS NOT NULL
			          AND m.created_at < now() - c.retention
			        LIMIT $1
			 )`, retentionBatch)
		if err != nil {
			slog.Error("enforcing retention", "err", err)
			return
		}

		n := tag.RowsAffected()
		total += n

		if n < retentionBatch {
			break
		}

		// Breathe between batches so a large backlog does not monopolise
		// the database.
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}

	if total > 0 {
		slog.Info("retention sweep removed messages", "count", total)
	}
}
