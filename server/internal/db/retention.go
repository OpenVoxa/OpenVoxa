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
// PurgeNotifier is called once per channel per sweep that actually removed
// something, with the cutoff that was applied.
type PurgeNotifier func(channelID string, before time.Time)

func StartRetentionSweep(ctx context.Context, pool *pgxpool.Pool, notify PurgeNotifier) {
	go func() {
		ticker := time.NewTicker(retentionInterval)
		defer ticker.Stop()

		sweepRetention(ctx, pool, notify)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweepRetention(ctx, pool, notify)
			}
		}
	}()
}

func sweepRetention(ctx context.Context, pool *pgxpool.Pool, notify PurgeNotifier) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	// One channel at a time rather than one statement across all of them.
	// Slightly more queries, but it yields the cutoff per channel, which
	// is what connected clients need to drop the right messages.
	rows, err := pool.Query(ctx,
		`SELECT id, now() - retention
		   FROM channels
		  WHERE retention IS NOT NULL`)
	if err != nil {
		slog.Error("listing channels for retention", "err", err)
		return
	}

	type target struct {
		id     string
		cutoff time.Time
	}

	targets := make([]target, 0)
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.cutoff); err != nil {
			rows.Close()
			slog.Error("scanning retention target", "err", err)
			return
		}
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("iterating retention targets", "err", err)
		return
	}

	for _, t := range targets {
		var removed int64

		for {
			tag, err := pool.Exec(ctx, `
				DELETE FROM messages
				 WHERE id IN (
				       SELECT id FROM messages
				        WHERE channel_id = $1 AND created_at < $2
				        LIMIT $3
				 )`, t.id, t.cutoff, retentionBatch)
			if err != nil {
				slog.Error("enforcing retention", "channel_id", t.id, "err", err)
				break
			}

			n := tag.RowsAffected()
			removed += n

			if n < retentionBatch {
				break
			}

			// Breathe between batches so a large backlog does not
			// monopolise the database.
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
		}

		if removed > 0 {
			slog.Info("retention sweep removed messages",
				"channel_id", t.id, "count", removed)
			if notify != nil {
				notify(t.id, t.cutoff)
			}
		}
	}
}
