// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/keystore"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// User avatars (migration 0037; decisions.md Feature decisions, "User
// avatars and profiles", stage 1). Each account may set one picture in
// Settings, Profile; everyone signed in to this server sees it wherever
// a letter circle would be. Moderators (delete_messages, and only over
// lower ranks, like bans) can remove one, which goes in the moderation
// log.
//
// The picture is visible to the whole server, so the server can read it
// (like a username), but it is stored sealed under the account's keystore
// key: deleting the account destroys the key, so the picture can't be
// recovered from a database backup either.

const (
	// The browser crops and shrinks to 256 x 256 before upload; these
	// leave room for a larger export, nothing more (the server icon's
	// limits).
	avatarMaxBytes = 512 * 1024
	avatarMaxPx    = 1024
)

type avatarsChangedEvent struct {
	Type   string `json:"type"`
	UserID string `json:"user_id"`
	// Version is the new picture's version, or null when it was removed.
	Version *int64 `json:"version"`
}

// avatarSealContext binds the sealed picture to its account, so bytes
// copied onto another account's row fail to open.
func avatarSealContext(userID string) []byte {
	return []byte("openvoxa/avatar/v1\x00" + userID)
}

// listAvatars: anyone signed in. {"users": {"<user id>": <version>}} for
// every account with a picture; clients fetch the pictures they show.
func (a *API) listAvatars(w http.ResponseWriter, r *http.Request) {
	rows, err := a.pool.Query(r.Context(),
		`SELECT v.user_id, v.version FROM user_avatars v
		   JOIN users u ON u.id = v.user_id
		  WHERE u.deleted_at IS NULL`)
	if err != nil {
		slog.Error("listing avatars", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list the avatars")
		return
	}
	defer rows.Close()
	users := map[string]int64{}
	for rows.Next() {
		var id string
		var v int64
		if err := rows.Scan(&id, &v); err != nil {
			slog.Error("reading avatars", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list the avatars")
			return
		}
		users[id] = v
	}
	if err := rows.Err(); err != nil {
		slog.Error("reading avatars", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list the avatars")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

// getAvatar: anyone signed in. The picture's bytes, under the same
// defences as stickers and the server icon (type checked from the bytes
// at upload, nosniff, sandboxed). A request naming the current version
// may be cached for good (privately: it needs a session).
func (a *API) getAvatar(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	var (
		sealed      []byte
		contentType string
		version     int64
	)
	err := a.pool.QueryRow(r.Context(),
		`SELECT v.image, v.image_type, v.version FROM user_avatars v
		   JOIN users u ON u.id = v.user_id
		  WHERE v.user_id = $1 AND u.deleted_at IS NULL`, userID,
	).Scan(&sealed, &contentType, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "this account has no avatar")
		return
	}
	if err != nil {
		slog.Error("loading avatar", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the avatar")
		return
	}
	data, err := a.keys.Open(userID, sealed, avatarSealContext(userID))
	if err != nil {
		if errors.Is(err, keystore.ErrNoKey) {
			writeError(w, http.StatusNotFound, "this account has no avatar")
			return
		}
		slog.Error("opening sealed avatar", "err", err, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "could not fetch the avatar")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if r.URL.Query().Get("v") == strconv.FormatInt(version, 10) {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// putOwnAvatar: the caller's own picture. The body is the image itself
// (PNG or WebP, square, static, at most avatarMaxPx), not a form.
func (a *API) putOwnAvatar(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	tooBig := "the picture is too large; it can be at most " + formatBytes(avatarMaxBytes)
	if r.ContentLength > avatarMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, avatarMaxBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read the picture")
		return
	}
	if len(data) > avatarMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	contentType, width, height, err := stickerImage(data)
	if err != nil || (contentType != "image/png" && contentType != "image/webp") {
		writeError(w, http.StatusBadRequest, "the picture must be a PNG or WebP image")
		return
	}
	if width != height {
		writeError(w, http.StatusBadRequest, "the picture must be square")
		return
	}
	if width > avatarMaxPx {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"the picture is %d x %d pixels; it can be at most %d x %d", width, height, avatarMaxPx, avatarMaxPx))
		return
	}
	if imageAnimated(data) {
		writeError(w, http.StatusBadRequest, "animated pictures can't be avatars")
		return
	}
	sealed, err := a.keys.Seal(session.UserID, data, avatarSealContext(session.UserID))
	if err != nil {
		slog.Error("sealing avatar", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the picture")
		return
	}
	var version int64
	if err := a.pool.QueryRow(r.Context(),
		`INSERT INTO user_avatars (user_id, image, image_type) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE
		   SET image = EXCLUDED.image, image_type = EXCLUDED.image_type,
		       version = nextval('user_avatar_version_seq'), updated_at = now()
		 RETURNING version`,
		session.UserID, sealed, contentType,
	).Scan(&version); err != nil {
		slog.Error("saving avatar", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the picture")
		return
	}
	slog.Info("avatar set", "user_id", session.UserID, "bytes", len(data))
	a.emitAll(avatarsChangedEvent{Type: "avatars_changed", UserID: session.UserID, Version: &version})
	writeJSON(w, http.StatusOK, map[string]int64{"version": version})
}

// deleteOwnAvatar: back to the letter.
func (a *API) deleteOwnAvatar(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	tag, err := a.pool.Exec(r.Context(), `DELETE FROM user_avatars WHERE user_id = $1`, session.UserID)
	if err != nil {
		slog.Error("removing avatar", "err", err)
		writeError(w, http.StatusInternalServerError, "could not remove the picture")
		return
	}
	if tag.RowsAffected() > 0 {
		slog.Info("avatar removed", "user_id", session.UserID, "by", "self")
		a.emitAll(avatarsChangedEvent{Type: "avatars_changed", UserID: session.UserID})
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeAvatar: moderators (delete_messages; the route checks) remove
// someone else's picture, logged. The rank rule is the ban's: only over
// people below your own rank, so moderators can't strip each other.
func (a *API) removeAvatar(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")
	const fail = "could not remove the avatar"
	if subjectID == actor.UserID {
		// Your own goes through Settings, unlogged.
		a.deleteOwnAvatar(w, r)
		return
	}
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting avatar removal", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())

	rank, err := subjectRank(r.Context(), tx, subjectID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "user not found")
		return
	case err != nil:
		slog.Error("loading subject for avatar removal", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if !perm.Outranks(actor.Rank, rank) {
		writeError(w, http.StatusForbidden, "you cannot remove the avatar of someone at or above your own rank")
		return
	}
	tag, err := tx.Exec(r.Context(), `DELETE FROM user_avatars WHERE user_id = $1`, subjectID)
	if err != nil {
		slog.Error("removing avatar", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if tag.RowsAffected() == 0 {
		// Already gone (removed by its owner or another moderator).
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO moderation_log (actor_id, action, subject_id) VALUES ($1, 'remove_avatar', $2)`,
		actor.UserID, subjectID); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing avatar removal", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	slog.Info("avatar removed", "user_id", subjectID, "by", actor.UserID)
	a.emitAll(avatarsChangedEvent{Type: "avatars_changed", UserID: subjectID})
	w.WriteHeader(http.StatusNoContent)
}

// imageAnimated reports whether a PNG or WebP (already checked by
// stickerImage) is animated: an APNG (an acTL chunk before the first
// IDAT) or a WebP with the VP8X animation flag. Avatars are static only.
func imageAnimated(b []byte) bool {
	if len(b) >= 21 && string(b[:4]) == "RIFF" && string(b[12:16]) == "VP8X" {
		return b[20]&0x02 != 0
	}
	if len(b) < 8 || !bytes.Equal(b[:8], []byte("\x89PNG\r\n\x1a\n")) {
		return false
	}
	for i := 8; i+8 <= len(b); {
		n := int(binary.BigEndian.Uint32(b[i : i+4]))
		switch string(b[i+4 : i+8]) {
		case "acTL":
			return true
		case "IDAT", "IEND":
			return false
		}
		// length, type, data, CRC
		next := i + 12 + n
		if n < 0 || next <= i {
			return false
		}
		i = next
	}
	return false
}
