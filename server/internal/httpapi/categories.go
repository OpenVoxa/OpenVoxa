// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// Channel ordering and categories (migration 0040; decisions.md Feature
// decisions, "Channel ordering and categories").
//
// The Text and the Voice sections of the sidebar each have their own
// categories: named folders one level deep, with an optional header
// colour. A category is a label only;
// each channel keeps its own allow-list. Someone without manage_channels
// is sent only the categories holding a channel they can see, so the name
// of a staff-only category doesn't leak.
//
// Order is shared by everyone and changed by dragging (manage_channels).
// A move names where the item goes ("before this one", or the end) rather
// than sending the whole order, so it works for staff who can't see every
// channel: the channels they can't see keep their places around it.
// Every change reaches every socket as channel_layout_changed, and
// clients refetch the list.

const categoryNameMaxChars = 32

// layoutLock serialises moves, so two people dragging at once can't
// interleave their renumbering.
const layoutLock = 4244

type categoryResponse struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Position int    `json:"position"`
	// Colour of the header text (#rrggbb), or null for the default.
	Colour *string `json:"colour"`
}

func (a *API) notifyLayoutChanged() {
	a.emitAll(map[string]string{"type": "channel_layout_changed"})
}

// normaliseCategoryName: one line, whitespace runs to one space, control
// and direction-override characters dropped, 1-32 characters. Any case
// (the sidebar shows it in capitals).
func normaliseCategoryName(s string) (string, string) {
	if !utf8.ValidString(s) {
		return "", "the name is not valid text"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		case dropsFromText(r):
		default:
			b.WriteRune(r)
		}
	}
	s = strings.Join(strings.Fields(b.String()), " ")
	if s == "" {
		return "", "the category needs a name"
	}
	if n := utf8.RuneCountInString(s); n > categoryNameMaxChars {
		return "", fmt.Sprintf("the name is %d characters long; it can be at most %d", n, categoryNameMaxChars)
	}
	return s, ""
}

func categoryLabel(name, kind string) string {
	return name + " (" + kind + ")"
}

