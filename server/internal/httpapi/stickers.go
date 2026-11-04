// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/blob"
)

// Custom stickers: one server-wide set, managed by holders of
// manage_stickers (decisions.md Open items, "Custom stickers"; migration
// 0024).
//
// The server stores and serves the images. Sending one is an ordinary
// message whose text is a sticker token (client-core chat.ts), so in an
// encrypted channel the server never learns from the message which
// sticker was sent. Fetching the image still shows it who looked at
// which sticker, as with GIFs.
//
// Stickers are not sealed under the uploader's key and are not
// crypto-shredded: they belong to the server, and deleting the
// uploader's account only clears uploader_id.

type stickerInfo struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Alt         string    `json:"alt"`
	ContentType string    `json:"content_type"`
	Size        int64     `json:"size"`
	Width       int       `json:"width"`
	Height      int       `json:"height"`
	Uploader    string    `json:"uploader"`
	CreatedAt   time.Time `json:"created_at"`
}

type stickerLimits struct {
	MaxBytes int `json:"max_bytes"`
	MaxPx    int `json:"max_px"`
	MaxCount int `json:"max_count"`
}

type stickerList struct {
	Stickers []stickerInfo `json:"stickers"`
	Limits   stickerLimits `json:"limits"`
}

// Bounds an administrator may set the limits within; the same as the
// CHECK constraints in migration 0024.
const (
	stickerBytesMin, stickerBytesMax = 16 * 1024, 10 * 1024 * 1024
	stickerPxMin, stickerPxMax       = 64, 2048
	stickerCountMin, stickerCountMax = 1, 1000
	stickerAltMax                    = 200
)

// Lower-case letters, digits and underscores, so a name works as a
// :name: shortcode and reads the same everywhere.
var stickerNameRe = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

func cleanStickerName(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.Trim(s, ":")
	if !stickerNameRe.MatchString(s) {
		return "", errors.New("a sticker name is 2 to 32 letters, digits or underscores")
	}
	return s, nil
}

func cleanStickerAlt(s string) (string, error) {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s))
	if utf8.RuneCountInString(s) > stickerAltMax {
		return "", fmt.Errorf("the description can be at most %d characters", stickerAltMax)
	}
	return s, nil
}

func (a *API) stickerLimits(r *http.Request) (stickerLimits, error) {
	var l stickerLimits
	err := a.pool.QueryRow(r.Context(),
		`SELECT sticker_max_bytes, sticker_max_px, sticker_max_count FROM server_settings`,
	).Scan(&l.MaxBytes, &l.MaxPx, &l.MaxCount)
	return l, err
}

