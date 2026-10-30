// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	maxDeviceLabelRunes = 64

	// A key package is a few hundred bytes. This is loose enough for any
	// ciphersuite and tight enough that the table cannot be used as
	// storage.
	maxKeyPackageBytes = 16 * 1024

	// How many a client may publish in one call. Enough to cover a burst
	// of group adds without a round trip for each.
	maxKeyPackageBatch = 50

	// Below this, clients should replenish. Reported so the client does
	// not have to guess.
	keyPackageLowWater = 10
)

type registerDeviceRequest struct {
	Label string `json:"label"`
	// Base64 of the device's MLS signature public key.
	SignatureKey string `json:"signature_key"`
}

type deviceResponse struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
}

// registerDevice creates a cryptographic identity for one client install.
//
// The returned ID is what the client puts in its MLS credential, so every
// member of a group can see which device authored a message. It is issued
// before the client generates its key package, which is why registration
// and publication are two calls rather than one.
func (a *API) registerDevice(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	var req registerDeviceRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if utf8.RuneCountInString(req.Label) > maxDeviceLabelRunes {
		writeError(w, http.StatusBadRequest, "label is too long")
		return
	}

	key, err := base64.StdEncoding.DecodeString(req.SignatureKey)
	if err != nil || len(key) == 0 || len(key) > 1024 {
		writeError(w, http.StatusBadRequest, "signature_key must be base64-encoded key material")
		return
	}

	var out deviceResponse
	err = a.pool.QueryRow(r.Context(),
		`INSERT INTO devices (user_id, label, signature_key)
		 VALUES ($1, $2, $3)
		 RETURNING id, label, created_at, last_seen_at`,
		session.UserID, req.Label, key,
	).Scan(&out.ID, &out.Label, &out.CreatedAt, &out.LastSeenAt)

	if err != nil {
		slog.Error("registering device", "err", err)
		writeError(w, http.StatusInternalServerError, "could not register the device")
		return
	}

	slog.Info("device registered", "user_id", session.UserID, "device_id", out.ID)
	writeJSON(w, http.StatusCreated, out)
}

