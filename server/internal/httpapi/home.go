// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// The Home page and community rules (migration 0034; decisions.md
// Feature decisions, "Home page and community rules").
//
// Home is a banner, a Welcome text and a Rules text, written by
// administrators in Server settings, General. Members read it; the
// banner alone is public, because the sign-in page shows it.
//
// With rules_enforced on, an account whose rules_accepted_version is
// below rules_version is held: requireAuth refuses everything except
// rulesHoldAllowed, the same way the two-factor setup hold works, and
// the client shows only the rules with Accept and Sign out. Turning
// enforcement on, or saving changed rules with "ask everyone again",
// closes the held accounts' sockets and takes them out of voice, so the
// hold applies at once rather than on their next request.

const (
	homeTextMax = 8000 // characters, for each of welcome and rules

	// The administrator's browser crops the banner to 1600 px wide;
	// these leave room for a larger export, nothing more.
	serverBannerMaxBytes = 2 * 1024 * 1024
	serverBannerMaxPx    = 2400
)

// bannerShapeOK accepts 16:9 (the tallest) to 4:1 (the thinnest), with a
// little slack for rounding in the crop.
func bannerShapeOK(width, height int) bool {
	if width <= 0 || height <= 0 {
		return false
	}
	r := float64(width) / float64(height)
	return r >= 16.0/9.0*0.98 && r <= 4.0*1.02
}

type homeChangedEvent struct {
	Type string `json:"type"`
}

type homeResponse struct {
	Welcome string `json:"welcome"`
	Rules   string `json:"rules"`
	// Version goes up with every change to the welcome, rules or banner;
	// SeenVersion is what this account last opened.
	Version     int `json:"version"`
	SeenVersion int `json:"seen_version"`
	// Banner is a path on this server, with the version in it, or null.
	Banner               *string `json:"banner"`
	RulesEnforced        bool    `json:"rules_enforced"`
	RulesVersion         int     `json:"rules_version"`
	RulesAcceptedVersion int     `json:"rules_accepted_version"`
}

func bannerPath(version int) string {
	return "/api/v1/server-banner?v=" + strconv.Itoa(version)
}

