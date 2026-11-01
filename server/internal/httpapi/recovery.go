// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Recovery backups (migration 0015). The caller's client uploads its
// plaintext archive, encrypted under a key derived from the recovery key,
// as named chunks. Everything here is own-account only and opaque: the
// server checks sizes and names, nothing else.
//
// Flow: PUT /me/backup starts a backup (new key, old chunks dropped) and
// returns its id. Chunks are uploaded with ?backup=<id>; if another
// device has since started a new backup, the id no longer matches and
// the upload gets 409, so chunks under two different keys never mix.

const (
	maxBackupMetaBytes  = 4 * 1024
	maxBackupChunkBytes = 4 * 1024 * 1024
	maxBackupChunks     = 1000
	// Per account. Text archives are small; this mostly stops the table
	// being used as free file storage.
	maxBackupTotalBytes = 256 * 1024 * 1024
)

// Chunk names are client-chosen. Restricted so they are safe in a URL
// and cannot carry anything readable by accident beyond what the client
// puts there on purpose.
var backupChunkName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type backupChunkInfo struct {
	Name      string    `json:"name"`
	Size      int       `json:"size"`
	UpdatedAt time.Time `json:"updated_at"`
}

type backupInfo struct {
	ID         string            `json:"id"`
	Meta       string            `json:"meta"` // base64
	CreatedAt  time.Time         `json:"created_at"`
	UpdatedAt  time.Time         `json:"updated_at"`
	TotalBytes int               `json:"total_bytes"`
	Chunks     []backupChunkInfo `json:"chunks"`
}

// getBackup returns the caller's backup header and chunk list, or 404
// when they have none (the client then offers to create one).
func (a *API) getBackup(w http.ResponseWriter, r *http.Request) {
	userID := sessionFrom(r.Context()).UserID

	var info backupInfo
	var meta []byte
	err := a.pool.QueryRow(r.Context(),
		`SELECT id::text, meta, created_at, updated_at
		   FROM recovery_backups WHERE user_id = $1`, userID,
	).Scan(&info.ID, &meta, &info.CreatedAt, &info.UpdatedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "no backup")
		return
	case err != nil:
		slog.Error("reading backup", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read backup")
		return
	}
	info.Meta = base64.StdEncoding.EncodeToString(meta)

	rows, err := a.pool.Query(r.Context(),
		`SELECT name, octet_length(body), updated_at
		   FROM recovery_chunks WHERE user_id = $1 ORDER BY name`, userID)
	if err != nil {
		slog.Error("listing backup chunks", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read backup")
		return
	}
	defer rows.Close()

	info.Chunks = make([]backupChunkInfo, 0)
	for rows.Next() {
		var c backupChunkInfo
		if err := rows.Scan(&c.Name, &c.Size, &c.UpdatedAt); err != nil {
			slog.Error("scanning backup chunk", "err", err)
			writeError(w, http.StatusInternalServerError, "could not read backup")
			return
		}
		info.TotalBytes += c.Size
		info.Chunks = append(info.Chunks, c)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating backup chunks", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read backup")
		return
	}
	writeJSON(w, http.StatusOK, info)
}

type startBackupRequest struct {
	Meta string `json:"meta"` // base64
}

// startBackup creates or replaces the caller's backup. Replacing drops
// every existing chunk: they were sealed under the old recovery key.
func (a *API) startBackup(w http.ResponseWriter, r *http.Request) {
	userID := sessionFrom(r.Context()).UserID

	var req startBackupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	meta, err := base64.StdEncoding.DecodeString(req.Meta)
	if err != nil || len(meta) == 0 || len(meta) > maxBackupMetaBytes {
		writeError(w, http.StatusBadRequest, "meta must be base64 and at most 4 KB")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting backup", "err", err)
		writeError(w, http.StatusInternalServerError, "could not start backup")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(),
		`DELETE FROM recovery_chunks WHERE user_id = $1`, userID); err != nil {
		slog.Error("dropping old backup chunks", "err", err)
		writeError(w, http.StatusInternalServerError, "could not start backup")
		return
	}
	var id string
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO recovery_backups (user_id, meta) VALUES ($1, $2)
		 ON CONFLICT (user_id) DO UPDATE
		    SET id = gen_random_uuid(), meta = EXCLUDED.meta,
		        created_at = now(), updated_at = now()
		 RETURNING id::text`, userID, meta).Scan(&id); err != nil {
		slog.Error("storing backup header", "err", err)
		writeError(w, http.StatusInternalServerError, "could not start backup")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing backup start", "err", err)
		writeError(w, http.StatusInternalServerError, "could not start backup")
		return
	}

	slog.Info("recovery backup started", "user_id", userID)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// deleteBackup removes the caller's backup and all its chunks.
func (a *API) deleteBackup(w http.ResponseWriter, r *http.Request) {
	userID := sessionFrom(r.Context()).UserID
	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM recovery_backups WHERE user_id = $1`, userID); err != nil {
		slog.Error("deleting backup", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete backup")
		return
	}
	slog.Info("recovery backup deleted", "user_id", userID)
	w.WriteHeader(http.StatusNoContent)
}

