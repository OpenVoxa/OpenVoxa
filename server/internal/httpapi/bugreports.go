// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

// Bug reports (migration 0032; decisions.md, Feature decisions,
// "Planned", bug reports, "Changed and settled"). Anyone signed in files
// one (Settings, About, Report a Bug); holders of View reports (moderators
// and administrators) read and handle them in Server settings, Bug
// Reports. Only administrators send one to GitHub; that happens in their
// browser, and the server only records that it was done.
//
// The report is the reporter's own words, so it is sealed under their
// account key like plaintext messages: deleting the account destroys it.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/keystore"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

const (
	bugReportMaxRunes = 4000
	// The debug info rows; a few hundred bytes in practice.
	bugReportMaxDebug = 16 * 1024
)

func bugReportSealContext(reporterID string) []byte {
	return []byte("openvoxa/bug-report/v1\x00" + reporterID)
}

// bugReportBody is what is sealed. Debug is the About tab's rows, kept as
// the client sent them (a JSON array of sections) and only size-checked:
// the server never acts on it.
type bugReportBody struct {
	Text  string          `json:"text"`
	Debug json.RawMessage `json:"debug,omitempty"`
}

type bugReportsChangedEvent struct {
	Type string `json:"type"`
}

func (a *API) fileBugReport(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	if !a.bugReportLimit.Allow(s.UserID) {
		writeTooManyRequests(w, a.bugReportLimit.RetryAfter(s.UserID))
		return
	}
	var req bugReportBody
	if !decodeJSONLimit(w, r, &req, bugReportMaxDebug+4*bugReportMaxRunes+1024) {
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	switch {
	case req.Text == "":
		writeError(w, http.StatusBadRequest, "say what went wrong")
		return
	case utf8.RuneCountInString(req.Text) > bugReportMaxRunes:
		writeError(w, http.StatusBadRequest, "the report is too long")
		return
	case len(req.Debug) > bugReportMaxDebug:
		writeError(w, http.StatusBadRequest, "the debug info is too long")
		return
	}
	if len(req.Debug) > 0 && (string(req.Debug) == "null" || !json.Valid(req.Debug)) {
		req.Debug = nil
	}

	plain, err := json.Marshal(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid report")
		return
	}
	sealed, err := a.keys.Seal(s.UserID, plain, bugReportSealContext(s.UserID))
	if err != nil {
		slog.Error("sealing bug report", "err", err)
		writeError(w, http.StatusInternalServerError, "could not send the report")
		return
	}
	var id string
	if err := a.pool.QueryRow(r.Context(),
		`INSERT INTO bug_reports (reporter_id, body) VALUES ($1, $2) RETURNING id`,
		s.UserID, sealed,
	).Scan(&id); err != nil {
		slog.Error("filing bug report", "err", err)
		writeError(w, http.StatusInternalServerError, "could not send the report")
		return
	}
	a.notifyBugReportsChanged(r.Context())
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

type bugReportSummary struct {
	ID       string          `json:"id"`
	Reporter string          `json:"reporter"`
	Text     string          `json:"text"`
	Debug    json.RawMessage `json:"debug,omitempty"`
	// The reporter's account was deleted, and the text with it.
	Gone         bool       `json:"gone"`
	Status       string     `json:"status"`
	SentToGitHub *time.Time `json:"sent_to_github_at"`
	CreatedAt    time.Time  `json:"created_at"`
	ClosedAt     *time.Time `json:"closed_at"`
}

// listBugReports: open (the default) or closed, newest first.
func (a *API) listBugReports(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "open"
	}
	if status != "open" && status != "closed" {
		writeError(w, http.StatusBadRequest, "status must be open or closed")
		return
	}
	rows, err := a.pool.Query(r.Context(),
		`SELECT b.id, b.reporter_id, COALESCE(u.username, '[deleted]'), b.body,
		        b.status, b.sent_to_github_at, b.created_at, b.closed_at
		   FROM bug_reports b
		   LEFT JOIN users u ON u.id = b.reporter_id
		  WHERE b.status = $1
		  ORDER BY b.created_at DESC
		  LIMIT 200`, status)
	if err != nil {
		slog.Error("listing bug reports", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list bug reports")
		return
	}
	defer rows.Close()
	out := make([]bugReportSummary, 0)
	for rows.Next() {
		var b bugReportSummary
		var reporterID *string
		var sealed []byte
		if err := rows.Scan(&b.ID, &reporterID, &b.Reporter, &sealed,
			&b.Status, &b.SentToGitHub, &b.CreatedAt, &b.ClosedAt); err != nil {
			slog.Error("scanning bug report", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list bug reports")
			return
		}
		body, gone := a.openBugReport(r.Context(), reporterID, sealed)
		b.Text, b.Debug, b.Gone = body.Text, body.Debug, gone
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating bug reports", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list bug reports")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}

func (a *API) openBugReport(ctx context.Context, reporterID *string, sealed []byte) (bugReportBody, bool) {
	if reporterID == nil {
		return bugReportBody{}, true
	}
	plain, err := a.keys.Open(*reporterID, sealed, bugReportSealContext(*reporterID))
	if errors.Is(err, keystore.ErrNoKey) {
		return bugReportBody{}, true
	}
	if err != nil {
		slog.WarnContext(ctx, "opening bug report", "err", err)
		return bugReportBody{Text: "(this report could not be opened)"}, false
	}
	var b bugReportBody
	if err := json.Unmarshal(plain, &b); err != nil {
		return bugReportBody{Text: "(this report could not be read)"}, false
	}
	return b, false
}

type updateBugReportRequest struct {
	// "open" or "closed"; empty leaves it.
	Status string `json:"status"`
	// true records that an administrator pressed Send to GitHub.
	SentToGitHub bool `json:"sent_to_github"`
}

func (a *API) updateBugReport(w http.ResponseWriter, r *http.Request) {
	var req updateBugReportRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Status != "" && req.Status != "open" && req.Status != "closed" {
		writeError(w, http.StatusBadRequest, "status must be open or closed")
		return
	}
	if req.SentToGitHub && !sessionFrom(r.Context()).Perms.Has(perm.Administrator) {
		writeError(w, http.StatusForbidden, "only administrators send bug reports to GitHub")
		return
	}
	tag, err := a.pool.Exec(r.Context(),
		`UPDATE bug_reports
		    SET status = COALESCE(NULLIF($2, ''), status),
		        closed_at = CASE WHEN $2 = 'closed' AND status <> 'closed' THEN now()
		                         WHEN $2 = 'open' THEN NULL ELSE closed_at END,
		        sent_to_github_at = CASE WHEN $3 THEN COALESCE(sent_to_github_at, now())
		                                 ELSE sent_to_github_at END
		  WHERE id = $1`,
		r.PathValue("id"), req.Status, req.SentToGitHub)
	if err != nil && isInvalidInput(err) {
		writeError(w, http.StatusNotFound, "bug report not found")
		return
	}
	if err != nil {
		slog.Error("updating bug report", "err", err)
		writeError(w, http.StatusInternalServerError, "could not update the bug report")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "bug report not found")
		return
	}
	a.notifyBugReportsChanged(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) deleteBugReport(w http.ResponseWriter, r *http.Request) {
	tag, err := a.pool.Exec(r.Context(), `DELETE FROM bug_reports WHERE id = $1`, r.PathValue("id"))
	if err != nil && !isInvalidInput(err) {
		slog.Error("deleting bug report", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete the bug report")
		return
	}
	if err != nil || tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "bug report not found")
		return
	}
	a.notifyBugReportsChanged(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

// notifyBugReportsChanged tells the apps of those who read bug reports to
// refetch the count and the list. Carries nothing.
func (a *API) notifyBugReportsChanged(ctx context.Context) {
	rows, err := a.pool.Query(ctx,
		`SELECT DISTINCT eg.user_id
		   FROM effective_groups eg
		   JOIN perm_groups g ON g.id = eg.group_id
		  WHERE g.permissions && ARRAY['view_reports', 'administrator']::text[]`)
	if err != nil {
		slog.Error("finding bug report readers", "err", err)
		return
	}
	users, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		slog.Error("reading bug report readers", "err", err)
		return
	}
	set := make(map[string]bool, len(users))
	for _, u := range users {
		set[u] = true
	}
	a.emitUsers(set, bugReportsChangedEvent{Type: "bug_reports_changed"})
}