// listStickers: anyone signed in, so everyone can pick and show them.
func (a *API) listStickers(w http.ResponseWriter, r *http.Request) {
	limits, err := a.stickerLimits(r)
	if err != nil {
		slog.Error("loading sticker limits", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load stickers")
		return
	}
	rows, err := a.pool.Query(r.Context(),
		`SELECT s.id, s.name, s.alt, s.content_type, s.size, s.width, s.height,
		        COALESCE(u.username, ''), s.created_at
		   FROM stickers s
		   LEFT JOIN users u ON u.id = s.uploader_id
		  ORDER BY s.name`)
	if err != nil {
		slog.Error("listing stickers", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load stickers")
		return
	}
	defer rows.Close()
	out := stickerList{Stickers: make([]stickerInfo, 0), Limits: limits}
	for rows.Next() {
		var s stickerInfo
		if err := rows.Scan(&s.ID, &s.Name, &s.Alt, &s.ContentType, &s.Size,
			&s.Width, &s.Height, &s.Uploader, &s.CreatedAt); err != nil {
			slog.Error("scanning sticker", "err", err)
			writeError(w, http.StatusInternalServerError, "could not load stickers")
			return
		}
		out.Stickers = append(out.Stickers, s)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating stickers", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load stickers")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// stickerImage serves one sticker's bytes to anyone signed in. The client
// fetches it with its session token and shows it from a blob: URL, so no
// signed link is needed and nothing expires. The id never changes what
// it points at, so the response may be cached for good.
func (a *API) stickerImageFile(w http.ResponseWriter, r *http.Request) {
	var (
		hash        []byte
		contentType string
	)
	err := a.pool.QueryRow(r.Context(),
		`SELECT blob_hash, content_type FROM stickers WHERE id = $1`, r.PathValue("id"),
	).Scan(&hash, &contentType)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "sticker not found")
		return
	case err != nil:
		slog.Error("looking up sticker", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the sticker")
		return
	}
	f, err := a.blobs.Open(hash)
	if err != nil {
		slog.Error("opening sticker blob", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the sticker")
		return
	}
	defer f.Close()

	// Same defences as attachments: the type was checked from the bytes
	// at upload, and the browser must not sniff or script it anyway.
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, "", time.Time{}, f)
}

// uploadSticker: manage_stickers (the route checks). A multipart form
// with file, name and optional alt.
func (a *API) uploadSticker(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	if !a.uploadLimit.Allow(session.UserID) {
		writeTooManyRequests(w, a.uploadLimit.RetryAfter(session.UserID))
		return
	}
	limits, err := a.stickerLimits(r)
	if err != nil {
		slog.Error("loading sticker limits", "err", err)
		writeError(w, http.StatusInternalServerError, "could not add the sticker")
		return
	}
	tooBig := fmt.Sprintf("the file is too large; stickers can be at most %s", formatBytes(limits.MaxBytes))
	if r.ContentLength > int64(limits.MaxBytes)+maxFormOverhead {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, int64(limits.MaxBytes)+maxFormOverhead)

	file, _, err := r.FormFile("file")
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || strings.Contains(err.Error(), "request body too large") {
			writeError(w, http.StatusRequestEntityTooLarge, tooBig)
			return
		}
		writeError(w, http.StatusBadRequest, "expected a multipart form with a 'file' field")
		return
	}
	defer file.Close()

	name, err := cleanStickerName(r.FormValue("name"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	alt, err := cleanStickerAlt(r.FormValue("alt"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, int64(limits.MaxBytes)+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read the file")
		return
	}
	if len(data) > limits.MaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	contentType, width, height, err := stickerImage(data)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if width > limits.MaxPx || height > limits.MaxPx {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"the image is %d x %d pixels; stickers can be at most %d x %d",
			width, height, limits.MaxPx, limits.MaxPx))
		return
	}

	hash, size, err := a.blobs.Put(bytes.NewReader(data), int64(limits.MaxBytes))
	if err != nil {
		if errors.Is(err, blob.ErrTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, tooBig)
			return
		}
		slog.Error("storing sticker", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the sticker")
		return
	}

	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		slog.Error("starting sticker transaction", "err", err)
		writeError(w, http.StatusInternalServerError, "could not add the sticker")
		return
	}
	defer tx.Rollback(ctx)

	// Locking the settings row makes two uploads at once count one after
	// the other, so the limit cannot be overshot.
	var count int
	if err := tx.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM stickers), sticker_max_count
		   FROM server_settings FOR UPDATE`).Scan(&count, &limits.MaxCount); err != nil {
		slog.Error("counting stickers", "err", err)
		writeError(w, http.StatusInternalServerError, "could not add the sticker")
		return
	}
	if count >= limits.MaxCount {
		writeError(w, http.StatusConflict, fmt.Sprintf(
			"this server already has %d stickers, the most it allows; remove one first", count))
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO blobs (hash, size) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING`,
		hash, size); err != nil {
		slog.Error("recording sticker blob", "err", err)
		writeError(w, http.StatusInternalServerError, "could not add the sticker")
		return
	}
	info := stickerInfo{Name: name, Alt: alt, ContentType: contentType, Size: size,
		Width: width, Height: height, Uploader: session.Username}
	err = tx.QueryRow(ctx,
		`INSERT INTO stickers (name, alt, blob_hash, content_type, size, width, height, uploader_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id, created_at`,
		name, alt, hash, contentType, size, width, height, session.UserID,
	).Scan(&info.ID, &info.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "there is already a sticker called "+name)
			return
		}
		slog.Error("adding sticker", "err", err)
		writeError(w, http.StatusInternalServerError, "could not add the sticker")
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO moderation_log (actor_id, action, subject_id, detail)
		 VALUES ($1, 'add_sticker', $2, $3)`, session.UserID, info.ID, name); err != nil {
		slog.Error("recording sticker in moderation log", "err", err)
		writeError(w, http.StatusInternalServerError, "could not add the sticker")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Error("committing sticker", "err", err)
		writeError(w, http.StatusInternalServerError, "could not add the sticker")
		return
	}
	slog.Info("sticker added", "actor_id", session.UserID, "sticker_id", info.ID, "name", name)
	a.notifyStickersChanged()
	writeJSON(w, http.StatusCreated, info)
}

type stickerEdit struct {
	Name *string `json:"name"`
	Alt  *string `json:"alt"`
}

// editSticker renames a sticker or changes its description. Messages
// carry the id, not the name, so a rename changes nothing already sent.
func (a *API) editSticker(w http.ResponseWriter, r *http.Request) {
	var req stickerEdit
	if !decodeJSON(w, r, &req) {
		return
	}
	var name, alt *string
	if req.Name != nil {
		n, err := cleanStickerName(*req.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		name = &n
	}
	if req.Alt != nil {
		v, err := cleanStickerAlt(*req.Alt)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		alt = &v
	}
	tag, err := a.pool.Exec(r.Context(),
		`UPDATE stickers SET name = COALESCE($2, name), alt = COALESCE($3, alt) WHERE id = $1`,
		r.PathValue("id"), name, alt)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "there is already a sticker called "+*name)
			return
		}
		slog.Error("editing sticker", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the sticker")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "sticker not found")
		return
	}
	a.notifyStickersChanged()
	w.WriteHeader(http.StatusNoContent)
}

// deleteSticker removes a sticker for good. Messages that sent it show
// "sticker removed"; the blob collector frees the bytes once nothing
// else uses them.
func (a *API) deleteSticker(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	var name string
	err := a.pool.QueryRow(r.Context(),
		`DELETE FROM stickers WHERE id = $1 RETURNING name`, r.PathValue("id")).Scan(&name)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "sticker not found")
		return
	case err != nil:
		slog.Error("deleting sticker", "err", err)
		writeError(w, http.StatusInternalServerError, "could not remove the sticker")
		return
	}
	if _, err := a.pool.Exec(r.Context(),
		`INSERT INTO moderation_log (actor_id, action, subject_id, detail)
		 VALUES ($1, 'delete_sticker', $2, $3)`, session.UserID, r.PathValue("id"), name); err != nil {
		slog.Error("recording sticker removal", "err", err)
	}
	slog.Info("sticker removed", "actor_id", session.UserID, "sticker_id", r.PathValue("id"), "name", name)
	a.notifyStickersChanged()
	w.WriteHeader(http.StatusNoContent)
}

// putStickerLimits: administrator only (the route checks).
func (a *API) putStickerLimits(w http.ResponseWriter, r *http.Request) {
	var req stickerLimits
	if !decodeJSON(w, r, &req) {
		return
	}
	switch {
	case req.MaxBytes < stickerBytesMin || req.MaxBytes > stickerBytesMax:
		writeError(w, http.StatusBadRequest, "the size limit must be between 16 KB and 10 MB")
		return
	case req.MaxPx < stickerPxMin || req.MaxPx > stickerPxMax:
		writeError(w, http.StatusBadRequest, "the pixel limit must be between 64 and 2048")
		return
	case req.MaxCount < stickerCountMin || req.MaxCount > stickerCountMax:
		writeError(w, http.StatusBadRequest, "the sticker count must be between 1 and 1000")
		return
	}
	// Lowering a limit never removes stickers already there; it applies
	// to new uploads only.
	if _, err := a.pool.Exec(r.Context(),
		`UPDATE server_settings
		    SET sticker_max_bytes = $1, sticker_max_px = $2, sticker_max_count = $3`,
		req.MaxBytes, req.MaxPx, req.MaxCount); err != nil {
		slog.Error("saving sticker limits", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the limits")
		return
	}
	slog.Info("sticker limits changed", "actor_id", sessionFrom(r.Context()).UserID,
		"max_bytes", req.MaxBytes, "max_px", req.MaxPx, "max_count", req.MaxCount)
	a.notifyStickersChanged()
	writeJSON(w, http.StatusOK, req)
}

type stickersChangedEvent struct {
	Type string `json:"type"`
}

// notifyStickersChanged tells every client to refetch the sticker list.
// Carries nothing: the list is small and the same for everyone.
func (a *API) notifyStickersChanged() {
	a.emitAll(stickersChangedEvent{Type: "stickers_changed"})
}

// formatBytes: "1 MB", "512 KB".
func formatBytes(n int) string {
	if n >= 1024*1024 && n%(1024*1024) == 0 {
		return fmt.Sprintf("%d MB", n/(1024*1024))
	}
	if n >= 1024*1024 {
		return fmt.Sprintf("%.1f MB", float64(n)/(1024*1024))
	}
	return fmt.Sprintf("%d KB", n/1024)
}
