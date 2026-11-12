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
// colour. Someone without manage_channels is sent only the categories
// holding a channel they can see, so the name of a staff-only category
// doesn't leak.
//
// Category permissions (migration 0042): a category has permissions in
// the same shape as a channel's (which groups may view, which of those
// may post). A channel either follows them ("Same as category",
// channels.follows_category) or has its own ("Custom"). A follower's
// permissions are copied into its own channel_access whenever the
// category's change or it moves, so every access check still reads the
// channel's permissions alone. Moving a follower out of every category,
// or deleting its category, makes it Custom with the permissions it had:
// nobody gains or loses access. Moving it into another category gives it
// that category's, unless the move says keep_access; follow_category makes
// a Custom channel take and follow them too. The web client asks before
// every move to another place, showing what each choice changes.
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
	// Access: the category's permissions, sent to manage_channels only
	// (nobody else needs them, and they'd show staff-only setup).
	Access []channelAccessEntry `json:"access,omitempty"`
}

// categoryAccessJSON selects category k's permissions as a JSON array.
const categoryAccessJSON = `
	COALESCE((SELECT json_agg(json_build_object(
	                   'group_id', g.id, 'group', g.name, 'can_post', ka.can_post)
	                   ORDER BY g.position, g.name)
	            FROM category_access ka
	            JOIN perm_groups g ON g.id = ka.group_id
	           WHERE ka.category_id = k.id), '[]'::json)`

// writeCategoryAccess replaces category catID's permissions inside tx.
func writeCategoryAccess(ctx context.Context, tx pgx.Tx, catID string, req channelAccessRequest) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM category_access WHERE category_id = $1`, catID); err != nil {
		return err
	}
	for _, e := range req.Access {
		tag, err := tx.Exec(ctx,
			`INSERT INTO category_access (category_id, group_id, can_post)
			 SELECT $1, id, $3 FROM perm_groups WHERE id = $2
			 ON CONFLICT (category_id, group_id)
			 DO UPDATE SET can_post = category_access.can_post OR EXCLUDED.can_post`,
			catID, e.GroupID, e.CanPost)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errUnknownGroup
		}
	}
	return nil
}

// copyCategoryAccess gives each of channelIDs its category's permissions
// (inside tx). The callers only pass channels that follow their category.
func copyCategoryAccess(ctx context.Context, tx pgx.Tx, channelIDs []string) error {
	if len(channelIDs) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM channel_access WHERE channel_id = ANY($1::uuid[])`, channelIDs); err != nil {
		return err
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO channel_access (channel_id, group_id, can_post)
		 SELECT c.id, ka.group_id, ka.can_post
		   FROM channels c JOIN category_access ka ON ka.category_id = c.category_id
		  WHERE c.id = ANY($1::uuid[])`, channelIDs)
	return err
}

// channelAccessKey: channel id's permissions as one comparable string,
// to tell whether a change actually changed who can use it.
func channelAccessKey(ctx context.Context, tx pgx.Tx, channelID string) (string, error) {
	var key string
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(string_agg(group_id::text || ':' || can_post::text, ',' ORDER BY group_id), '')
		   FROM channel_access WHERE channel_id = $1`, channelID).Scan(&key)
	return key, err
}

// accessRequestFrom checks group ids from a request body.
func accessRequestFrom(entries []struct {
	GroupID string `json:"group_id"`
	CanPost bool   `json:"can_post"`
}) (channelAccessRequest, string) {
	var req channelAccessRequest
	for _, e := range entries {
		if !uuidPattern.MatchString(e.GroupID) {
			return req, "invalid group id " + e.GroupID
		}
		req.Access = append(req.Access, e)
	}
	return req, ""
}

