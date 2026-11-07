// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// The server's name and icon (migration 0033; decisions.md Feature
// decisions, "Server name and icon"). Anyone may read them, signed in or
// not: the desktop app's server pane shows them before anyone signs in,
// and the sign-in page shows the name. Administrators change them in
// Server settings, General.

const (
	serverNameMax = 40
	// The administrator's browser crops and shrinks the icon to 256 x 256
	// before upload; these leave room for a larger export, nothing more.
	serverIconMaxBytes = 512 * 1024
	serverIconMaxPx    = 1024
)

type serverInfo struct {
	Name string `json:"name"`
	// Icon is a path on this server, with the version in it, or null.
	Icon *string `json:"icon"`
	// Banner is the Home banner (home.go), shown on the sign-in page too.
	Banner *string `json:"banner"`
}

type serverInfoChangedEvent struct {
	Type string `json:"type"`
}

func (a *API) loadServerInfo(ctx context.Context) (serverInfo, error) {
	var (
		out     serverInfo
		version int
		hasIcon bool

		bannerVersion int
		hasBanner     bool
	)
	if err := a.pool.QueryRow(ctx,
		`SELECT server_name, icon IS NOT NULL, icon_version, banner IS NOT NULL, banner_version
		   FROM server_settings`,
	).Scan(&out.Name, &hasIcon, &version, &hasBanner, &bannerVersion); err != nil {
		return out, err
	}
	if hasBanner {
		p := bannerPath(bannerVersion)
		out.Banner = &p
	}
	if hasIcon {
		p := "/api/v1/server-icon?v=" + strconv.Itoa(version)
		out.Icon = &p
	}
	return out, nil
}

// getServerInfo: public. {"name": "...", "icon": "/api/v1/server-icon?v=3" | null}.
func (a *API) getServerInfo(w http.ResponseWriter, r *http.Request) {
	info, err := a.loadServerInfo(r.Context())
	if err != nil {
		slog.Error("loading server info", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load the server info")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	writeJSON(w, http.StatusOK, info)
}

// getServerIcon: public. The icon's bytes, under the same defences as
// stickers (type checked from the bytes at upload, nosniff, sandboxed).
// A URL carrying the current version may be cached for good; any other
// is revalidated, so an old link never sticks.
func (a *API) getServerIcon(w http.ResponseWriter, r *http.Request) {
	var (
		data        []byte
		contentType *string
		version     int
	)
	if err := a.pool.QueryRow(r.Context(),
		`SELECT icon, icon_type, icon_version FROM server_settings`,
	).Scan(&data, &contentType, &version); err != nil {
		slog.Error("loading server icon", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the icon")
		return
	}
	if data == nil || contentType == nil {
		writeError(w, http.StatusNotFound, "this server has no icon")
		return
	}
	w.Header().Set("Content-Type", *contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if r.URL.Query().Get("v") == strconv.Itoa(version) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// cleanServerName trims the name and refuses control characters and
// anything over serverNameMax characters. "" clears it.
func cleanServerName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		return "", errors.New("the name is not valid text")
	}
	if utf8.RuneCountInString(s) > serverNameMax {
		return "", fmt.Errorf("the name can be at most %d characters", serverNameMax)
	}
	for _, c := range s {
		if unicode.IsControl(c) {
			return "", errors.New("the name can't contain line breaks or control characters")
		}
	}
	return s, nil
}

// putServerName: administrators (the route checks). {"name": "..."}.
func (a *API) putServerName(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	var req struct {
		Name *string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == nil {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	name, err := cleanServerName(*req.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	const fail = "could not save the name"
	if !a.changeServerInfo(w, r, fail, func(tx pgx.Tx) (bool, error) {
		tag, err := tx.Exec(r.Context(),
			`UPDATE server_settings SET server_name = $1 WHERE server_name <> $1`, name)
		return tag.RowsAffected() > 0, err
	}, "set_server_name", name) {
		return
	}
	slog.Info("server name set", "actor_id", actor.UserID, "name", name)
	w.WriteHeader(http.StatusNoContent)
}

// putServerIcon: administrators. The body is the image itself (PNG or
// WebP, square, at most serverIconMaxPx), not a form.
func (a *API) putServerIcon(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	tooBig := "the icon is too large; it can be at most " + formatBytes(serverIconMaxBytes)
	if r.ContentLength > serverIconMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, serverIconMaxBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read the icon")
		return
	}
	if len(data) > serverIconMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	contentType, width, height, err := stickerImage(data)
	if err != nil || (contentType != "image/png" && contentType != "image/webp") {
		writeError(w, http.StatusBadRequest, "the icon must be a PNG or WebP image")
		return
	}
	if width != height {
		writeError(w, http.StatusBadRequest, "the icon must be square")
		return
	}
	if width > serverIconMaxPx {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"the icon is %d x %d pixels; it can be at most %d x %d", width, height, serverIconMaxPx, serverIconMaxPx))
		return
	}
	if !a.changeServerInfo(w, r, "could not save the icon", func(tx pgx.Tx) (bool, error) {
		_, err := tx.Exec(r.Context(),
			`UPDATE server_settings SET icon = $1, icon_type = $2, icon_version = icon_version + 1`,
			data, contentType)
		return true, err
	}, "set_server_icon", "") {
		return
	}
	slog.Info("server icon set", "actor_id", actor.UserID, "bytes", len(data))
	w.WriteHeader(http.StatusNoContent)
}

// deleteServerIcon: administrators. Back to the letter.
func (a *API) deleteServerIcon(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	if !a.changeServerInfo(w, r, "could not remove the icon", func(tx pgx.Tx) (bool, error) {
		tag, err := tx.Exec(r.Context(),
			`UPDATE server_settings SET icon = NULL, icon_type = NULL, icon_version = icon_version + 1
			  WHERE icon IS NOT NULL`)
		return tag.RowsAffected() > 0, err
	}, "remove_server_icon", "") {
		return
	}
	slog.Info("server icon removed", "actor_id", actor.UserID)
	w.WriteHeader(http.StatusNoContent)
}

// changeServerInfo runs one change with its moderation log entry in a
// transaction, then tells every client to refetch the server info. A
// change that changed nothing is neither logged nor announced. It writes
// the error response and returns false on failure.
func (a *API) changeServerInfo(w http.ResponseWriter, r *http.Request, fail string,
	change func(pgx.Tx) (bool, error), action, detail string) bool {
	ctx := r.Context()
	actor := sessionFrom(ctx)
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		slog.Error("starting server info transaction", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return false
	}
	defer tx.Rollback(ctx)
	changed, err := change(tx)
	if err != nil {
		slog.Error("changing server info", "action", action, "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return false
	}
	if !changed {
		return true
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO moderation_log (actor_id, action, detail) VALUES ($1, $2, $3)`,
		actor.UserID, action, detail); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return false
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Error("committing server info", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return false
	}
	a.emitAll(serverInfoChangedEvent{Type: "server_info_changed"})
	return true
}
