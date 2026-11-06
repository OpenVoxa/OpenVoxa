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

// ---- Device secrets (migration 0031) ----
//
// The server's half of unlocking a browser that signed in by QR login and
// so never had the password (signinlinks.go). One per such browser's
// keyring; any signed-in session of the same account may read it.

// deviceSecretsPerAccount caps the rows one account can pile up (a
// browser wiped without signing out leaves its row behind); the oldest
// go first.
const deviceSecretsPerAccount = 20

type deviceSecretResponse struct {
	ID     string `json:"id"`
	Secret []byte `json:"secret"`
}

func (a *API) createDeviceSecret(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	secret := make([]byte, unlockSecretBytes)
	if _, err := rand.Read(secret); err != nil {
		slog.Error("generating device secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create device secret")
		return
	}
	var id string
	if err := a.pool.QueryRow(r.Context(),
		`INSERT INTO device_secrets (user_id, secret) VALUES ($1, $2) RETURNING id`,
		s.UserID, secret,
	).Scan(&id); err != nil {
		slog.Error("storing device secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create device secret")
		return
	}
	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM device_secrets WHERE user_id = $1 AND id NOT IN (
		   SELECT id FROM device_secrets WHERE user_id = $1
		    ORDER BY created_at DESC LIMIT $2)`,
		s.UserID, deviceSecretsPerAccount,
	); err != nil {
		slog.Error("trimming device secrets", "err", err)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, deviceSecretResponse{ID: id, Secret: secret})
}

func (a *API) getDeviceSecret(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var secret []byte
	err := a.pool.QueryRow(r.Context(),
		`SELECT secret FROM device_secrets WHERE id = $1 AND user_id = $2`,
		r.PathValue("id"), s.UserID,
	).Scan(&secret)
	switch {
	case errors.Is(err, pgx.ErrNoRows) || (err != nil && isInvalidInput(err)):
		writeError(w, http.StatusNotFound, "no such device secret")
		return
	case err != nil:
		slog.Error("reading device secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read device secret")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, deviceSecretResponse{ID: r.PathValue("id"), Secret: secret})
}

// deleteDeviceSecret: the browser now unlocks with the password instead.
func (a *API) deleteDeviceSecret(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM device_secrets WHERE id = $1 AND user_id = $2`,
		r.PathValue("id"), s.UserID,
	); err != nil && !isInvalidInput(err) {
		slog.Error("deleting device secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete device secret")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
