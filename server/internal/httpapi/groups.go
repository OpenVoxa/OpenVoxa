// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// Permission groups (build-order step 12). See migration 0012 and the
// perm package for the model. The rules every handler here applies:
//
//   - You need manage_groups (route-level, in httpapi.go).
//   - You may only touch groups positioned strictly below your rank, and
//     only create or move a group to a position below it.
//   - You may only give a group, or put someone in a group, carrying
//     switches you hold yourself. So manage_groups cannot mint an
//     administrator, and a group manager cannot hand out ban.
//   - You may only change the groups of accounts ranked below you, never
//     your own.
//
// Exception for parity with the old roles: you may put someone in a group
// at your own position (an administrator can make another administrator),
// though neither of you can then take it away from the other.

type permGroup struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Position    int      `json:"position"`
	Permissions []string `json:"permissions"`
	IsEveryone  bool     `json:"is_everyone"`
	AutoAssign  bool     `json:"auto_assign"`
	// Name colour (#rrggbb), or null for none (namecolours.go).
	Colour    *string   `json:"colour"`
	Members   int       `json:"members"`
	CreatedAt time.Time `json:"created_at"`
}

const permGroupColumns = `g.id::text, g.name, g.position, g.permissions,
	g.is_everyone, g.auto_assign, g.colour,
	(CASE WHEN g.is_everyone
	      THEN (SELECT count(*) FROM users u WHERE u.deleted_at IS NULL)
	      ELSE (SELECT count(*) FROM user_perm_groups ug
	              JOIN users u ON u.id = ug.user_id AND u.deleted_at IS NULL
	             WHERE ug.group_id = g.id)
	 END)::int,
	g.created_at`

func scanPermGroup(row pgx.Row) (permGroup, error) {
	var g permGroup
	err := row.Scan(&g.ID, &g.Name, &g.Position, &g.Permissions,
		&g.IsEveryone, &g.AutoAssign, &g.Colour, &g.Members, &g.CreatedAt)
	return g, err
}

