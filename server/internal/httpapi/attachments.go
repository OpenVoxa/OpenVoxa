// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/blob"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// Types we are willing to render inline in a browser.
//
// Everything else is served as an octet-stream with an attachment
// disposition, which makes the browser download it rather than interpret
// it. The distinction matters: an uploaded HTML file served inline is
// stored cross-site scripting against your own origin.
//
// SVG is deliberately absent. It is an image to users and a scriptable
// document to browsers, and serving it inline is the same vulnerability
// wearing a friendlier extension.
var inlineTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
	"audio/mpeg": true,
	"audio/ogg":  true,
	"audio/wav":  true,
	"video/mp4":  true,
	"video/webm": true,
}

type attachmentInfo struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

// uploadAttachment accepts one file and holds it until a message claims it.
//
// Upload happens before the message is sent so an oversized or rejected
// file fails before the user has composed anything, and so the client can
// show progress. An upload nobody claims is swept after an hour.
func (a *API) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	channelID := r.PathValue("id")

	// Posting an attachment is posting. Someone who may not write in a
	// channel may not put files in it either.
	role, err := perm.Parse(session.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", session.Role)
		writeError(w, http.StatusInternalServerError, "could not upload")
		return
	}

	var minPost string
	err = a.pool.QueryRow(r.Context(),
		`SELECT min_role_post FROM channels WHERE id = $1`, channelID,
	).Scan(&minPost)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "channel not found")
		return
	case err != nil:
		slog.Error("looking up channel for upload", "err", err)
		writeError(w, http.StatusInternalServerError, "could not upload")
		return
	}

	postRole, err := perm.Parse(minPost)
	if err != nil || !perm.AtLeast(role, postRole) {
		writeError(w, http.StatusForbidden, "you cannot post in this channel")
		return
	}

	if !a.uploadLimit.Allow(session.UserID) {
		writeTooManyRequests(w, a.uploadLimit.RetryAfter(session.UserID))
		return
	}

	// Cap the request body independently of the multipart parser, so a
	// client cannot stream gigabytes before the limit is noticed.
	r.Body = http.MaxBytesReader(w, r.Body, a.maxAttachment+1024*1024)

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected a multipart form with a 'file' field")
		return
	}
	defer file.Close()

	hash, size, err := a.blobs.Put(file, a.maxAttachment)
	if err != nil {
		if errors.Is(err, blob.ErrTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("file exceeds the %d MiB limit", a.maxAttachment/(1024*1024)))
			return
		}
		slog.Error("storing attachment", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the file")
		return
	}

	filename := safeFilename(header.Filename)
	contentType := detectType(header.Header.Get("Content-Type"), filename)

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting attachment transaction", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the file")
		return
	}
	defer tx.Rollback(r.Context())

	// The blob may already exist from an earlier identical upload.
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO blobs (hash, size) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING`,
		hash, size,
	); err != nil {
		slog.Error("recording blob", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the file")
		return
	}

	var info attachmentInfo
	err = tx.QueryRow(r.Context(),
		`INSERT INTO attachments
		     (channel_id, uploader_id, blob_hash, filename, content_type, size)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, filename, content_type, size`,
		channelID, session.UserID, hash, filename, contentType, size,
	).Scan(&info.ID, &info.Filename, &info.ContentType, &info.Size)
	if err != nil {
		slog.Error("recording attachment", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the file")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing attachment", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the file")
		return
	}

	writeJSON(w, http.StatusCreated, info)
}

// downloadAttachment serves a stored file to anyone who may view its
// channel.
func (a *API) downloadAttachment(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	role, err := perm.Parse(session.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", session.Role)
		writeError(w, http.StatusInternalServerError, "could not fetch the file")
		return
	}

	var (
		hash        []byte
		filename    string
		contentType string
		size        int64
		minView     string
	)

	err = a.pool.QueryRow(r.Context(),
		`SELECT at.blob_hash, at.filename, at.content_type, at.size, c.min_role_view
		   FROM attachments at
		   JOIN channels c ON c.id = at.channel_id
		  WHERE at.id = $1`,
		r.PathValue("id"),
	).Scan(&hash, &filename, &contentType, &size, &minView)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	case err != nil:
		slog.Error("looking up attachment", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the file")
		return
	}

	viewRole, err := perm.Parse(minView)
	if err != nil || !perm.AtLeast(role, viewRole) {
		// Same 404 as a missing attachment: a file in a channel you
		// cannot see should not be confirmed to exist.
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	}

	f, err := a.blobs.Open(hash)
	if err != nil {
		slog.Error("opening blob", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the file")
		return
	}
	defer f.Close()

	disposition := "attachment"
	served := "application/octet-stream"
	if inlineTypes[contentType] {
		disposition = "inline"
		served = contentType
	}

	w.Header().Set("Content-Type", served)
	// Without this a browser may sniff the bytes, decide an
	// octet-stream is really HTML, and render it anyway.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition",
		mime.FormatMediaType(disposition, map[string]string{"filename": filename}))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=86400")

	// ServeContent handles range requests, which media playback needs.
	http.ServeContent(w, r, filename, time.Time{}, f)
}

// safeFilename keeps a label the uploader will recognise while removing
// anything that could be interpreted as a path. The stored location comes
// from the content hash, so this is about what gets shown and what a
// browser saves it as, not about where it lands on our disk.
func safeFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '"' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)

	if name == "" || name == "." || name == ".." {
		return "file"
	}
	if utf8.RuneCountInString(name) > 120 {
		runes := []rune(name)
		name = string(runes[:120])
	}
	return name
}

// detectType trusts the extension over the client's claim, because the
// claim is attacker-controlled and the extension at least matches what the
// user will see. Anything unrecognised becomes an octet-stream, which is
// the safe default: it will be downloaded rather than rendered.
func detectType(claimed, filename string) string {
	if byExt := mime.TypeByExtension(filepath.Ext(filename)); byExt != "" {
		if base, _, err := mime.ParseMediaType(byExt); err == nil {
			return base
		}
	}
	if base, _, err := mime.ParseMediaType(claimed); err == nil && inlineTypes[base] {
		return base
	}
	return "application/octet-stream"
}
