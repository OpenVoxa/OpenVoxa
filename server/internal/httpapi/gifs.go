// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/gif"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

const gifMediaTTL = 2 * time.Hour

// gifResult is a search hit as the client sees it. Provider URLs are never
// exposed: both image links point back at this server.
type gifResult struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	PreviewURL  string `json:"preview_url"`
	Width       int    `json:"width,omitempty"`
	Height      int    `json:"height,omitempty"`

	// Opaque signed handle for the full-size image, spent when the user
	// picks this GIF.
	Token string `json:"token"`
}

type gifSearchResponse struct {
	Provider    string      `json:"provider"`
	Attribution string      `json:"attribution"`
	Results     []gifResult `json:"results"`
}

// signMedia wraps a provider URL in a signed, expiring token.
//
// The client is handed this rather than the provider's own link, which
// keeps user addresses out of Giphy's and Tenor's logs. The signature also
// means the media proxy cannot be pointed at a URL of the caller's
// choosing: it only serves URLs this server produced.
func (a *API) signMedia(raw string) string {
	exp := time.Now().Add(gifMediaTTL).Unix()
	payload := strconv.FormatInt(exp, 10) + "|" + raw

	mac := hmac.New(sha256.New, a.attachKey)
	mac.Write([]byte(payload))

	return base64.RawURLEncoding.EncodeToString([]byte(payload)) +
		"." + hex.EncodeToString(mac.Sum(nil))
}

func (a *API) verifyMedia(token string) (string, bool) {
	encoded, sig, found := strings.Cut(token, ".")
	if !found {
		return "", false
	}

	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", false
	}

	mac := hmac.New(sha256.New, a.attachKey)
	mac.Write(payload)

	want, err := hex.DecodeString(sig)
	if err != nil || !hmac.Equal(mac.Sum(nil), want) {
		return "", false
	}

	expStr, raw, found := strings.Cut(string(payload), "|")
	if !found {
		return "", false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}

	return raw, true
}

