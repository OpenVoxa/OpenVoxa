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
	// Sweep interval bounds. The actual interval is derived from the
	// shortest retention policy on the server, so a channel that keeps two
	// minutes is swept far more often than one that keeps thirty days.
	//
	// A fixed interval makes the displayed policy a lie by a variable
	// amount: "kept 2 minutes" with a 15 minute sweep can hold a message
	// for 17. Deriving it instead bounds the overshoot as a fraction of
	// the policy rather than as a fixed number of minutes.
	retentionMinInterval = 30 * time.Second
	retentionMaxInterval = 15 * time.Minute

	// Sweep at a quarter of the shortest policy, so a message outlives its
	// stated retention by at most 25 percent.
	retentionDivisor = 4

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
		// A timer rather than a ticker, because the interval is
		// recalculated after every pass: an administrator setting a short
		// policy should speed the sweep up without a restart.
		for {
			sweepRetention(ctx, pool, notify)

			interval := nextInterval(ctx, pool)

			select {
			case <-ctx.Done():
				return
			case <-time.After(interval):
			}
		}
	}()
}

// nextInterval derives the sweep cadence from the shortest retention
// policy currently configured. With no policies set anywhere it returns
// the maximum, so an all-"forever" server costs one cheap query every
// fifteen minutes.
func nextInterval(ctx context.Context, pool *pgxpool.Pool) time.Duration {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var seconds *float64
	err := pool.QueryRow(ctx,
		`SELECT EXTRACT(EPOCH FROM MIN(retention))::float8
		   FROM channels WHERE retention IS NOT NULL`,
	).Scan(&seconds)

	if err != nil || seconds == nil {
		if err != nil {
			slog.Warn("could not read retention policies", "err", err)
		}
		return retentionMaxInterval
	}

	interval := time.Duration(*seconds/retentionDivisor) * time.Second

	if interval < retentionMinInterval {
		return retentionMinInterval
	}
	if interval > retentionMaxInterval {
		return retentionMaxInterval
	}
	return interval
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