// listCategories: anyone signed in. Managers get every category (so they
// can drop channels into empty ones); everyone else only those with a
// channel they may view.
func (a *API) listCategories(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	rows, err := a.pool.Query(r.Context(),
		`SELECT k.id, k.kind, k.name, k.position, k.colour
		   FROM channel_categories k, users u
		  WHERE u.id = $1
		    AND ($2 OR EXISTS (SELECT 1 FROM channels c
		                        WHERE c.category_id = k.id AND `+canViewSQL+`))
		  ORDER BY k.kind, k.position, lower(k.name)`,
		session.UserID, session.Perms.Has(perm.ManageChannels))
	if err != nil {
		slog.Error("listing categories", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list categories")
		return
	}
	cats, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (categoryResponse, error) {
		var c categoryResponse
		err := row.Scan(&c.ID, &c.Kind, &c.Name, &c.Position, &c.Colour)
		return c, err
	})
	if err != nil {
		slog.Error("reading categories", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list categories")
		return
	}
	writeJSON(w, http.StatusOK, cats)
}

// createCategory adds one at the end of its section.
func (a *API) createCategory(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind   string `json:"kind"`
		Name   string `json:"name"`
		Colour string `json:"colour"` // "" or absent: none
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Kind != "text" && req.Kind != "voice" {
		writeError(w, http.StatusBadRequest, "kind must be text or voice")
		return
	}
	name, msg := normaliseCategoryName(req.Name)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	colour, msg := checkNameColour(req.Colour)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	const fail = "could not create the category"
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting category creation", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, layoutLock); err != nil {
		slog.Error("locking channel layout", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	var c categoryResponse
	err = tx.QueryRow(r.Context(),
		`INSERT INTO channel_categories (kind, name, position, colour)
		 VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM channel_categories WHERE kind = $1),
		         NULLIF($3, ''))
		 RETURNING id, kind, name, position, colour`, req.Kind, name, colour,
	).Scan(&c.ID, &c.Kind, &c.Name, &c.Position, &c.Colour)
	if isUniqueViolation(err) {
		writeError(w, http.StatusConflict, "a category with that name already exists here")
		return
	}
	if err != nil {
		slog.Error("creating category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := logChannelAction(r.Context(), tx, sessionFrom(r.Context()).UserID, "create_category",
		c.ID, categoryLabel(c.Name, c.Kind)); err != nil {
		slog.Error("recording category creation", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.notifyLayoutChanged()
	writeJSON(w, http.StatusCreated, c)
}

// editCategory: {"name": "...", "colour": "#rrggbb" | ""}, either or both
// ("" clears the colour). A rename is logged; a colour change is cosmetic
// and isn't.
func (a *API) editCategory(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   *string `json:"name"`
		Colour *string `json:"colour"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == nil && req.Colour == nil {
		writeError(w, http.StatusBadRequest, "nothing to change")
		return
	}
	var name, colour string
	var msg string
	if req.Name != nil {
		if name, msg = normaliseCategoryName(*req.Name); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
	}
	if req.Colour != nil {
		if colour, msg = checkNameColour(*req.Colour); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
	}
	const fail = "could not change the category"
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting category edit", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())
	var old, now, kind string
	err = tx.QueryRow(r.Context(),
		`WITH o AS (SELECT name FROM channel_categories WHERE id = $1)
		 UPDATE channel_categories
		    SET name = CASE WHEN $2 THEN $3 ELSE name END,
		        colour = CASE WHEN $4 THEN NULLIF($5, '') ELSE colour END
		  WHERE id = $1
		 RETURNING (SELECT name FROM o), name, kind`,
		r.PathValue("id"), req.Name != nil, name, req.Colour != nil, colour).Scan(&old, &now, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "category not found")
		return
	}
	if isUniqueViolation(err) {
		writeError(w, http.StatusConflict, "a category with that name already exists here")
		return
	}
	if err != nil {
		slog.Error("editing category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if old != now {
		if err := logChannelAction(r.Context(), tx, sessionFrom(r.Context()).UserID, "rename_category",
			r.PathValue("id"), old+" to "+now+" ("+kind+")"); err != nil {
			slog.Error("recording category rename", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing category edit", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.notifyLayoutChanged()
	w.WriteHeader(http.StatusNoContent)
}

// deleteCategory removes the folder only: its channels move, in their
// order, to the end of the section's top level. Nothing else is deleted.
func (a *API) deleteCategory(w http.ResponseWriter, r *http.Request) {
	const fail = "could not delete the category"
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting category deletion", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, layoutLock); err != nil {
		slog.Error("locking channel layout", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	id := r.PathValue("id")
	var name, kind string
	err = tx.QueryRow(r.Context(),
		`SELECT name, kind FROM channel_categories WHERE id = $1`, id).Scan(&name, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "category not found")
		return
	}
	if err != nil {
		slog.Error("reading category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	// Move its channels after the top-level ones first, keeping their order.
	if _, err := tx.Exec(r.Context(),
		`UPDATE channels c SET category_id = NULL,
		        position = (SELECT COALESCE(max(position), 0) FROM channels
		                     WHERE kind = $2 AND category_id IS NULL) + o.n
		   FROM (SELECT id, row_number() OVER (ORDER BY position, name) AS n
		           FROM channels WHERE category_id = $1) o
		  WHERE c.id = o.id`, id, kind); err != nil {
		slog.Error("moving channels out of category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM channel_categories WHERE id = $1`, id); err != nil {
		slog.Error("deleting category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := logChannelAction(r.Context(), tx, sessionFrom(r.Context()).UserID, "delete_category",
		id, categoryLabel(name, kind)); err != nil {
		slog.Error("recording category deletion", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing category deletion", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.notifyLayoutChanged()
	w.WriteHeader(http.StatusNoContent)
}

// placeBefore returns ids with moved inserted before `before`, or at the
// end when before is nil. ok is false when before isn't in ids.
func placeBefore(ids []string, moved string, before *string) ([]string, bool) {
	ids = slices.DeleteFunc(slices.Clone(ids), func(s string) bool { return s == moved })
	if before == nil {
		return append(ids, moved), true
	}
	i := slices.Index(ids, *before)
	if i < 0 {
		return nil, false
	}
	return slices.Insert(ids, i, moved), true
}

// renumber writes positions 1..n in the given order.
func renumber(ctx context.Context, tx pgx.Tx, table string, ids []string) error {
	_, err := tx.Exec(ctx,
		`UPDATE `+table+` t SET position = o.n
		   FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, n)
		  WHERE t.id = o.id`, ids)
	return err
}

func collectIDs(rows pgx.Rows, err error) ([]string, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// moveCategory: {"before_id": "<category id>" | null}, null for the end.
func (a *API) moveCategory(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BeforeID *string `json:"before_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	const fail = "could not move the category"
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting category move", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, layoutLock); err != nil {
		slog.Error("locking channel layout", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	id := r.PathValue("id")
	var kind string
	err = tx.QueryRow(r.Context(), `SELECT kind FROM channel_categories WHERE id = $1`, id).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "category not found")
		return
	}
	if err != nil {
		slog.Error("reading category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	ids, err := collectIDs(tx.Query(r.Context(),
		`SELECT id::text FROM channel_categories WHERE kind = $1 ORDER BY position, lower(name)`, kind))
	if err != nil {
		slog.Error("listing categories to move", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	order, ok := placeBefore(ids, id, req.BeforeID)
	if !ok {
		writeError(w, http.StatusBadRequest, "before_id is not a category in the same section")
		return
	}
	if err := renumber(r.Context(), tx, "channel_categories", order); err != nil {
		slog.Error("renumbering categories", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing category move", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.notifyLayoutChanged()
	w.WriteHeader(http.StatusNoContent)
}

// moveChannel: {"category_id": "<id>" | null, "before_id": "<channel id>" |
// null}. category_id null is the section's top level; before_id null is
// the end of that scope. Channels the mover can't see keep their places.
func (a *API) moveChannel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CategoryID *string `json:"category_id"`
		BeforeID   *string `json:"before_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if (req.CategoryID != nil && !uuidPattern.MatchString(*req.CategoryID)) ||
		(req.BeforeID != nil && !uuidPattern.MatchString(*req.BeforeID)) {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	const fail = "could not move the channel"
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting channel move", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, layoutLock); err != nil {
		slog.Error("locking channel layout", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	id := r.PathValue("id")
	var kind string
	err = tx.QueryRow(r.Context(), `SELECT kind FROM channels WHERE id = $1 AND kind <> 'dm'`, id).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}
	if err != nil {
		slog.Error("reading channel", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if req.CategoryID != nil {
		var found bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM channel_categories WHERE id = $1 AND kind = $2)`,
			*req.CategoryID, kind).Scan(&found); err != nil {
			slog.Error("checking category", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
		if !found {
			writeError(w, http.StatusBadRequest, "no such category in this channel's section")
			return
		}
	}
	ids, err := collectIDs(tx.Query(r.Context(),
		`SELECT id::text FROM channels
		  WHERE kind = $1 AND category_id IS NOT DISTINCT FROM $2::uuid
		  ORDER BY position, name`, kind, req.CategoryID))
	if err != nil {
		slog.Error("listing channels to move", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	order, ok := placeBefore(ids, id, req.BeforeID)
	if !ok {
		writeError(w, http.StatusBadRequest, "before_id is not a channel in that place")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE channels SET category_id = $2 WHERE id = $1`, id, req.CategoryID); err != nil {
		slog.Error("moving channel", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := renumber(r.Context(), tx, "channels", order); err != nil {
		slog.Error("renumbering channels", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing channel move", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.notifyLayoutChanged()
	w.WriteHeader(http.StatusNoContent)
}
