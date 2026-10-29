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
	blobGCInterval = 30 * time.Minute

	// How long an uploaded file may sit unclaimed before it is assumed
	// abandoned. Generous: someone may upload a large file and then go
	// make a cup of tea before sending the message.
	orphanAge = time.Hour
)

// BlobRemover deletes stored bytes. Implemented by blob.Store.
type BlobRemover interface {
	Remove(hash []byte) error
}

// StartBlobGC removes abandoned uploads and unreferenced blobs.
//
// Attachments inherit their channel's retention through the message that
// carries them: when retention deletes a message, the attachment rows
// cascade away, and this job then notices the blob has no referrers and
// removes the bytes. Without it, deleted content would keep occupying disk
// indefinitely, which would make the retention promise only half true.
func StartBlobGC(ctx context.Context, pool *pgxpool.Pool, store BlobRemover) {
	go func() {
		ticker := time.NewTicker(blobGCInterval)
		defer ticker.Stop()

		collectBlobs(ctx, pool, store)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				collectBlobs(ctx, pool, store)
			}
		}
	}()
}

func collectBlobs(ctx context.Context, pool *pgxpool.Pool, store BlobRemover) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	// Uploads that never got attached to a message.
	tag, err := pool.Exec(ctx,
		`DELETE FROM attachments
		  WHERE message_id IS NULL AND created_at < now() - $1::interval`,
		orphanAge.String())
	if err != nil {
		slog.Error("sweeping abandoned uploads", "err", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		slog.Info("abandoned uploads removed", "count", n)
	}

	// Blobs nothing references any more. The row is deleted first and the
	// file second: a crash between the two leaves a file with no row,
	// which the next pass cannot see but which wastes only disk. The
	// reverse order would leave a row pointing at a missing file, which
	// breaks downloads.
	rows, err := pool.Query(ctx,
		`DELETE FROM blobs
		  WHERE NOT EXISTS (
		        SELECT 1 FROM attachments WHERE attachments.blob_hash = blobs.hash
		  )
		  RETURNING hash`)
	if err != nil {
		slog.Error("finding unreferenced blobs", "err", err)
		return
	}

	hashes := make([][]byte, 0)
	for rows.Next() {
		var h []byte
		if err := rows.Scan(&h); err != nil {
			rows.Close()
			slog.Error("scanning blob hash", "err", err)
			return
		}
		hashes = append(hashes, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("iterating unreferenced blobs", "err", err)
		return
	}

	removed := 0
	for _, h := range hashes {
		if err := store.Remove(h); err != nil {
			slog.Error("removing blob file", "err", err)
			continue
		}
		removed++
	}

	if removed > 0 {
		slog.Info("unreferenced blobs removed", "count", removed)
	}
}
