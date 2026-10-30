// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package httpapi wires up the server's HTTP routes.
package httpapi

import (
	"bufio"
	"crypto/rand"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/openvoxa/openvoxa/server/internal/blob"
	"github.com/openvoxa/openvoxa/server/internal/config"
	"github.com/openvoxa/openvoxa/server/internal/gif"
	"github.com/openvoxa/openvoxa/server/internal/hub"
	"github.com/openvoxa/openvoxa/server/internal/perm"
	"github.com/openvoxa/openvoxa/server/internal/ratelimit"
	"github.com/openvoxa/openvoxa/server/internal/unfurl"
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

	trustProxy bool
	livekit    config.LiveKitConfig

	// The composed router. API serves HTTP itself so callers can hold the
	// same value they use to emit events.
	handler http.Handler

	// Two limiters, because each covers a hole the other leaves.
	//
	// authIP stops one host hammering the login endpoint. On its own it is
	// beaten by rotating source addresses.
	//
	// authUser stops a distributed attack converging on one account. On its
	// own it would let an attacker lock a real user out, which is why the
	// window is short and a correct password clears it immediately.
	authIP   *ratelimit.Limiter
	authUser *ratelimit.Limiter

	// Link previews make the server fetch arbitrary remote pages, so they
	// are limited per user: 20 up front, then one every 3 seconds.
	unfurl      *unfurl.Fetcher
	unfurlLimit *ratelimit.Limiter

	blobs         *blob.Store
	maxAttachment int64
	uploadLimit   *ratelimit.Limiter

	// Signs attachment download links. Generated per process: a restart
	// invalidates outstanding links, and clients refetch history to get
	// fresh ones. Keeping it out of config means there is no long-lived
	// secret to leak.
	attachKey []byte

	gifs     *gif.Client
	gifLimit *ratelimit.Limiter
}

// New returns the server's root handler. debugUIEnabled serves a bare-bones
// test client at /debug/; it is off unless explicitly turned on.
// ServeHTTP lets API be used directly as an http.Handler.
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.handler.ServeHTTP(w, r)
}