// listGroups returns every group, highest first. Readable by anyone
// signed in: group names show up beside channels and people.
func (a *API) listGroups(w http.ResponseWriter, r *http.Request) {
	rows, err := a.pool.Query(r.Context(),
		`SELECT `+permGroupColumns+` FROM perm_groups g
		  ORDER BY g.position DESC, g.name`)
	if err != nil {
		slog.Error("listing groups", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list groups")
		return
	}
	defer rows.Close()

	out := make([]permGroup, 0)
	for rows.Next() {
		g, err := scanPermGroup(rows)
		if err != nil {
			slog.Error("scanning group", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list groups")
			return
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating groups", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list groups")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type groupRequest struct {
	Name        *string   `json:"name"`
	Position    *int      `json:"position"`
	Permissions *[]string `json:"permissions"`
	AutoAssign  *bool     `json:"auto_assign"`
	// "" clears the colour.
	Colour *string `json:"colour"`
}

// checkGroupFields validates the fields present in req against the
// caller. Returns an error message for a 400/403, or "" when fine.
func checkGroupFields(actor Session, req groupRequest) (int, string) {
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" || len(n) > 32 {
			return http.StatusBadRequest, "name must be 1-32 characters"
		}
		*req.Name = n
	}
	if req.Position != nil {
		if *req.Position < 1 {
			return http.StatusBadRequest, "position must be 1 or more (0 is Everyone)"
		}
		if !perm.Outranks(actor.Rank, *req.Position) {
			return http.StatusForbidden, "position must be below your own rank"
		}
	}
	if req.Permissions != nil {
		seen := make(map[string]bool)
		clean := make([]string, 0, len(*req.Permissions))
		for _, p := range *req.Permissions {
			if !perm.Valid(p) {
				return http.StatusBadRequest, "unknown permission " + p
			}
			if !seen[p] {
				seen[p] = true
				clean = append(clean, p)
			}
		}
		if !actor.Perms.Covers(clean) {
			return http.StatusForbidden, "you cannot grant a permission you do not hold"
		}
		*req.Permissions = clean
	}
	if req.Colour != nil {
		c, msg := checkNameColour(*req.Colour)
		if msg != "" {
			return http.StatusBadRequest, msg
		}
		*req.Colour = c
	}
	return 0, ""
}

// colourOnly reports whether an edit changes nothing but the colour.
func (req groupRequest) colourOnly() bool {
	return req.Colour != nil && req.Name == nil && req.Position == nil &&
		req.Permissions == nil && req.AutoAssign == nil
}

// nullIfEmpty turns a cleared colour into SQL NULL.
func nullIfEmpty(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

func (a *API) createGroupPerm(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	var req groupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == nil || req.Position == nil {
		writeError(w, http.StatusBadRequest, "name and position are required")
		return
	}
	if req.Permissions == nil {
		req.Permissions = &[]string{}
	}
	if req.AutoAssign == nil {
		req.AutoAssign = new(bool)
	}
	if code, msg := checkGroupFields(actor, req); code != 0 {
		writeError(w, code, msg)
		return
	}

	g, err := scanPermGroup(a.pool.QueryRow(r.Context(),
		`WITH g AS (
		   INSERT INTO perm_groups (name, position, permissions, auto_assign, colour)
		   VALUES ($1, $2, $3, $4, $5) RETURNING *)
		 SELECT `+permGroupColumns+` FROM g`,
		*req.Name, *req.Position, *req.Permissions, *req.AutoAssign, nullIfEmpty(req.Colour)))
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a group with that name already exists")
			return
		}
		slog.Error("creating group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create group")
		return
	}

	a.auditGroup(r.Context(), actor.UserID, "", g.ID, g.Name, "created",
		strings.Join(g.Permissions, ","))
	slog.Info("group created", "actor_id", actor.UserID, "group_id", g.ID)
	// A new group has no members and no channel access, so nobody's
	// access moved. Clients still refresh their group list.
	a.NotifyPermsChanged("")
	writeJSON(w, http.StatusCreated, g)
}

// loadGroupForChange fetches a group and checks the caller may change it.
// Writes the error response and returns false when not.
func (a *API) loadGroupForChange(
	w http.ResponseWriter, r *http.Request, actor Session, groupID string,
) (permGroup, bool) {
	return a.loadGroupAtRank(w, r, actor, groupID, false)
}

// loadGroupAtRank is loadGroupForChange, optionally also allowing a group
// at the caller's own rank: a colour is cosmetic, so an administrator may
// recolour the Administrator group, which no other change allows.
func (a *API) loadGroupAtRank(
	w http.ResponseWriter, r *http.Request, actor Session, groupID string, sameRankOK bool,
) (permGroup, bool) {
	g, err := scanPermGroup(a.pool.QueryRow(r.Context(),
		`SELECT `+permGroupColumns+` FROM perm_groups g WHERE g.id = $1`, groupID))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "group not found")
		return g, false
	}
	if err != nil {
		slog.Error("loading group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load group")
		return g, false
	}
	if !perm.Outranks(actor.Rank, g.Position) && !(sameRankOK && actor.Rank == g.Position) {
		writeError(w, http.StatusForbidden,
			"you cannot change a group at or above your own rank")
		return g, false
	}
	return g, true
}

