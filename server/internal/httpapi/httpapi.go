// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package httpapi wires up the server's HTTP routes.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// maxRequestBody caps how much JSON we will read from a client. Auth payloads
// are tiny; anything larger is a mistake or an attack.
const maxRequestBody = 64 * 1024

type API struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) http.Handler {
	api := &API{pool: pool}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", api.health)

	mux.HandleFunc("POST /api/v1/auth/register", api.register)
	mux.HandleFunc("POST /api/v1/auth/login", api.login)
	mux.HandleFunc("POST /api/v1/auth/logout", api.requireAuth(api.logout))

	mux.HandleFunc("GET /api/v1/me", api.requireAuth(api.me))

	return logRequests(mux)
}

type healthResponse struct {
	Status   string `json:"status"`
	Database string `json:"database"`
	Channels int    `json:"channels"`
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	resp := healthResponse{Status: "ok", Database: "ok"}

	if err := a.pool.QueryRow(r.Context(),
		`SELECT count(*) FROM channels`,
	).Scan(&resp.Channels); err != nil {
		slog.Error("health check query failed", "err", err)
		resp.Status = "degraded"
		resp.Database = "unreachable"
		writeJSON(w, http.StatusServiceUnavailable, resp)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

type errorResponse struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorResponse{Error: message})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writing response", "err", err)
	}
}

// decodeJSON reads a size-limited JSON body into v. It writes an error
// response and returns false if the body is unusable, so callers can simply
// `if !decodeJSON(...) { return }`.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)

	dec := json.NewDecoder(r.Body)
	// Reject unknown fields so a typo in a client field name fails loudly
	// instead of silently doing nothing.
	dec.DisallowUnknownFields()

	if err := dec.Decode(v); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return false
		}
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}

	// A second value in the stream means the client sent two JSON documents.
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "request body must contain a single JSON object")
		return false
	}

	return true
}

// logRequests records method, path, status and duration for every request.
// Deliberately logs no request bodies, no usernames and no message content.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r)

		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration", time.Since(start),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