func New(pool *pgxpool.Pool, cfg *config.Config, blobs *blob.Store) *API {
	debugUIEnabled := cfg.DebugUI
	trustProxy := cfg.TrustProxy
	livekit := cfg.LiveKit

	api := &API{
		pool:       pool,
		hub:        hub.New(),
		tickets:    newTicketStore(),
		trustProxy: trustProxy,
		livekit:    livekit,

		// 10 attempts up front, then one every 6 seconds. Generous for a
		// person typing a password, useless for a dictionary attack.
		authIP: ratelimit.New(1.0/6.0, 10, 15*time.Minute),

		// 5 failures per account, refilling one every 2 minutes.
		authUser: ratelimit.New(1.0/120.0, 5, 30*time.Minute),

		unfurl:      unfurl.New(),
		unfurlLimit: ratelimit.New(1.0/3.0, 20, 15*time.Minute),

		blobs:         blobs,
		maxAttachment: cfg.MaxAttachmentBytes,

		// Uploads cost disk and bandwidth, so they are tighter than
		// previews: 10 up front, then one every 5 seconds.
		uploadLimit: ratelimit.New(0.2, 10, 15*time.Minute),

		attachKey: make([]byte, 32),

		gifs: gif.New(cfg.GIFProvider, cfg.GIFAPIKey),

		// Searching is cheap for us and costs the provider, so this is
		// looser than uploads: 30 up front, one every 2 seconds.
		gifLimit: ratelimit.New(0.5, 30, 15*time.Minute),
	}

	if _, err := rand.Read(api.attachKey); err != nil {
		panic("httpapi: could not generate attachment signing key: " + err.Error())
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", api.health)

	mux.HandleFunc("POST /api/v1/auth/register", api.limitByIP(api.register))
	mux.HandleFunc("POST /api/v1/auth/login", api.limitByIP(api.login))
	mux.HandleFunc("POST /api/v1/auth/logout", api.requireAuth(api.logout))

	mux.HandleFunc("GET /api/v1/me", api.requireAuth(api.me))
	mux.HandleFunc("GET /api/v1/channels", api.requireAuth(api.listChannels))

	mux.HandleFunc("GET /api/v1/users",
		api.requireRole(perm.Moderator, api.listUsers))
	mux.HandleFunc("PATCH /api/v1/users/{id}/role",
		withUUIDPath(api.requireRole(perm.Administrator, api.setUserRole)))
	mux.HandleFunc("DELETE /api/v1/users/{id}",
		withUUIDPath(api.requireRole(perm.Administrator, api.deleteUser)))

	mux.HandleFunc("DELETE /api/v1/me", api.requireAuth(api.deleteOwnAccount))

	// Authors delete their own; the handler checks for moderator rank
	// before allowing anyone else's.
	mux.HandleFunc("DELETE /api/v1/messages/{id}",
		withUUIDPath(api.requireAuth(api.deleteMessage)))
	mux.HandleFunc("POST /api/v1/messages/{id}/report",
		withUUIDPath(api.requireAuth(api.reportMessage)))

	mux.HandleFunc("GET /api/v1/reports",
		api.requireRole(perm.Moderator, api.listReports))
	mux.HandleFunc("POST /api/v1/reports/{id}/resolve",
		withUUIDPath(api.requireRole(perm.Moderator, api.resolveReport)))

	mux.HandleFunc("GET /api/v1/bans",
		api.requireRole(perm.Moderator, api.listBans))
	mux.HandleFunc("POST /api/v1/users/{id}/ban",
		withUUIDPath(api.requireRole(perm.Moderator, api.banUser)))
	mux.HandleFunc("DELETE /api/v1/users/{id}/ban",
		withUUIDPath(api.requireRole(perm.Moderator, api.unbanUser)))

	// MLS identity. The server stores and routes this material and never
	// parses it; see docs/decisions.md.
	mux.HandleFunc("POST /api/v1/devices", api.requireAuth(api.registerDevice))
	mux.HandleFunc("GET /api/v1/devices", api.requireAuth(api.listDevices))
	mux.HandleFunc("DELETE /api/v1/devices/{id}",
		withUUIDPath(api.requireAuth(api.revokeDevice)))

	mux.HandleFunc("POST /api/v1/devices/{id}/key-packages",
		withUUIDPath(api.requireAuth(api.publishKeyPackages)))
	mux.HandleFunc("GET /api/v1/devices/{id}/key-packages",
		withUUIDPath(api.requireAuth(api.keyPackageCount)))

	mux.HandleFunc("POST /api/v1/users/{id}/key-packages/claim",
		withUUIDPath(api.requireAuth(api.claimKeyPackages)))

	// MLS groups. The server orders commits and routes opaque blobs; it
	// holds no group state it can read.
	mux.HandleFunc("GET /api/v1/channels/{id}/mls",
		withUUIDPath(api.requireAuth(api.groupState)))
	mux.HandleFunc("POST /api/v1/channels/{id}/mls",
		withUUIDPath(api.requireAuth(api.createGroup)))
	mux.HandleFunc("POST /api/v1/channels/{id}/mls/commit",
		withUUIDPath(api.requireAuth(api.submitCommit)))
	mux.HandleFunc("GET /api/v1/channels/{id}/mls/handshakes",
		withUUIDPath(api.requireAuth(api.listHandshakes)))

	mux.HandleFunc("GET /api/v1/mls/welcomes", api.requireAuth(api.listWelcomes))
	mux.HandleFunc("POST /api/v1/mls/welcomes/{id}/ack",
		api.requireAuth(api.ackWelcome))

	mux.HandleFunc("POST /api/v1/channels",
		api.requireRole(perm.Administrator, api.createChannel))
	mux.HandleFunc("DELETE /api/v1/channels/{id}",
		withUUIDPath(api.requireRole(perm.Administrator, api.deleteChannel)))

	mux.HandleFunc("POST /api/v1/channels/{id}/voice-token",
		withUUIDPath(api.requireAuth(api.voiceToken)))
	mux.HandleFunc("PATCH /api/v1/channels/{id}/force-ptt",
		withUUIDPath(api.requireRole(perm.Moderator, api.setForcePTT)))
	mux.HandleFunc("PATCH /api/v1/channels/{id}/retention",
		withUUIDPath(api.requireRole(perm.Administrator, api.setChannelRetention)))

	mux.HandleFunc("POST /api/v1/unfurl", api.requireAuth(api.unfurlLink))

	mux.HandleFunc("POST /api/v1/channels/{id}/attachments",
		withUUIDPath(api.requireAuth(api.uploadAttachment)))
	// Not behind requireAuth: the signed URL carries its own
	// authorisation, because browsers cannot send headers on <img src>.
	mux.HandleFunc("GET /api/v1/attachments/{id}", withUUIDPath(api.downloadAttachment))

	mux.HandleFunc("GET /api/v1/gifs/config", api.requireAuth(api.gifConfig))
	mux.HandleFunc("GET /api/v1/gifs/search", api.requireAuth(api.searchGifs))
	mux.HandleFunc("POST /api/v1/channels/{id}/gifs",
		withUUIDPath(api.requireAuth(api.attachGif)))

	// Signed token carries its own authorisation, as with attachments.
	mux.HandleFunc("GET /api/v1/gifs/media", api.proxyGifMedia)

	mux.HandleFunc("POST /api/v1/ws/ticket", api.requireAuth(api.wsTicket))
	mux.HandleFunc("GET /api/v1/ws", api.websocket)

	if livekit.APIKey == "" {
		slog.Warn("voice is disabled: LiveKit is not configured")
	}

	if api.gifs.Enabled() {
		slog.Info("gif search enabled", "provider", api.gifs.Provider())
	} else {
		slog.Info("gif search disabled")
	}

	if debugUIEnabled {
		slog.Warn("debug UI enabled at /debug/ - do not run this in production")
		mux.Handle("GET /debug/", http.StripPrefix("/debug/", debugFileServer()))
	}

	api.handler = logRequests(mux)
	return api
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
	ForcePTT    bool   `json:"force_ptt"`

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
		        c.min_role_view, c.min_role_post, c.force_ptt
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
			&c.MinRoleView, &c.MinRolePost, &c.ForcePTT); err != nil {
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

// Unwrap lets http.ResponseController reach the real ResponseWriter
// underneath this recorder.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// Hijack forwards to the underlying connection so websocket upgrades work
// through this middleware.
//
// Wrapping a ResponseWriter silently removes any interface it implemented
// beyond ResponseWriter itself, including http.Hijacker. Without this
// method every websocket upgrade fails with "does not implement
// http.Hijacker". Any future middleware that wraps the writer must forward
// these two methods as well.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("httpapi: ResponseWriter does not support hijacking")
	}
	return hj.Hijack()
}