// getHome: any signed-in account, held at the rules or not.
func (a *API) getHome(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var (
		out           homeResponse
		hasBanner     bool
		bannerVersion int
	)
	if err := a.pool.QueryRow(r.Context(),
		`SELECT st.home_welcome, st.home_rules, st.home_version, u.home_seen_version,
		        st.banner IS NOT NULL, st.banner_version,
		        st.rules_enforced, st.rules_version, u.rules_accepted_version
		   FROM server_settings st, users u
		  WHERE u.id = $1`, s.UserID,
	).Scan(&out.Welcome, &out.Rules, &out.Version, &out.SeenVersion,
		&hasBanner, &bannerVersion,
		&out.RulesEnforced, &out.RulesVersion, &out.RulesAcceptedVersion); err != nil {
		slog.Error("loading home", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load the home page")
		return
	}
	if hasBanner {
		p := bannerPath(bannerVersion)
		out.Banner = &p
	}
	w.Header().Set("Cache-Control", "no-cache")
	writeJSON(w, http.StatusOK, out)
}

// markHomeSeen: {"version": n}. Records that this account has seen Home
// up to n (never past the current version, never backwards).
func (a *API) markHomeSeen(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var req struct {
		Version int `json:"version"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if _, err := a.pool.Exec(r.Context(),
		`UPDATE users SET home_seen_version = LEAST($2, (SELECT home_version FROM server_settings))
		  WHERE id = $1 AND home_seen_version < $2`, s.UserID, req.Version); err != nil {
		slog.Error("marking home seen", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// acceptRules: {"version": n}, the rules version the person read. A
// stale number (the rules were changed meanwhile) is refused, so nobody
// accepts rules they haven't seen.
func (a *API) acceptRules(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var req struct {
		Version int `json:"version"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	tag, err := a.pool.Exec(r.Context(),
		`UPDATE users SET rules_accepted_version = $2
		  WHERE id = $1 AND $2 = (SELECT rules_version FROM server_settings)`, s.UserID, req.Version)
	if err != nil {
		slog.Error("accepting rules", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "the rules were just changed: read them again")
		return
	}
	slog.Info("rules accepted", "user_id", s.UserID, "version", req.Version)
	w.WriteHeader(http.StatusNoContent)
}

// cleanHomeText trims a Welcome or Rules text and checks its length.
// Line breaks are kept (normalised to \n); other control characters
// except tab are refused.
func cleanHomeText(s, what string) (string, error) {
	if !utf8.ValidString(s) {
		return "", fmt.Errorf("the %s is not valid text", what)
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > homeTextMax {
		return "", fmt.Errorf("the %s can be at most %d characters", what, homeTextMax)
	}
	for _, c := range s {
		if c < 0x20 && c != '\n' && c != '\t' || c == 0x7f {
			return "", fmt.Errorf("the %s can't contain control characters", what)
		}
	}
	return s, nil
}

type putHomeRequest struct {
	Welcome       *string `json:"welcome"`
	Rules         *string `json:"rules"`
	RulesEnforced *bool   `json:"rules_enforced"`
	// AskAgain: everyone must accept the changed rules again. Only
	// meaningful when the rules text changed and enforcement is on.
	AskAgain bool `json:"ask_again"`
}

// putHome: administrators. All three fields are required: the General
// tab always sends what it shows.
func (a *API) putHome(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := sessionFrom(ctx)
	var req putHomeRequest
	if !decodeJSONLimit(w, r, &req, 256*1024) {
		return
	}
	if req.Welcome == nil || req.Rules == nil || req.RulesEnforced == nil {
		writeError(w, http.StatusBadRequest, "welcome, rules and rules_enforced are required")
		return
	}
	welcome, err := cleanHomeText(*req.Welcome, "welcome text")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rules, err := cleanHomeText(*req.Rules, "rules")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	enforced := *req.RulesEnforced
	if enforced && rules == "" {
		writeError(w, http.StatusBadRequest, "write the rules before requiring everyone to accept them")
		return
	}

	const fail = "could not save the home page"
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		slog.Error("starting home transaction", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(ctx)

	var (
		oldWelcome, oldRules string
		oldEnforced          bool
		rulesVersion         int
	)
	if err := tx.QueryRow(ctx,
		`SELECT home_welcome, home_rules, rules_enforced, rules_version
		   FROM server_settings FOR UPDATE`,
	).Scan(&oldWelcome, &oldRules, &oldEnforced, &rulesVersion); err != nil {
		slog.Error("loading home", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	welcomeChanged := welcome != oldWelcome
	rulesChanged := rules != oldRules
	askAgain := req.AskAgain && rulesChanged && enforced
	if !welcomeChanged && !rulesChanged && enforced == oldEnforced {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if askAgain {
		rulesVersion++
	}

	if _, err := tx.Exec(ctx,
		`UPDATE server_settings
		    SET home_welcome = $1, home_rules = $2, rules_enforced = $3, rules_version = $4,
		        home_version = home_version + CASE WHEN $5 THEN 1 ELSE 0 END`,
		welcome, rules, enforced, rulesVersion, welcomeChanged || rulesChanged); err != nil {
		slog.Error("saving home", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	// The administrator who saves has read the rules they saved (or
	// turned on), so is never held by their own change.
	if _, err := tx.Exec(ctx,
		`UPDATE users SET rules_accepted_version = $2 WHERE id = $1`, actor.UserID, rulesVersion); err != nil {
		slog.Error("accepting own rules", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}

	type entry struct{ action, detail string }
	var log []entry
	switch {
	case welcomeChanged && rulesChanged:
		log = append(log, entry{"set_home", "welcome and rules"})
	case welcomeChanged:
		log = append(log, entry{"set_home", "welcome"})
	case rulesChanged:
		log = append(log, entry{"set_home", "rules"})
	}
	if enforced != oldEnforced {
		log = append(log, entry{"enforce_rules", map[bool]string{true: "on", false: "off"}[enforced]})
	}
	if askAgain {
		log = append(log, entry{"ask_rules_again", ""})
	}
	for _, e := range log {
		if _, err := tx.Exec(ctx,
			`INSERT INTO moderation_log (actor_id, action, detail) VALUES ($1, $2, $3)`,
			actor.UserID, e.action, e.detail); err != nil {
			slog.Error("recording moderation action", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}

	// Who is now held at the rules: only when this save started holding
	// people (enforcement turned on, or everyone asked again).
	var held []string
	if enforced && (!oldEnforced || askAgain) {
		rows, err := tx.Query(ctx,
			`SELECT id::text FROM users
			  WHERE deleted_at IS NULL AND rules_accepted_version < $1 AND id <> $2`,
			rulesVersion, actor.UserID)
		if err != nil {
			slog.Error("finding accounts held at the rules", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
		held, err = pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			slog.Error("finding accounts held at the rules", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		slog.Error("committing home", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.emitAll(homeChangedEvent{Type: "home_changed"})
	a.holdAtRules(held)
	slog.Info("home page saved", "actor_id", actor.UserID, "welcome_changed", welcomeChanged,
		"rules_changed", rulesChanged, "rules_enforced", enforced, "ask_again", askAgain,
		"held_at_rules", len(held))
	w.WriteHeader(http.StatusNoContent)
}

// holdAtRules makes a new rules hold take effect at once for accounts
// that are signed in: their event sockets close (the client reconnects,
// is refused with rules_acceptance_required and shows the rules), and
// they leave every voice call, which a LiveKit token alone would not
// make them do (see kickFromLostVoice).
func (a *API) holdAtRules(userIDs []string) {
	if len(userIDs) == 0 {
		return
	}
	held := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		held[id] = true
		a.hub.DisconnectUser(id)
	}
	if a.livekit.APIKey == "" || a.livekit.APISecret == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		rows, err := a.pool.Query(ctx, `SELECT id::text FROM channels WHERE kind = 'voice'`)
		if err != nil {
			slog.Error("listing voice channels", "err", err)
			return
		}
		rooms, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			slog.Error("listing voice channels", "err", err)
			return
		}
		for _, room := range rooms {
			people, err := a.listParticipants(ctx, room)
			if err != nil {
				slog.Error("listing voice participants", "err", err, "channel_id", room)
				continue
			}
			for _, userID := range people {
				if !held[userID] {
					continue
				}
				if removed, err := a.removeParticipant(ctx, room, userID); err != nil {
					slog.Error("removing voice participant", "err", err,
						"channel_id", room, "user_id", userID)
				} else if removed {
					a.notifyVoiceChanged(room)
					slog.Info("removed from voice until the rules are accepted",
						"channel_id", room, "user_id", userID)
				}
			}
		}
	}()
}

// rulesHoldAllowed is what an account held at the rules may still do:
// unlock its storage (unlock-secret, device-secrets, as the two-factor
// hold allows), read Home, accept, and sign out.
func rulesHoldAllowed(r *http.Request) bool {
	p := r.URL.Path
	return (r.Method == http.MethodGet && p == "/api/v1/me") ||
		p == "/api/v1/me/unlock-secret" ||
		strings.HasPrefix(p, "/api/v1/me/device-secrets") ||
		p == "/api/v1/auth/logout" ||
		(r.Method == http.MethodGet && p == "/api/v1/home") ||
		p == "/api/v1/home/accept-rules"
}

func writeRulesAcceptanceRequired(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, codedError{
		Error: "accept this server's rules to continue",
		Code:  "rules_acceptance_required",
	})
}

// rulesAcceptanceNeeded: for /me.
func (a *API) rulesAcceptanceNeeded(ctx context.Context, userID string) (bool, error) {
	var needed bool
	err := a.pool.QueryRow(ctx,
		`SELECT st.rules_enforced AND u.rules_accepted_version < st.rules_version
		   FROM server_settings st, users u WHERE u.id = $1`, userID).Scan(&needed)
	return needed, err
}

// ---- Banner ----

// getServerBanner: public, like the icon (the sign-in page shows it).
func (a *API) getServerBanner(w http.ResponseWriter, r *http.Request) {
	var (
		data        []byte
		contentType *string
		version     int
	)
	if err := a.pool.QueryRow(r.Context(),
		`SELECT banner, banner_type, banner_version FROM server_settings`,
	).Scan(&data, &contentType, &version); err != nil {
		slog.Error("loading server banner", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the banner")
		return
	}
	if data == nil || contentType == nil {
		writeError(w, http.StatusNotFound, "this server has no banner")
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

// putServerBanner: administrators. The body is the image itself (PNG or
// WebP, 16:9 to 4:1, at most serverBannerMaxPx wide).
func (a *API) putServerBanner(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	tooBig := "the banner is too large; it can be at most " + formatBytes(serverBannerMaxBytes)
	if r.ContentLength > serverBannerMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, serverBannerMaxBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read the banner")
		return
	}
	if len(data) > serverBannerMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, tooBig)
		return
	}
	contentType, width, height, err := stickerImage(data)
	if err != nil || (contentType != "image/png" && contentType != "image/webp") {
		writeError(w, http.StatusBadRequest, "the banner must be a PNG or WebP image")
		return
	}
	if !bannerShapeOK(width, height) {
		writeError(w, http.StatusBadRequest, "the banner must be between 16:9 and 4:1 (wide, not tall)")
		return
	}
	if width > serverBannerMaxPx {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"the banner is %d pixels wide; it can be at most %d", width, serverBannerMaxPx))
		return
	}
	if !a.changeBanner(w, r, "could not save the banner", func(tx pgx.Tx) (bool, error) {
		_, err := tx.Exec(r.Context(),
			`UPDATE server_settings SET banner = $1, banner_type = $2,
			        banner_version = banner_version + 1, home_version = home_version + 1`,
			data, contentType)
		return true, err
	}, "set_server_banner") {
		return
	}
	slog.Info("server banner set", "actor_id", actor.UserID, "bytes", len(data), "width", width, "height", height)
	w.WriteHeader(http.StatusNoContent)
}

// deleteServerBanner: administrators.
func (a *API) deleteServerBanner(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	if !a.changeBanner(w, r, "could not remove the banner", func(tx pgx.Tx) (bool, error) {
		tag, err := tx.Exec(r.Context(),
			`UPDATE server_settings SET banner = NULL, banner_type = NULL,
			        banner_version = banner_version + 1, home_version = home_version + 1
			  WHERE banner IS NOT NULL`)
		return tag.RowsAffected() > 0, err
	}, "remove_server_banner") {
		return
	}
	slog.Info("server banner removed", "actor_id", actor.UserID)
	w.WriteHeader(http.StatusNoContent)
}

// changeBanner is changeServerInfo plus home_changed: the banner is on
// Home and on the sign-in page (server info).
func (a *API) changeBanner(w http.ResponseWriter, r *http.Request, fail string,
	change func(pgx.Tx) (bool, error), action string) bool {
	if !a.changeServerInfo(w, r, fail, change, action, "") {
		return false
	}
	a.emitAll(homeChangedEvent{Type: "home_changed"})
	return true
}
