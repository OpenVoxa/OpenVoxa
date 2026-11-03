// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
)

const unlockSecretBytes = 32

type unlockSecretResponse struct {
	// Go encodes []byte as standard base64 in JSON.
	Secret []byte `json:"secret"`
}

// getUnlockSecret returns the caller's own session's unlock secret,
// creating it on first request (migration 0019).
//
// The client uses it to wrap its local data key in sessionStorage so a
// page refresh does not need the password again. It is per session, never
// per account: another session's secret would unlock another tab's copy.
//
// COALESCE keeps it stable: two tabs of the same session asking at once
// both get whichever value was written first, never two different ones.
// A fresh random value is generated per request and discarded when one
// already exists, which costs 32 random bytes and saves a second query.
func (a *API) getUnlockSecret(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	fresh := make([]byte, unlockSecretBytes)
	if _, err := rand.Read(fresh); err != nil {
		slog.Error("generating unlock secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create unlock secret")
		return
	}

	var secret []byte
	err := a.pool.QueryRow(r.Context(),
		`UPDATE sessions SET unlock_secret = COALESCE(unlock_secret, $2)
		  WHERE id = $1
		  RETURNING unlock_secret`,
		session.SessionID, fresh,
	).Scan(&secret)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Deleted between requireAuth and here (logout in another tab).
		writeError(w, http.StatusUnauthorized, "invalid or expired session")
		return
	case err != nil:
		slog.Error("reading unlock secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read unlock secret")
		return
	}

	// A key, even half of one: no browser or proxy cache may keep it.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, unlockSecretResponse{Secret: secret})
}
