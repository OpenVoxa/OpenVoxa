// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Username colours by group (migration 0025; decisions.md Open items,
// "Username colours by group"). Each group may carry a colour; a name is
// drawn in the colour of the account's highest group that has one. The
// colours are server data, the same for everyone; a server-wide switch
// turns them off, and each user can hide them in their own browser.

// nameColourBackground is the default background (client-web styles.css
// --bg). Users cannot change the background, so it is fixed here.
const nameColourBackground = "#333333"

// minNameContrast is the WCAG level for large or bold text; names are
// drawn bold. 4.5:1 would refuse the default orange and magenta.
const minNameContrast = 3.0

var hexColour = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// relativeLuminance is the WCAG 2 relative luminance of #rrggbb.
func relativeLuminance(hex string) float64 {
	channel := func(i int) float64 {
		v, _ := strconv.ParseUint(hex[i:i+2], 16, 8)
		c := float64(v) / 255
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	return 0.2126*channel(1) + 0.7152*channel(3) + 0.0722*channel(5)
}

// contrastRatio is the WCAG 2 contrast ratio of two #rrggbb colours.
func contrastRatio(a, b string) float64 {
	la, lb := relativeLuminance(a), relativeLuminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// checkNameColour normalises a requested colour: "" clears it (returns
// ""), anything else must be #rrggbb with enough contrast. Returns an
// error message for a 400, or "".
func checkNameColour(c string) (string, string) {
	c = strings.ToLower(strings.TrimSpace(c))
	if c == "" {
		return "", ""
	}
	if !hexColour.MatchString(c) {
		return "", "colour must look like #rrggbb"
	}
	if r := contrastRatio(c, nameColourBackground); r < minNameContrast {
		return "", fmt.Sprintf("that colour is too hard to read on the background "+
			"(contrast %.1f:1, needs at least %.0f:1); pick a lighter one", r, minNameContrast)
	}
	return c, ""
}

// defaultNameColours are the colours a new server starts with (migration
// 0025), matched by group name like the migration: a renamed group is
// left alone. Everyone has no colour (plain text). Restored by
// resetNameColours.
var defaultNameColours = map[string]*string{
	"Administrator": ptr("#d96932"),
	"Moderator":     ptr("#ff00ff"),
	"Member":        ptr("#00ffff"),
}

func ptr(s string) *string { return &s }

type nameColoursResponse struct {
	Enabled bool `json:"enabled"`
	// Every live account, mapped to its colour or null (no coloured
	// group). An account missing from the map is newer than the answer,
	// which tells the client to fetch again.
	Users map[string]*string `json:"users"`
}

// listNameColours returns each account's name colour. Anyone signed in:
// the colours are shown beside every name.
func (a *API) listNameColours(w http.ResponseWriter, r *http.Request) {
	out := nameColoursResponse{Users: map[string]*string{}}
	if err := a.pool.QueryRow(r.Context(),
		`SELECT name_colours FROM server_settings`).Scan(&out.Enabled); err != nil {
		slog.Error("reading name colour setting", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load name colours")
		return
	}
	rows, err := a.pool.Query(r.Context(),
		`SELECT u.id::text,
		        (SELECT g.colour FROM effective_groups eg
		           JOIN perm_groups g ON g.id = eg.group_id
		          WHERE eg.user_id = u.id AND g.colour IS NOT NULL
		          ORDER BY g.position DESC, g.name
		          LIMIT 1)
		   FROM users u
		  WHERE u.deleted_at IS NULL`)
	if err != nil {
		slog.Error("listing name colours", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load name colours")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var colour *string
		if err := rows.Scan(&id, &colour); err != nil {
			slog.Error("scanning name colour", "err", err)
			writeError(w, http.StatusInternalServerError, "could not load name colours")
			return
		}
		if !out.Enabled {
			colour = nil
		}
		out.Users[id] = colour
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating name colours", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load name colours")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// putNameColours turns the colours on or off for the whole server.
// Needs manage_groups (route-level), like the colours themselves.
func (a *API) putNameColours(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Enabled == nil {
		writeError(w, http.StatusBadRequest, "enabled is required")
		return
	}
	if _, err := a.pool.Exec(r.Context(),
		`UPDATE server_settings SET name_colours = $1`, *req.Enabled); err != nil {
		slog.Error("saving name colour setting", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the setting")
		return
	}
	state := "off"
	if *req.Enabled {
		state = "on"
	}
	a.auditGroup(r.Context(), actor.UserID, "", "", "", "name colours "+state, "")
	slog.Info("name colours switched", "actor_id", actor.UserID, "enabled", *req.Enabled)
	a.notifyNamesChanged()
	w.WriteHeader(http.StatusNoContent)
}

type namesChangedEvent struct {
	Type string `json:"type"`
}

// notifyNamesChanged tells every client to fetch the name colours again.
// Group membership changes send perms_changed instead, which clients
// also treat as a reason to refetch.
func (a *API) notifyNamesChanged() {
	a.emitAll(namesChangedEvent{Type: "names_changed"})
}

// resetNameColours puts the default colours back: Administrator,
// Moderator and Member get theirs, Everyone none. Other groups keep
// theirs. Like any colour change it reaches groups at or below the
// caller's rank, so the answer says how many were skipped.
func (a *API) resetNameColours(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("resetting name colours", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the colours")
		return
	}
	defer tx.Rollback(r.Context())

	rows, err := tx.Query(r.Context(),
		`SELECT id::text, name, position, is_everyone FROM perm_groups`)
	if err != nil {
		slog.Error("resetting name colours", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the colours")
		return
	}
	type target struct {
		id, name string
		colour   *string
	}
	var targets []target
	skipped := 0
	for rows.Next() {
		var id, name string
		var position int
		var everyone bool
		if err := rows.Scan(&id, &name, &position, &everyone); err != nil {
			rows.Close()
			slog.Error("resetting name colours", "err", err)
			writeError(w, http.StatusInternalServerError, "could not reset the colours")
			return
		}
		colour, known := defaultNameColours[name]
		if !known && !everyone {
			continue
		}
		if position > actor.Rank {
			skipped++
			continue
		}
		targets = append(targets, target{id, name, colour})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("resetting name colours", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the colours")
		return
	}
	for _, t := range targets {
		if _, err := tx.Exec(r.Context(),
			`UPDATE perm_groups SET colour = $2 WHERE id = $1`, t.id, t.colour); err != nil {
			slog.Error("resetting name colours", "err", err)
			writeError(w, http.StatusInternalServerError, "could not reset the colours")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("resetting name colours", "err", err)
		writeError(w, http.StatusInternalServerError, "could not reset the colours")
		return
	}

	for _, t := range targets {
		detail := "none"
		if t.colour != nil {
			detail = *t.colour
		}
		a.auditGroup(r.Context(), actor.UserID, "", t.id, t.name, "colour", detail)
	}
	slog.Info("name colours reset", "actor_id", actor.UserID, "groups", len(targets), "skipped", skipped)
	a.notifyNamesChanged()
	writeJSON(w, http.StatusOK, map[string]int{"reset": len(targets), "skipped": skipped})
}