func (a *API) editGroupPerm(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	var req groupRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	g, ok := a.loadGroupAtRank(w, r, actor, r.PathValue("id"), req.colourOnly())
	if !ok {
		return
	}
	if req.colourOnly() {
		a.editGroupColour(w, r, actor, g, req)
		return
	}
	if g.IsEveryone && (req.Name != nil || req.Position != nil || req.AutoAssign != nil) {
		writeError(w, http.StatusBadRequest,
			"Everyone can only have its permissions changed")
		return
	}
	// Taking a switch away is also limited to switches you hold: someone
	// without ban must not be able to strip ban from a group either.
	if req.Permissions != nil && !actor.Perms.Covers(g.Permissions) {
		writeError(w, http.StatusForbidden,
			"this group has permissions you do not hold")
		return
	}
	if code, msg := checkGroupFields(actor, req); code != 0 {
		writeError(w, code, msg)
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("editing group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not edit group")
		return
	}
	defer tx.Rollback(r.Context())
	guard, ok := a.startGuard(w, r, tx, "could not edit group")
	if !ok {
		return
	}

	g, err = scanPermGroup(tx.QueryRow(r.Context(),
		`WITH g AS (
		   UPDATE perm_groups SET
		     name        = COALESCE($2, name),
		     position    = COALESCE($3, position),
		     permissions = COALESCE($4, permissions),
		     auto_assign = COALESCE($5, auto_assign),
		     colour      = CASE WHEN $6::boolean THEN $7 ELSE colour END
		   WHERE id = $1 RETURNING *)
		 SELECT `+permGroupColumns+` FROM g`,
		g.ID, req.Name, req.Position, req.Permissions, req.AutoAssign,
		req.Colour != nil, nullIfEmpty(req.Colour)))
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a group with that name already exists")
			return
		}
		slog.Error("editing group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not edit group")
		return
	}
	// Taking the administrator switch off a group can remove the last
	// administrator.
	if !a.commitKeepingAdmin(w, r, tx, guard, "could not edit group") {
		return
	}

	a.auditGroup(r.Context(), actor.UserID, "", g.ID, g.Name, "edited",
		strings.Join(g.Permissions, ","))
	slog.Info("group edited", "actor_id", actor.UserID, "group_id", g.ID)
	// Switches decide administrator, which decides channel access, so
	// treat any edit as a possible access change for its members.
	a.afterBroadAccessChange(r.Context())
	writeJSON(w, http.StatusOK, g)
}

