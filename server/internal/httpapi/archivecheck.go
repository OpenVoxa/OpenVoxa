// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"log/slog"
	"net/http"
	"strings"
)

// maxArchiveCheck is how many ids one request may ask about. 500 UUIDs
// in JSON is about 20 KB, well inside maxRequestBody.
const maxArchiveCheck = 500

type archiveCheckRequest struct {
	IDs []string `json:"ids"`
}

type archiveCheckResponse struct {
	// Gone lists the ids that should no longer be kept: deleted
	// (tombstoned, including by account deletion) or no longer on the
	// server at all (retention, channel deletion).
	Gone []string `json:"gone"`
}

// checkArchive tells a client which of the messages it keeps a local
// plaintext copy of have since been deleted, so it can delete its copy
// too (decisions.md, Encryption, "Account deletion is crypto-shredding",
// "What it cannot do").
//
// The archive holds only message ids, not authors, and a device that was
// offline when an account was deleted never saw the user_purged event,
// so the client cannot work this out alone. Asking by id covers every
// way a message goes: account deletion, single deletes, retention, a
// deleted channel, and old copies brought back by a backup restore.
//
// The answer reveals nothing new. The ids are random UUIDs the caller
// already holds, and the reply says only whether each still exists.
func (a *API) checkArchive(w http.ResponseWriter, r *http.Request) {
	var req archiveCheckRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.IDs) > maxArchiveCheck {
		writeError(w, http.StatusBadRequest, "too many ids in one request")
		return
	}

	// Anything that is not a UUID cannot be a message, so it is gone.
	// Checking here keeps a malformed id from failing the whole query.
	gone := make([]string, 0)
	ids := make([]string, 0, len(req.IDs))
	for _, id := range req.IDs {
		if uuidPattern.MatchString(id) {
			ids = append(ids, id)
		} else {
			gone = append(gone, id)
		}
	}

	alive := make(map[string]bool, len(ids))
	if len(ids) > 0 {
		rows, err := a.pool.Query(r.Context(),
			`SELECT id::text FROM messages WHERE id = ANY($1::uuid[]) AND NOT deleted`, ids)
		if err != nil {
			slog.Error("checking archived messages", "err", err)
			writeError(w, http.StatusInternalServerError, "could not check messages")
			return
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				slog.Error("scanning archived message id", "err", err)
				writeError(w, http.StatusInternalServerError, "could not check messages")
				return
			}
			alive[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			slog.Error("iterating archived messages", "err", err)
			writeError(w, http.StatusInternalServerError, "could not check messages")
			return
		}
	}

	// Postgres answers in lower case; compare the same way, so an id sent
	// in capitals is never reported gone while the message still exists.
	for _, id := range ids {
		if !alive[strings.ToLower(id)] {
			gone = append(gone, id)
		}
	}
	writeJSON(w, http.StatusOK, archiveCheckResponse{Gone: gone})
}
