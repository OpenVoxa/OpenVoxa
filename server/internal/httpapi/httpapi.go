// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package httpapi wires up the server's HTTP routes.
package httpapi

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/openvoxa/openvoxa/server/internal/hub"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// maxRequestBody caps how much JSON we will read from a client. Auth payloads
// are tiny; anything larger is a mistake or an attack.
const maxRequestBody = 64 * 1024

//go:embed debugui
var debugUI embed.FS

type API struct {
	pool    *pgxpool.Pool
	hub     *hub.Hub
	tickets *ticketStore
}

// New returns the server's root handler. debugUIEnabled serves a bare-bones
// test client at /debug/; it is off unless explicitly turned on.
func New(pool *pgxpool.Pool, debugUIEnabled bool) http.Handler {
	api := &API{
		pool:    pool,
		hub:     hub.New(),
		tickets: newTicketStore(),
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", api.health)

	mux.HandleFunc("POST /api/v1/auth/register", api.register)
	mux.HandleFunc("POST /api/v1/auth/login", api.login)
	mux.HandleFunc("POST /api/v1/auth/logout", api.requireAuth(api.logout))

	mux.HandleFunc("GET /api/v1/me", api.requireAuth(api.me))
	mux.HandleFunc("GET /api/v1/channels", api.requireAuth(api.listChannels))

	mux.HandleFunc("GET /api/v1/users",
		api.requireRole(perm.Moderator, api.listUsers))
	mux.HandleFunc("PATCH /api/v1/users/{id}/role",
		api.requireRole(perm.Administrator, api.setUserRole))

	mux.HandleFunc("POST /api/v1/channels",
		api.requireRole(perm.Administrator, api.createChannel))
	mux.HandleFunc("DELETE /api/v1/channels/{id}",
		api.requireRole(perm.Administrator, api.deleteChannel))

	mux.HandleFunc("POST /api/v1/ws/ticket", api.requireAuth(api.wsTicket))
	mux.HandleFunc("GET /api/v1/ws", api.websocket)

	if debugUIEnabled {
		slog.Warn("debug UI enabled at /debug/ - do not run this in production")
		mux.Handle("GET /debug/", http.StripPrefix("/debug/", debugFileServer()))
	}

	return logRequests(mux)
}

// debugFileServer serves the embedded debugui directory at the root of the
// returned handler, so /debug/chat.html maps to debugui/chat.html.
func debugFileServer() http.Handler {
	sub, err := fs.Sub(debugUI, "debugui")
	if err != nil {
		// Embedded at compile time, so a failure here is a build problem.
		panic(err)
	}
	return http.FileServerFS(sub)
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

type channelResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Encrypted bool   `json:"encrypted"`
	Retention string `json:"retention"`

	MinRoleView string `json:"min_role_view"`
	MinRolePost string `json:"min_role_post"`

	// CanPost saves every client from reimplementing the rank comparison.
	// It is advisory only: the server checks again on the websocket.
	CanPost bool `json:"can_post"`
}

// listChannels returns only the channels the caller may view. A channel
// above their rank is omitted entirely rather than shown and refused.
func (a *API) listChannels(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	role, err := perm.Parse(session.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", session.Role)
		writeError(w, http.StatusInternalServerError, "could not list channels")
		return
	}

	rows, err := a.pool.Query(r.Context(),
		`SELECT c.id, c.name, c.kind, c.encrypted,
		        EXTRACT(EPOCH FROM c.retention)::float8,
		        c.min_role_view, c.min_role_post
		   FROM channels c
		   JOIN roles rv ON rv.name = c.min_role_view
		  WHERE rv.rank <= (SELECT rank FROM roles WHERE name = $1)
		  ORDER BY c.name`,
		role.String())
	if err != nil {
		slog.Error("listing channels", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list channels")
		return
	}
	defer rows.Close()

	channels := make([]channelResponse, 0)
	for rows.Next() {
		var c channelResponse
		// Postgres INTERVAL has no direct Go equivalent, so it comes back
		// as seconds and is formatted here. NULL means no expiry.
		var retentionSeconds *float64

		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Encrypted, &retentionSeconds,
			&c.MinRoleView, &c.MinRolePost); err != nil {
			slog.Error("scanning channel", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list channels")
			return
		}

		// Retention is surfaced to every client so the policy can be shown
		// in the UI before anyone posts. "forever" is an explicit value,
		// not an absence.
		if retentionSeconds == nil {
			c.Retention = "forever"
		} else {
			c.Retention = fmt.Sprintf("%s", time.Duration(*retentionSeconds)*time.Second)
		}

		postRole, err := perm.Parse(c.MinRolePost)
		if err != nil {
			slog.Error("channel has an unknown min_role_post", "channel_id", c.ID)
			continue
		}
		c.CanPost = perm.AtLeast(role, postRole)

		channels = append(channels, c)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating channels", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list channels")
		return
	}

	writeJSON(w, http.StatusOK, channels)
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
