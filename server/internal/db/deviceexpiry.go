// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package db

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DeviceIdleLimit is how long a device may go unseen before it is revoked.
// Decided by Ryan, 2026-10-31 (docs/decisions.md, Open items).
const DeviceIdleLimit = 30 * 24 * time.Hour

// StartDeviceExpirySweep revokes devices nobody has used for
// DeviceIdleLimit, hourly and once at startup, until ctx is cancelled.
//
// A device whose keys are gone (a closed private window, a wiped browser)
// otherwise stays active forever: members keep adding it to groups and
// spending its key packages, the reusable last resort included. Revoking
// is the same as "Forget this device": unclaimed key packages are deleted,
// and notify (the access_changed event) makes members remove it from
// every group. If the device was only dormant, its client gets 410 at
// next sign-in and registers a new device. Same idea as Signal unlinking
// idle linked devices.
func StartDeviceExpirySweep(ctx context.Context, pool *pgxpool.Pool, notify func()) {
	go func() {
		ticker := time.NewTicker(sweepInterval)
		defer ticker.Stop()

		sweepIdleDevices(ctx, pool, notify)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweepIdleDevices(ctx, pool, notify)
			}
		}
	}()
}

func sweepIdleDevices(ctx context.Context, pool *pgxpool.Pool, notify func()) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	tx, err := pool.Begin(ctx)
	if err != nil {
		slog.Error("starting device expiry", "err", err)
		return
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx,
		`UPDATE devices SET revoked_at = now()
		  WHERE revoked_at IS NULL AND last_seen_at < now() - make_interval(secs => $1)
		  RETURNING id::text`,
		DeviceIdleLimit.Seconds(),
	)
	if err != nil {
		slog.Error("expiring idle devices", "err", err)
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			slog.Error("scanning expired device", "err", err)
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("expiring idle devices", "err", err)
		return
	}
	if len(ids) == 0 {
		return
	}

	if _, err := tx.Exec(ctx,
		`DELETE FROM key_packages WHERE claimed_at IS NULL AND device_id = ANY($1::uuid[])`,
		ids,
	); err != nil {
		slog.Error("clearing key packages for expired devices", "err", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Error("committing device expiry", "err", err)
		return
	}

	slog.Info("idle devices revoked", "count", len(ids))
	notify()
}