// chunkName writes 400 and returns false for a bad {name}.
func chunkName(w http.ResponseWriter, r *http.Request) (string, bool) {
	name := r.PathValue("name")
	if !backupChunkName.MatchString(name) {
		writeError(w, http.StatusBadRequest,
			"chunk name must be 1 to 64 letters, digits, '-' or '_'")
		return "", false
	}
	return name, true
}

// putBackupChunk stores one chunk. The body is raw bytes
// (application/octet-stream), not JSON: chunks are the bulk of the
// backup and base64 would add a third.
func (a *API) putBackupChunk(w http.ResponseWriter, r *http.Request) {
	userID := sessionFrom(r.Context()).UserID
	name, ok := chunkName(w, r)
	if !ok {
		return
	}
	backupID := r.URL.Query().Get("backup")
	if !uuidPattern.MatchString(backupID) {
		writeError(w, http.StatusBadRequest, "backup must be the id from starting the backup")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBackupChunkBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "chunk is larger than 4 MB")
			return
		}
		writeError(w, http.StatusBadRequest, "could not read chunk")
		return
	}
	if len(body) == 0 {
		writeError(w, http.StatusBadRequest, "chunk is empty")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("storing backup chunk", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store chunk")
		return
	}
	defer tx.Rollback(r.Context())

	// Lock the header so two uploads cannot both pass the quota check,
	// and so a concurrent startBackup cannot slip in between the check
	// and the write.
	var currentID string
	err = tx.QueryRow(r.Context(),
		`SELECT id::text FROM recovery_backups WHERE user_id = $1 FOR UPDATE`,
		userID).Scan(&currentID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusConflict, "no backup started")
		return
	case err != nil:
		slog.Error("locking backup", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store chunk")
		return
	case currentID != backupID:
		writeError(w, http.StatusConflict, "a newer backup has replaced this one")
		return
	}

	// Totals excluding the chunk being replaced, so overwriting a chunk
	// with one of the same size never trips the quota.
	var count, total int
	if err := tx.QueryRow(r.Context(),
		`SELECT count(*), coalesce(sum(octet_length(body)), 0)
		   FROM recovery_chunks WHERE user_id = $1 AND name <> $2`,
		userID, name).Scan(&count, &total); err != nil {
		slog.Error("measuring backup", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store chunk")
		return
	}
	if count+1 > maxBackupChunks {
		writeError(w, http.StatusRequestEntityTooLarge,
			"backup has the maximum of "+strconv.Itoa(maxBackupChunks)+" chunks")
		return
	}
	if total+len(body) > maxBackupTotalBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "backup would exceed 256 MB")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`INSERT INTO recovery_chunks (user_id, name, body) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, name) DO UPDATE
		    SET body = EXCLUDED.body, updated_at = now()`,
		userID, name, body); err != nil {
		slog.Error("storing backup chunk", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store chunk")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE recovery_backups SET updated_at = now() WHERE user_id = $1`,
		userID); err != nil {
		slog.Error("touching backup", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store chunk")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing backup chunk", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store chunk")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// getBackupChunk returns one chunk's raw bytes.
func (a *API) getBackupChunk(w http.ResponseWriter, r *http.Request) {
	userID := sessionFrom(r.Context()).UserID
	name, ok := chunkName(w, r)
	if !ok {
		return
	}

	var body []byte
	err := a.pool.QueryRow(r.Context(),
		`SELECT body FROM recovery_chunks WHERE user_id = $1 AND name = $2`,
		userID, name).Scan(&body)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "chunk not found")
		return
	case err != nil:
		slog.Error("reading backup chunk", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read chunk")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(body); err != nil {
		slog.Error("writing backup chunk", "err", err)
	}
}

// deleteBackupChunk removes one chunk. Deleting one that is not there is
// not an error: the client's goal (it is gone) is met.
func (a *API) deleteBackupChunk(w http.ResponseWriter, r *http.Request) {
	userID := sessionFrom(r.Context()).UserID
	name, ok := chunkName(w, r)
	if !ok {
		return
	}
	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM recovery_chunks WHERE user_id = $1 AND name = $2`,
		userID, name); err != nil {
		slog.Error("deleting backup chunk", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete chunk")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
