// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/openvoxa/openvoxa/server/internal/unfurl"
)

type unfurlRequest struct {
	URL string `json:"url"`
}

// unfurlLink returns preview metadata for a single URL.
//
// Authenticated, and rate limited per user rather than per IP: this
// endpoint makes the server perform outbound requests, so it is the one
// place where an authenticated user can spend someone else's bandwidth.
//
// The client extracts URLs from message text locally and asks for each
// one. The server therefore sees which links are shared but never sees
// message bodies, and readers' addresses never reach the linked site.
func (a *API) unfurlLink(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	if !a.unfurlLimit.Allow(session.UserID) {
		writeTooManyRequests(w, a.unfurlLimit.RetryAfter(session.UserID))
		return
	}

	var req unfurlRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	preview, err := a.unfurl.Fetch(r.Context(), req.URL)
	if err != nil {
		switch {
		case errors.Is(err, unfurl.ErrBlocked):
			// Deliberately vague. A precise answer would turn this
			// endpoint into a port scanner for the server's own network.
			writeError(w, http.StatusBadRequest, "could not fetch that link")
		case errors.Is(err, unfurl.ErrBadScheme):
			writeError(w, http.StatusBadRequest, "only http and https links can be previewed")
		case errors.Is(err, unfurl.ErrNotHTML):
			writeError(w, http.StatusUnsupportedMediaType, "link is not a web page")
		default:
			slog.Warn("unfurl failed", "url", req.URL, "err", err)
			writeError(w, http.StatusBadGateway, "could not fetch that link")
		}
		return
	}

	writeJSON(w, http.StatusOK, preview)
}