// defaultCategoryAccess gives a new category the server default for new
// channels: Everyone may view, groups new accounts join may post.
func defaultCategoryAccess(ctx context.Context, tx pgx.Tx, catID string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO category_access (category_id, group_id, can_post)
		 SELECT $1, id, auto_assign FROM perm_groups WHERE is_everyone OR auto_assign`, catID)
	return err
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
		`SELECT k.id, k.kind, k.name, k.position, k.colour, `+categoryAccessJSON+`
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
	manager := session.Perms.Has(perm.ManageChannels)
	cats, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (categoryResponse, error) {
		var c categoryResponse
		err := row.Scan(&c.ID, &c.Kind, &c.Name, &c.Position, &c.Colour, &c.Access)
		if !manager {
			c.Access = nil
		} else if c.Access == nil {
			c.Access = []channelAccessEntry{}
		}
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
		// Access: its permissions; absent for the server default.
		Access *[]struct {
			GroupID string `json:"group_id"`
			CanPost bool   `json:"can_post"`
		} `json:"access"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	var access *channelAccessRequest
	if req.Access != nil {
		a, msg := accessRequestFrom(*req.Access)
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		access = &a
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
	if access != nil {
		err = writeCategoryAccess(r.Context(), tx, c.ID, *access)
	} else {
		err = defaultCategoryAccess(r.Context(), tx, c.ID)
	}
	if errors.Is(err, errUnknownGroup) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		slog.Error("writing category access", "err", err)
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
	// Followers become Custom with the permissions they have: nobody gains
	// or loses access.
	if _, err := tx.Exec(r.Context(),
		`UPDATE channels c SET category_id = NULL, follows_category = false,
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
		// KeepAccess: a channel following its category's permissions
		// keeps the ones it has and becomes Custom, instead of taking the
		// new category's.
		KeepAccess bool `json:"keep_access"`
		// FollowCategory: take the new category's permissions and follow
		// them, whatever the channel had (a Custom channel too).
		FollowCategory bool `json:"follow_category"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.FollowCategory && (req.CategoryID == nil || req.KeepAccess) {
		writeError(w, http.StatusBadRequest, "follow_category needs a category and no keep_access")
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
	var oldCategory *string
	var follows bool
	err = tx.QueryRow(r.Context(),
		`SELECT kind, category_id::text, follows_category FROM channels WHERE id = $1 AND kind <> 'dm'`,
		id).Scan(&kind, &oldCategory, &follows)
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
	// A follower that changes category: out of every category, or asked
	// to keep its permissions, it becomes Custom; into another, it takes
	// that one's permissions.
	sameCategory := (oldCategory == nil) == (req.CategoryID == nil) &&
		(oldCategory == nil || *oldCategory == *req.CategoryID)
	retarget := req.FollowCategory || (follows && !sameCategory && req.CategoryID != nil && !req.KeepAccess)
	if retarget {
		follows = true
	} else if follows && !sameCategory {
		follows = false
	}
	var before string
	if retarget {
		if before, err = channelAccessKey(r.Context(), tx, id); err != nil {
			slog.Error("reading channel access", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE channels SET category_id = $2, follows_category = $3 WHERE id = $1`,
		id, req.CategoryID, follows); err != nil {
		slog.Error("moving channel", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	accessChanged := false
	if retarget {
		if err := copyCategoryAccess(r.Context(), tx, []string{id}); err != nil {
			slog.Error("copying category access", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
		after, err := channelAccessKey(r.Context(), tx, id)
		if err != nil {
			slog.Error("reading channel access", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
		accessChanged = after != before
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
	if accessChanged {
		slog.Info("channel access changed by a move", "actor_id", sessionFrom(r.Context()).UserID,
			"channel_id", id)
		a.NotifyChannelChanged(id)
		a.afterBroadAccessChange(r.Context())
	}
	w.WriteHeader(http.StatusNoContent)
}

// setCategoryAccess: {"access": [{group_id, can_post}], "apply_to_all":
// bool}. Replaces the category's permissions and copies them to every
// channel in it that follows them; apply_to_all first makes every channel
// in it follow them (Custom ones included).
func (a *API) setCategoryAccess(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Access []struct {
			GroupID string `json:"group_id"`
			CanPost bool   `json:"can_post"`
		} `json:"access"`
		ApplyToAll bool `json:"apply_to_all"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	req, msg := accessRequestFrom(body.Access)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	const fail = "could not change the category's permissions"
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting category access change", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())
	// The layout lock keeps a channel from moving in or out halfway.
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, layoutLock); err != nil {
		slog.Error("locking channel layout", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	id := r.PathValue("id")
	var exists bool
	if err := tx.QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM channel_categories WHERE id = $1)`, id).Scan(&exists); err != nil {
		slog.Error("reading category", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "category not found")
		return
	}
	if err := writeCategoryAccess(r.Context(), tx, id, req); err != nil {
		if errors.Is(err, errUnknownGroup) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		slog.Error("writing category access", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if body.ApplyToAll {
		if _, err := tx.Exec(r.Context(),
			`UPDATE channels SET follows_category = true WHERE category_id = $1`, id); err != nil {
			slog.Error("making channels follow their category", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}
	followers, err := collectIDs(tx.Query(r.Context(),
		`SELECT id::text FROM channels WHERE category_id = $1 AND follows_category`, id))
	if err != nil {
		slog.Error("listing following channels", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := copyCategoryAccess(r.Context(), tx, followers); err != nil {
		slog.Error("copying category access", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing category access", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	slog.Info("category access changed", "actor_id", sessionFrom(r.Context()).UserID,
		"category_id", id, "channels", len(followers))
	a.notifyLayoutChanged()
	for _, c := range followers {
		a.NotifyChannelChanged(c)
	}
	if len(followers) > 0 {
		a.afterBroadAccessChange(r.Context())
	}
	w.WriteHeader(http.StatusNoContent)
}