// editGroupColour changes only a group's colour. Nothing about access
// moves, so clients are only told to refetch the name colours.
func (a *API) editGroupColour(w http.ResponseWriter, r *http.Request, actor Session, g permGroup, req groupRequest) {
	if code, msg := checkGroupFields(actor, req); code != 0 {
		writeError(w, code, msg)
		return
	}
	g, err := scanPermGroup(a.pool.QueryRow(r.Context(),
		`WITH g AS (
		   UPDATE perm_groups SET colour = $2 WHERE id = $1 RETURNING *)
		 SELECT `+permGroupColumns+` FROM g`,
		g.ID, nullIfEmpty(req.Colour)))
	if err != nil {
		slog.Error("changing group colour", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change the colour")
		return
	}
	detail := "none"
	if g.Colour != nil {
		detail = *g.Colour
	}
	a.auditGroup(r.Context(), actor.UserID, "", g.ID, g.Name, "colour", detail)
	slog.Info("group colour changed", "actor_id", actor.UserID, "group_id", g.ID)
	a.notifyNamesChanged()
	writeJSON(w, http.StatusOK, g)
}

func (a *API) deleteGroupPerm(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	g, ok := a.loadGroupForChange(w, r, actor, r.PathValue("id"))
	if !ok {
		return
	}
	if g.IsEveryone {
		writeError(w, http.StatusBadRequest, "Everyone cannot be deleted")
		return
	}
	if !actor.Perms.Covers(g.Permissions) {
		writeError(w, http.StatusForbidden,
			"this group has permissions you do not hold")
		return
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("deleting group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete group")
		return
	}
	defer tx.Rollback(r.Context())
	guard, ok := a.startGuard(w, r, tx, "could not delete group")
	if !ok {
		return
	}
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM perm_groups WHERE id = $1`, g.ID); err != nil {
		slog.Error("deleting group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete group")
		return
	}
	if !a.commitKeepingAdmin(w, r, tx, guard, "could not delete group") {
		return
	}

	// The row is gone, so the audit entry keeps only the name.
	a.auditGroup(r.Context(), actor.UserID, "", "", g.Name, "deleted", "")
	slog.Info("group deleted", "actor_id", actor.UserID, "group_id", g.ID)
	a.afterBroadAccessChange(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

// membershipTarget loads and checks the subject and group of an add or
// remove. Writes the error response and returns false when refused.
func (a *API) membershipTarget(
	w http.ResponseWriter, r *http.Request, actor Session,
) (subjectID string, g permGroup, ok bool) {
	subjectID = r.PathValue("id")
	groupID := r.PathValue("group")
	if !uuidPattern.MatchString(groupID) {
		writeError(w, http.StatusBadRequest, "invalid group id")
		return "", g, false
	}
	if subjectID == actor.UserID {
		writeError(w, http.StatusForbidden, "you cannot change your own groups")
		return "", g, false
	}

	subjectRankN, err := subjectRank(r.Context(), a.pool, subjectID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "user not found")
		return "", g, false
	}
	if err != nil {
		slog.Error("loading subject rank", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change groups")
		return "", g, false
	}
	if !perm.Outranks(actor.Rank, subjectRankN) {
		writeError(w, http.StatusForbidden,
			"you cannot change the groups of someone at or above your own rank")
		return "", g, false
	}

	g, err = scanPermGroup(a.pool.QueryRow(r.Context(),
		`SELECT `+permGroupColumns+` FROM perm_groups g WHERE g.id = $1`, groupID))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "group not found")
		return "", g, false
	}
	if err != nil {
		slog.Error("loading group", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change groups")
		return "", g, false
	}
	if g.IsEveryone {
		writeError(w, http.StatusBadRequest, "everyone is always in Everyone")
		return "", g, false
	}
	if g.Position > actor.Rank {
		writeError(w, http.StatusForbidden, "that group is above your own rank")
		return "", g, false
	}
	if !actor.Perms.Covers(g.Permissions) {
		writeError(w, http.StatusForbidden,
			"that group has permissions you do not hold")
		return "", g, false
	}
	return subjectID, g, true
}

func (a *API) addUserToGroup(w http.ResponseWriter, r *http.Request) {
	a.changeMembership(w, r, true)
}

func (a *API) removeUserFromGroup(w http.ResponseWriter, r *http.Request) {
	a.changeMembership(w, r, false)
}

func (a *API) changeMembership(w http.ResponseWriter, r *http.Request, add bool) {
	actor := sessionFrom(r.Context())
	subjectID, g, ok := a.membershipTarget(w, r, actor)
	if !ok {
		return
	}

	var sql, action string
	if add {
		sql = `INSERT INTO user_perm_groups (user_id, group_id) VALUES ($1, $2)
		       ON CONFLICT DO NOTHING`
		action = "added"
	} else {
		sql = `DELETE FROM user_perm_groups WHERE user_id = $1 AND group_id = $2`
		action = "removed"
	}
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("changing group membership", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change groups")
		return
	}
	defer tx.Rollback(r.Context())
	guard, ok := a.startGuard(w, r, tx, "could not change groups")
	if !ok {
		return
	}
	tag, err := tx.Exec(r.Context(), sql, subjectID, g.ID)
	if err != nil {
		slog.Error("changing group membership", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change groups")
		return
	}
	if tag.RowsAffected() == 0 {
		// Already in (or already out of) the group: nothing changed.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !a.commitKeepingAdmin(w, r, tx, guard, "could not change groups") {
		return
	}

	a.auditGroup(r.Context(), actor.UserID, subjectID, g.ID, g.Name, action, "")
	slog.Info("group membership changed", "actor_id", actor.UserID,
		"subject_id", subjectID, "group_id", g.ID, "action", action)

	a.NotifyPermsChanged(subjectID)
	// After the event, so the subject's open connections hear about the
	// change before any of them are closed.
	a.closeLostChannels(r.Context(), subjectID)
	a.kickFromLostVoice(subjectID)
	w.WriteHeader(http.StatusNoContent)
}

type channelAccessRequest struct {
	Access []struct {
		GroupID string `json:"group_id"`
		CanPost bool   `json:"can_post"`
	} `json:"access"`
	// FollowCategory: take the channel's category's permissions and keep
	// following them ("Same as category"); Access is then ignored. False:
	// Access is the channel's own ("Custom").
	FollowCategory bool `json:"follow_category"`
}

// setChannelAccess replaces a channel's allow-list. An empty list leaves
// the channel visible to administrators only.
func (a *API) setChannelAccess(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	channelID := r.PathValue("id")
	var req channelAccessRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	for _, e := range req.Access {
		if !uuidPattern.MatchString(e.GroupID) {
			writeError(w, http.StatusBadRequest, "invalid group id "+e.GroupID)
			return
		}
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting access change", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change access")
		return
	}
	defer tx.Rollback(r.Context())

	// The layout lock keeps the channel from changing category meanwhile.
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, layoutLock); err != nil {
		slog.Error("locking channel layout", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change access")
		return
	}
	var inCategory bool
	err = tx.QueryRow(r.Context(),
		`SELECT category_id IS NOT NULL FROM channels WHERE id = $1 AND kind <> 'dm' FOR UPDATE`,
		channelID).Scan(&inCategory)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}
	if err != nil {
		slog.Error("locking channel", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change access")
		return
	}
	if req.FollowCategory && !inCategory {
		writeError(w, http.StatusBadRequest, "the channel isn't in a category")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE channels SET follows_category = $2 WHERE id = $1`, channelID, req.FollowCategory); err != nil {
		slog.Error("setting follows_category", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change access")
		return
	}
	if req.FollowCategory {
		err = copyCategoryAccess(r.Context(), tx, []string{channelID})
	} else {
		err = writeChannelAccess(r.Context(), tx, channelID, req)
	}
	if err != nil {
		if errors.Is(err, errUnknownGroup) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		slog.Error("writing channel access", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change access")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing access change", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change access")
		return
	}

	slog.Info("channel access changed", "actor_id", actor.UserID, "channel_id", channelID)
	a.NotifyChannelChanged(channelID)
	a.afterBroadAccessChange(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

var errUnknownGroup = errors.New("unknown group in access list")

// writeChannelAccess replaces channelID's allow-list inside tx.
func writeChannelAccess(ctx context.Context, tx pgx.Tx, channelID string, req channelAccessRequest) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM channel_access WHERE channel_id = $1`, channelID); err != nil {
		return err
	}
	for _, e := range req.Access {
		tag, err := tx.Exec(ctx,
			`INSERT INTO channel_access (channel_id, group_id, can_post)
			 SELECT $1, id, $3 FROM perm_groups WHERE id = $2
			 ON CONFLICT (channel_id, group_id)
			 DO UPDATE SET can_post = channel_access.can_post OR EXCLUDED.can_post`,
			channelID, e.GroupID, e.CanPost)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errUnknownGroup
		}
	}
	return nil
}

// afterBroadAccessChange follows a change that can move many accounts'
// access at once. Every client refetches its own permissions, members
// reconcile their encryption groups, and anyone who lost a channel loses
// their open socket to it and their place in its call.
func (a *API) afterBroadAccessChange(ctx context.Context) {
	a.NotifyPermsChanged("")
	for _, userID := range a.hub.ChannelUsers() {
		a.closeLostChannels(ctx, userID)
	}
	a.kickLostFromAllVoice()
}

// auditGroup records a group change. A failure is logged, not returned:
// the change itself has already happened.
func (a *API) auditGroup(ctx context.Context, actorID, subjectID, groupID, groupName, action, detail string) {
	var subject, group *string
	if subjectID != "" {
		subject = &subjectID
	}
	if groupID != "" {
		group = &groupID
	}
	if _, err := a.pool.Exec(ctx,
		`INSERT INTO perm_group_changes
		   (actor_id, subject_id, group_id, group_name, action, detail)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		actorID, subject, group, groupName, action, detail); err != nil {
		slog.Error("recording group change", "err", err)
	}
}

// startGuard starts an adminGuard (lastadmin.go) on tx, writing a 500 and
// returning false on failure.
func (a *API) startGuard(w http.ResponseWriter, r *http.Request, tx pgx.Tx, failMsg string) (adminGuard, bool) {
	guard, err := startAdminGuard(r.Context(), tx)
	if err != nil {
		slog.Error("checking administrators", "err", err)
		writeError(w, http.StatusInternalServerError, failMsg)
		return guard, false
	}
	return guard, true
}

// commitKeepingAdmin commits tx unless it left the server without an
// administrator. Writes the error response and returns false when it
// does not commit.
func (a *API) commitKeepingAdmin(
	w http.ResponseWriter, r *http.Request, tx pgx.Tx, guard adminGuard, failMsg string,
) bool {
	if err := guard.check(r.Context(), tx); err != nil {
		if errors.Is(err, errLastAdmin) {
			writeError(w, http.StatusConflict, lastAdminMessage)
			return false
		}
		slog.Error("checking administrators", "err", err)
		writeError(w, http.StatusInternalServerError, failMsg)
		return false
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing", "err", err)
		writeError(w, http.StatusInternalServerError, failMsg)
		return false
	}
	return true
}