// searchGifs proxies a query to the configured provider.
func (a *API) searchGifs(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	if !a.gifs.Enabled() {
		writeError(w, http.StatusServiceUnavailable,
			"GIF search is not enabled on this server")
		return
	}

	if !a.gifLimit.Allow(session.UserID) {
		writeTooManyRequests(w, a.gifLimit.RetryAfter(session.UserID))
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 100 {
		query = query[:100]
	}

	results, err := a.gifs.Search(r.Context(), query, 24)
	if err != nil {
		slog.Warn("gif search failed", "err", err)
		writeError(w, http.StatusBadGateway, "could not reach the GIF provider")
		return
	}

	out := gifSearchResponse{
		Provider:    a.gifs.Provider(),
		Attribution: a.gifs.Attribution(),
		Results:     make([]gifResult, 0, len(results)),
	}

	for _, res := range results {
		out.Results = append(out.Results, gifResult{
			ID:          res.ID,
			Description: res.Description,
			PreviewURL:  "/api/v1/gifs/media?t=" + a.signMedia(res.PreviewURL),
			Width:       res.Width,
			Height:      res.Height,
			Token:       a.signMedia(res.FullURL),
		})
	}

	writeJSON(w, http.StatusOK, out)
}

// proxyGifMedia streams a provider image through this server.
//
// No session required, for the same reason attachment downloads need none:
// a browser will not attach an Authorization header to an <img src>. The
// signed token is the authorisation, and it only ever covers URLs this
// server minted.
func (a *API) proxyGifMedia(w http.ResponseWriter, r *http.Request) {
	raw, ok := a.verifyMedia(r.URL.Query().Get("t"))
	if !ok {
		writeError(w, http.StatusForbidden, "link is invalid or has expired")
		return
	}

	body, contentType, err := a.gifs.FetchMedia(r.Context(), raw)
	if err != nil {
		if errors.Is(err, gif.ErrBadHost) {
			writeError(w, http.StatusBadRequest, "not a permitted media host")
			return
		}
		slog.Warn("gif media fetch failed", "err", err)
		writeError(w, http.StatusBadGateway, "could not fetch the image")
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")

	if _, err := io.Copy(w, io.LimitReader(body, a.maxAttachment)); err != nil {
		slog.Debug("gif proxy copy ended", "err", err)
	}
}

type sendGifRequest struct {
	Token       string `json:"token"`
	Description string `json:"description"`
}

// attachGif downloads a chosen GIF once and stores it as an ordinary
// attachment.
//
// This is the part that matters. A GIF posted to a channel becomes a file
// in our own blob store, so it is deduplicated, governed by the channel's
// retention policy, destroyed when the message is deleted, and served from
// here. Linking to the provider's CDN instead would mean every viewer, for
// as long as the message exists, quietly tells Giphy they are reading this
// channel.
func (a *API) attachGif(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	channelID := r.PathValue("id")

	if !a.gifs.Enabled() {
		writeError(w, http.StatusServiceUnavailable,
			"GIF search is not enabled on this server")
		return
	}

	var req sendGifRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	raw, ok := a.verifyMedia(req.Token)
	if !ok {
		writeError(w, http.StatusForbidden, "that GIF link has expired; search again")
		return
	}

	// Same posting permission as any other attachment.
	role, err := perm.Parse(session.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", session.Role)
		writeError(w, http.StatusInternalServerError, "could not attach the GIF")
		return
	}

	var (
		minPost   string
		encrypted bool
	)
	err = a.pool.QueryRow(r.Context(),
		`SELECT min_role_post, encrypted FROM channels WHERE id = $1`, channelID,
	).Scan(&minPost, &encrypted)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "channel not found")
		return
	case err != nil:
		slog.Error("looking up channel for gif", "err", err)
		writeError(w, http.StatusInternalServerError, "could not attach the GIF")
		return
	}

	postRole, err := perm.Parse(minPost)
	if err != nil || !perm.AtLeast(role, postRole) {
		writeError(w, http.StatusForbidden, "you cannot post in this channel")
		return
	}

	// The server fetches and stores the GIF itself, so it would hold the
	// chosen image in the clear in a channel that promises it cannot read
	// content. Refused until the picker can hand the bytes to the client
	// for encryption; even then the server proxies the search and sees
	// the query, which is recorded in decisions.md.
	if encrypted {
		writeError(w, http.StatusBadRequest, "GIFs are not available in encrypted channels yet")
		return
	}

	if !a.uploadLimit.Allow(session.UserID) {
		writeTooManyRequests(w, a.uploadLimit.RetryAfter(session.UserID))
		return
	}

	body, _, err := a.gifs.FetchMedia(r.Context(), raw)
	if err != nil {
		slog.Warn("gif download failed", "err", err)
		writeError(w, http.StatusBadGateway, "could not download that GIF")
		return
	}
	defer body.Close()

	hash, size, err := a.blobs.Put(body, a.maxAttachment)
	if err != nil {
		slog.Error("storing gif", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the GIF")
		return
	}

	filename := safeFilename(strings.TrimSpace(req.Description))
	if filename == "file" || filename == "" {
		filename = "animated"
	}
	filename += ".gif"

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting gif transaction", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the GIF")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(),
		`INSERT INTO blobs (hash, size) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING`,
		hash, size,
	); err != nil {
		slog.Error("recording gif blob", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the GIF")
		return
	}

	var info attachmentInfo
	err = tx.QueryRow(r.Context(),
		`INSERT INTO attachments
		     (channel_id, uploader_id, blob_hash, filename, content_type, size)
		 VALUES ($1, $2, $3, $4, 'image/gif', $5)
		 RETURNING id, filename, content_type, size`,
		channelID, session.UserID, hash, filename, size,
	).Scan(&info.ID, &info.Filename, &info.ContentType, &info.Size)
	if err != nil {
		slog.Error("recording gif attachment", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the GIF")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing gif attachment", "err", err)
		writeError(w, http.StatusInternalServerError, "could not store the GIF")
		return
	}

	info.URL = a.signAttachmentURL(info.ID)
	writeJSON(w, http.StatusCreated, info)
}

type gifConfigResponse struct {
	Enabled     bool   `json:"enabled"`
	Provider    string `json:"provider"`
	Attribution string `json:"attribution"`
}

// gifConfig lets a client know whether to show the GIF button at all.
func (a *API) gifConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, gifConfigResponse{
		Enabled:     a.gifs.Enabled(),
		Provider:    a.gifs.Provider(),
		Attribution: a.gifs.Attribution(),
	})
}