// listDevices returns the caller's own devices.
func (a *API) listDevices(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	rows, err := a.pool.Query(r.Context(),
		`SELECT id, label, created_at, last_seen_at
		   FROM devices
		  WHERE user_id = $1 AND revoked_at IS NULL
		  ORDER BY created_at`,
		session.UserID)
	if err != nil {
		slog.Error("listing devices", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list devices")
		return
	}
	defer rows.Close()

	out := make([]deviceResponse, 0)
	for rows.Next() {
		var d deviceResponse
		if err := rows.Scan(&d.ID, &d.Label, &d.CreatedAt, &d.LastSeenAt); err != nil {
			slog.Error("scanning device", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list devices")
			return
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating devices", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list devices")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

// revokeDevice marks a device as gone.
//
// The row survives so historical messages still resolve to a known
// device. Removing it from existing MLS groups is a separate, client-side
// operation: the server cannot do it, because it cannot produce a commit.
func (a *API) revokeDevice(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	tag, err := a.pool.Exec(r.Context(),
		`UPDATE devices SET revoked_at = now()
		  WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
		r.PathValue("id"), session.UserID)
	if err != nil {
		slog.Error("revoking device", "err", err)
		writeError(w, http.StatusInternalServerError, "could not revoke the device")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}

	// Unclaimed packages for a revoked device must not be handed out, or
	// someone would add a device that is no longer meant to exist.
	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM key_packages WHERE device_id = $1 AND claimed_at IS NULL`,
		r.PathValue("id"),
	); err != nil {
		slog.Error("clearing key packages for revoked device", "err", err)
	}

	w.WriteHeader(http.StatusNoContent)
}

type publishKeyPackagesRequest struct {
	// Base64-encoded MLS key packages.
	Packages []string `json:"packages"`
	// Optional reusable fallback, replacing any previous one.
	LastResort string `json:"last_resort"`
}

type keyPackageCountResponse struct {
	Available     int  `json:"available"`
	HasLastResort bool `json:"has_last_resort"`
	LowWater      int  `json:"low_water"`
}

// publishKeyPackages stores packages a device has generated in advance.
//
// They are published ahead of time because the person adding you to a
// group is almost certainly doing it while you are offline. The server
// holds them, hands them out one at a time, and never parses them.
func (a *API) publishKeyPackages(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	deviceID := r.PathValue("id")

	var req publishKeyPackagesRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if len(req.Packages) > maxKeyPackageBatch {
		writeError(w, http.StatusBadRequest, "too many key packages in one request")
		return
	}
	if len(req.Packages) == 0 && req.LastResort == "" {
		writeError(w, http.StatusBadRequest, "nothing to publish")
		return
	}

	if !a.uploadLimit.Allow(session.UserID) {
		writeTooManyRequests(w, a.uploadLimit.RetryAfter(session.UserID))
		return
	}

	// Ownership check: a device may only publish for itself.
	var owner string
	err := a.pool.QueryRow(r.Context(),
		`SELECT user_id FROM devices WHERE id = $1 AND revoked_at IS NULL`,
		deviceID,
	).Scan(&owner)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "device not found")
		return
	case err != nil:
		slog.Error("looking up device", "err", err)
		writeError(w, http.StatusInternalServerError, "could not publish key packages")
		return
	case owner != session.UserID:
		// 404 rather than 403: the existence of someone else's device is
		// not this caller's business.
		writeError(w, http.StatusNotFound, "device not found")
		return
	}

	decoded := make([][]byte, 0, len(req.Packages))
	for _, encoded := range req.Packages {
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(raw) == 0 || len(raw) > maxKeyPackageBytes {
			writeError(w, http.StatusBadRequest, "key packages must be base64 and non-empty")
			return
		}
		decoded = append(decoded, raw)
	}

	var lastResort []byte
	if req.LastResort != "" {
		raw, err := base64.StdEncoding.DecodeString(req.LastResort)
		if err != nil || len(raw) == 0 || len(raw) > maxKeyPackageBytes {
			writeError(w, http.StatusBadRequest, "last_resort must be base64 and non-empty")
			return
		}
		lastResort = raw
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting key package publish", "err", err)
		writeError(w, http.StatusInternalServerError, "could not publish key packages")
		return
	}
	defer tx.Rollback(r.Context())

	for _, raw := range decoded {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO key_packages (device_id, user_id, package)
			 VALUES ($1, $2, $3)`,
			deviceID, session.UserID, raw,
		); err != nil {
			slog.Error("storing key package", "err", err)
			writeError(w, http.StatusInternalServerError, "could not publish key packages")
			return
		}
	}

	if lastResort != nil {
		// Replaced rather than accumulated: there is exactly one, and a
		// newly published one supersedes whatever came before.
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO key_packages (device_id, user_id, package, is_last_resort)
			 VALUES ($1, $2, $3, true)
			 ON CONFLICT (device_id) WHERE is_last_resort
			 DO UPDATE SET package = EXCLUDED.package, created_at = now(),
			               claimed_at = NULL, claimed_by = NULL`,
			deviceID, session.UserID, lastResort,
		); err != nil {
			slog.Error("storing last resort key package", "err", err)
			writeError(w, http.StatusInternalServerError, "could not publish key packages")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing key packages", "err", err)
		writeError(w, http.StatusInternalServerError, "could not publish key packages")
		return
	}

	a.writeKeyPackageCount(w, r, deviceID)
}

// keyPackageCount lets a client know when to replenish.
func (a *API) keyPackageCount(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	deviceID := r.PathValue("id")

	var owner string
	err := a.pool.QueryRow(r.Context(),
		`SELECT user_id FROM devices WHERE id = $1`, deviceID).Scan(&owner)

	switch {
	case errors.Is(err, pgx.ErrNoRows), err == nil && owner != session.UserID:
		writeError(w, http.StatusNotFound, "device not found")
		return
	case err != nil:
		slog.Error("looking up device", "err", err)
		writeError(w, http.StatusInternalServerError, "could not count key packages")
		return
	}

	a.writeKeyPackageCount(w, r, deviceID)
}

func (a *API) writeKeyPackageCount(w http.ResponseWriter, r *http.Request, deviceID string) {
	var out keyPackageCountResponse
	out.LowWater = keyPackageLowWater

	err := a.pool.QueryRow(r.Context(),
		`SELECT
		   count(*) FILTER (WHERE claimed_at IS NULL AND is_last_resort = false),
		   count(*) FILTER (WHERE is_last_resort) > 0
		 FROM key_packages WHERE device_id = $1`,
		deviceID,
	).Scan(&out.Available, &out.HasLastResort)

	if err != nil {
		slog.Error("counting key packages", "err", err)
		writeError(w, http.StatusInternalServerError, "could not count key packages")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

type claimedPackage struct {
	DeviceID     string `json:"device_id"`
	Label        string `json:"label"`
	Package      string `json:"package"`
	WasLastResort bool  `json:"was_last_resort"`
}

// claimKeyPackages hands out one key package per device of a user, so the
// caller can add every one of that user's devices to a group.
//
// Claiming consumes the package. Handing the same one out twice would
// mean two groups sharing an initial secret, which is precisely the
// forward secrecy failure MLS exists to prevent. The last-resort package
// is the deliberate exception, and the response says when one was used so
// a client can surface the weaker guarantee rather than hide it.
func (a *API) claimKeyPackages(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	targetUser := r.PathValue("id")

	rows, err := a.pool.Query(r.Context(),
		`SELECT id, label FROM devices
		  WHERE user_id = $1 AND revoked_at IS NULL`,
		targetUser)
	if err != nil {
		slog.Error("listing target devices", "err", err)
		writeError(w, http.StatusInternalServerError, "could not claim key packages")
		return
	}

	type device struct{ id, label string }
	devices := make([]device, 0)
	for rows.Next() {
		var d device
		if err := rows.Scan(&d.id, &d.label); err != nil {
			rows.Close()
			slog.Error("scanning target device", "err", err)
			writeError(w, http.StatusInternalServerError, "could not claim key packages")
			return
		}
		devices = append(devices, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("iterating target devices", "err", err)
		writeError(w, http.StatusInternalServerError, "could not claim key packages")
		return
	}

	if len(devices) == 0 {
		writeError(w, http.StatusNotFound, "that user has no devices registered")
		return
	}

	out := make([]claimedPackage, 0, len(devices))

	for _, d := range devices {
		var raw []byte
		var wasLastResort bool

		// SKIP LOCKED so two people adding the same user at the same
		// moment take different packages instead of blocking or
		// colliding.
		err := a.pool.QueryRow(r.Context(),
			`UPDATE key_packages SET claimed_at = now(), claimed_by = $1
			  WHERE id = (
			        SELECT id FROM key_packages
			         WHERE device_id = $2
			           AND claimed_at IS NULL
			           AND is_last_resort = false
			         ORDER BY created_at
			         LIMIT 1
			         FOR UPDATE SKIP LOCKED
			  )
			  RETURNING package, false`,
			session.UserID, d.id,
		).Scan(&raw, &wasLastResort)

		if errors.Is(err, pgx.ErrNoRows) {
			// Pool is empty. Fall back to the reusable package, which is
			// why it exists.
			err = a.pool.QueryRow(r.Context(),
				`SELECT package, true FROM key_packages
				  WHERE device_id = $1 AND is_last_resort = true`,
				d.id,
			).Scan(&raw, &wasLastResort)

			if errors.Is(err, pgx.ErrNoRows) {
				// Nothing at all for this device. Skip it rather than
				// failing the whole request: adding the user's other
				// devices is better than adding none.
				slog.Warn("no key packages available", "device_id", d.id)
				continue
			}
		}

		if err != nil {
			slog.Error("claiming key package", "err", err)
			writeError(w, http.StatusInternalServerError, "could not claim key packages")
			return
		}

		out = append(out, claimedPackage{
			DeviceID:      d.id,
			Label:         d.label,
			Package:       base64.StdEncoding.EncodeToString(raw),
			WasLastResort: wasLastResort,
		})
	}

	if len(out) == 0 {
		writeError(w, http.StatusConflict,
			"none of that user's devices have key packages available")
		return
	}

	writeJSON(w, http.StatusOK, out)
}