// withUUIDPath rejects a request whose {id} path value is not a UUID.
//
// Without this, a typo in a URL reaches Postgres, fails there, and comes
// back as a 500 with a vague message. That is wrong twice over: it tells
// the caller the server broke when they sent a bad request, and it fills
// the error log with entries that look like faults. Checking once at the
// edge keeps genuine 500s meaningful.
//
// Applied at route registration rather than inside each handler, so a new
// handler cannot forget it.
func withUUIDPath(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !uuidPattern.MatchString(r.PathValue("id")) {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		next(w, r)
	}
}

// limitByIP rejects callers who have spent their token budget.
func (a *API) limitByIP(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := a.clientIP(r)
		if !a.authIP.Allow(ip) {
			writeTooManyRequests(w, a.authIP.RetryAfter(ip))
			return
		}
		next(w, r)
	}
}

func writeTooManyRequests(w http.ResponseWriter, retryAfter time.Duration) {
	seconds := int(retryAfter.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeError(w, http.StatusTooManyRequests, "too many attempts, try again later")
}

// clientIP returns the address to key rate limiting on.
//
// When trustProxy is set we take the RIGHTMOST X-Forwarded-For entry, not
// the leftmost. A reverse proxy appends the address it saw, so a client who
// sends a forged header produces "forged, real" and the rightmost value is
// the one our proxy observed. Taking the leftmost would let anyone pick
// their own rate-limit key.
//
// This assumes exactly one trusted proxy. More hops means skipping that
// many entries from the right.
func (a *API) clientIP(r *http.Request) string {
	if a.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
