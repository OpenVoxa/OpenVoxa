// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// modLogEntry is one row of moderation_log, with its subject resolved to
// something a person can read. subject_id points at a user, a message or
// a report depending on the action, and the row may be gone by now, so
// both names are best effort and may be empty.
type modLogEntry struct {
	ID        string  `json:"id"`
	Actor     string  `json:"actor"`
	Action    string  `json:"action"`
	SubjectID *string `json:"subject_id"`
	// The account acted on: the banned or deleted user, the author of a
	// deleted message, or the accused in a report.
	SubjectUser string `json:"subject_user"`
	// The channel of a deleted or reported message.
	SubjectChannel string    `json:"subject_channel"`
	Detail         string    `json:"detail"`
	CreatedAt      time.Time `json:"created_at"`
}

const modLogPage = 100

// canReadModLog: the people whose actions the log records. Holding only
// Manage groups, Manage channels or Force PTT is not enough; those
// actions are not in it.
func canReadModLog(s perm.Set) bool {
	return s.Has(perm.Ban) || s.Has(perm.ViewReports) || s.Has(perm.DeleteMessages)
}

// listModerationLog returns the log newest first, a page at a time:
// ?before=<created_at of the last entry seen> fetches the next page.
//
// By default only entries newer than the archive period
// (server_settings.modlog_archive_days); ?archived=1 returns the older
// ones instead. Archiving is a view, not a move: nothing is deleted.
func (a *API) listModerationLog(w http.ResponseWriter, r *http.Request) {
	if !canReadModLog(sessionFrom(r.Context()).Perms) {
		writeError(w, http.StatusForbidden, "insufficient permissions")
		return
	}

	var before *time.Time
	if v := r.URL.Query().Get("before"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "before must be an RFC 3339 timestamp")
			return
		}
		before = &t
	}
	archived := r.URL.Query().Get("archived") == "1"

	// UUIDs are random, so subject_id matches at most one of the three
	// joins; whichever matches names the subject.
	rows, err := a.pool.Query(r.Context(),
		`SELECT l.id, COALESCE(au.username, '[deleted]'), l.action, l.subject_id,
		        COALESCE(su.username, mu.username, ru.username, ''),
		        COALESCE(mc.name, rc.name, ''),
		        l.detail, l.created_at
		   FROM moderation_log l
		   LEFT JOIN users au ON au.id = l.actor_id
		   LEFT JOIN users su ON su.id = l.subject_id
		   LEFT JOIN messages m ON m.id = l.subject_id
		   LEFT JOIN users mu ON mu.id = m.author_id
		   LEFT JOIN channels mc ON mc.id = m.channel_id
		   LEFT JOIN reports rp ON rp.id = l.subject_id
		   LEFT JOIN users ru ON ru.id = rp.accused_id
		   LEFT JOIN channels rc ON rc.id = rp.channel_id
		  CROSS JOIN server_settings s
		  WHERE ($1::timestamptz IS NULL OR l.created_at < $1)
		    AND (l.created_at < now() - make_interval(days => s.modlog_archive_days)) = $3
		  ORDER BY l.created_at DESC
		  LIMIT $2`, before, modLogPage, archived)
	if err != nil {
		slog.Error("listing moderation log", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read the moderation log")
		return
	}
	defer rows.Close()

	out := make([]modLogEntry, 0)
	for rows.Next() {
		var e modLogEntry
		if err := rows.Scan(&e.ID, &e.Actor, &e.Action, &e.SubjectID,
			&e.SubjectUser, &e.SubjectChannel, &e.Detail, &e.CreatedAt); err != nil {
			slog.Error("scanning moderation log", "err", err)
			writeError(w, http.StatusInternalServerError, "could not read the moderation log")
			return
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating moderation log", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read the moderation log")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

type modLogSettings struct {
	ArchiveDays int `json:"archive_days"`
}

const maxArchiveDays = 3650

func (a *API) getModLogSettings(w http.ResponseWriter, r *http.Request) {
	if !canReadModLog(sessionFrom(r.Context()).Perms) {
		writeError(w, http.StatusForbidden, "insufficient permissions")
		return
	}
	var out modLogSettings
	if err := a.pool.QueryRow(r.Context(),
		`SELECT modlog_archive_days FROM server_settings`).Scan(&out.ArchiveDays); err != nil {
		slog.Error("loading moderation log settings", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load the setting")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// putModLogSettings: administrator only (the route checks).
func (a *API) putModLogSettings(w http.ResponseWriter, r *http.Request) {
	var req modLogSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ArchiveDays < 1 || req.ArchiveDays > maxArchiveDays {
		writeError(w, http.StatusBadRequest, "archive_days must be between 1 and 3650")
		return
	}
	if _, err := a.pool.Exec(r.Context(),
		`UPDATE server_settings SET modlog_archive_days = $1`, req.ArchiveDays); err != nil {
		slog.Error("saving moderation log settings", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the setting")
		return
	}
	slog.Info("moderation log archive period changed",
		"actor_id", sessionFrom(r.Context()).UserID, "days", req.ArchiveDays)
	writeJSON(w, http.StatusOK, req)
}
