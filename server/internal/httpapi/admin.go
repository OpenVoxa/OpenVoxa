// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

var channelNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

type userSummary struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

// listUsers is moderator-and-above. Moderators need to see who they are
// moderating; ordinary users do not need a roster of every account.
func (a *API) listUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.pool.Query(r.Context(),
		`SELECT id, username, role, created_at
		   FROM users WHERE deleted_at IS NULL ORDER BY username`)
	if err != nil {
		slog.Error("listing users", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list users")
		return
	}
	defer rows.Close()

	users := make([]userSummary, 0)
	for rows.Next() {
		var u userSummary
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &u.CreatedAt); err != nil {
			slog.Error("scanning user", "err", err)
			writeError(w, http.StatusInternalServerError, "could not list users")
			return
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		slog.Error("iterating users", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list users")
		return
	}

	writeJSON(w, http.StatusOK, users)
}

type setRoleRequest struct {
	Role string `json:"role"`
}

// setUserRole changes another account's role. Administrator only.
//
// Three rules, all enforced server-side:
//
//   - You cannot change your own role. Otherwise the audit log fills with
//     self-promotions and demotion-by-accident locks people out.
//   - You cannot act on someone of equal or higher rank. Administrators
//     cannot demote each other, so one compromised admin account cannot
//     take the server over by removing everyone else.
//   - You cannot grant a role above your own. Currently moot since only
//     administrators reach this endpoint, but it stays correct if the
//     endpoint is ever opened up.
func (a *API) setUserRole(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")

	var req setRoleRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	newRole, err := perm.Parse(req.Role)
	if err != nil {
		writeError(w, http.StatusBadRequest,
			"role must be one of: guest, user, moderator, administrator")
		return
	}

	if subjectID == actor.UserID {
		writeError(w, http.StatusForbidden, "you cannot change your own role")
		return
	}

	actorRole, err := perm.Parse(actor.Role)
	if err != nil {
		slog.Error("session carries an unknown role", "role", actor.Role)
		writeError(w, http.StatusInternalServerError, "could not change role")
		return
	}

	if !perm.AtLeast(actorRole, newRole) {
		writeError(w, http.StatusForbidden, "you cannot grant a role above your own")
		return
	}

	// Lock the subject row so two concurrent changes cannot interleave
	// between the rank check and the update.
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting role change", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change role")
		return
	}
	defer tx.Rollback(r.Context())

	var oldRole, username string
	err = tx.QueryRow(r.Context(),
		`SELECT role, username FROM users
		  WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
		subjectID,
	).Scan(&oldRole, &username)

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "user not found")
		return
	case err != nil:
		slog.Error("loading subject", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change role")
		return
	}

	subjectRole, err := perm.Parse(oldRole)
	if err != nil {
		slog.Error("stored role is unknown", "role", oldRole)
		writeError(w, http.StatusInternalServerError, "could not change role")
		return
	}

	if !perm.Outranks(actorRole, subjectRole) {
		writeError(w, http.StatusForbidden,
			"you cannot change the role of someone at or above your own rank")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE users SET role = $1 WHERE id = $2`, newRole.String(), subjectID,
	); err != nil {
		slog.Error("updating role", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change role")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`INSERT INTO role_changes (actor_id, subject_id, old_role, new_role)
		 VALUES ($1, $2, $3, $4)`,
		actor.UserID, subjectID, oldRole, newRole.String(),
	); err != nil {
		slog.Error("recording role change", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change role")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing role change", "err", err)
		writeError(w, http.StatusInternalServerError, "could not change role")
		return
	}

	// Logged with IDs rather than usernames, consistent with the rest of
	// the logging policy.
	slog.Info("role changed",
		"actor_id", actor.UserID, "subject_id", subjectID,
		"old_role", oldRole, "new_role", newRole.String())

	a.NotifyRoleChanged(subjectID, newRole.String())

	// After the event, so the subject's open connections hear about the
	// change before any of them are closed.
	a.closeLostChannels(r.Context(), subjectID)

	writeJSON(w, http.StatusOK, userSummary{
		ID: subjectID, Username: username, Role: newRole.String(),
	})
}

type createChannelRequest struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Encrypted   bool   `json:"encrypted"`
	MinRoleView string `json:"min_role_view"`
	MinRolePost string `json:"min_role_post"`
}

func (a *API) createChannel(w http.ResponseWriter, r *http.Request) {
	var req createChannelRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	req.Name = strings.ToLower(strings.TrimSpace(req.Name))
	if !channelNamePattern.MatchString(req.Name) {
		writeError(w, http.StatusBadRequest,
			"name must be 1-32 characters: lowercase letters, digits or hyphens")
		return
	}
	if req.Kind != "text" && req.Kind != "voice" {
		writeError(w, http.StatusBadRequest, "kind must be text or voice")
		return
	}

	// Empty means take the permissive default.
	if req.MinRoleView == "" {
		req.MinRoleView = perm.Guest.String()
	}
	if req.MinRolePost == "" {
		req.MinRolePost = perm.User.String()
	}

	viewRole, err := perm.Parse(req.MinRoleView)
	if err != nil {
		writeError(w, http.StatusBadRequest, "min_role_view is not a valid role")
		return
	}
	postRole, err := perm.Parse(req.MinRolePost)
	if err != nil {
		writeError(w, http.StatusBadRequest, "min_role_post is not a valid role")
		return
	}
	if perm.Outranks(viewRole, postRole) {
		writeError(w, http.StatusBadRequest,
			"min_role_post cannot be lower than min_role_view")
		return
	}

	var c channelResponse
	err = a.pool.QueryRow(r.Context(),
		`INSERT INTO channels (name, kind, encrypted, min_role_view, min_role_post)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, name, kind, encrypted, min_role_view, min_role_post`,
		req.Name, req.Kind, req.Encrypted, viewRole.String(), postRole.String(),
	).Scan(&c.ID, &c.Name, &c.Kind, &c.Encrypted, &c.MinRoleView, &c.MinRolePost)

	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a channel with that name already exists")
			return
		}
		slog.Error("creating channel", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create channel")
		return
	}

	c.Retention = "forever"
	a.NotifyChannelChanged(c.ID)
	writeJSON(w, http.StatusCreated, c)
}

// deleteChannel removes a channel and, by cascade, every message in it.
// Administrator only, and irreversible by design.
func (a *API) deleteChannel(w http.ResponseWriter, r *http.Request) {
	tag, err := a.pool.Exec(r.Context(),
		`DELETE FROM channels WHERE id = $1`, r.PathValue("id"))
	if err != nil {
		slog.Error("deleting channel", "err", err)
		writeError(w, http.StatusInternalServerError, "could not delete channel")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}

	a.NotifyChannelDeleted(r.PathValue("id"))
	w.WriteHeader(http.StatusNoContent)
}

// closeLostChannels closes a user's websockets on channels they may no
// longer view.
//
// A websocket is authorised once, at upgrade. Without this, a demoted
// account keeps reading a channel it just lost, and in an encrypted
// channel keeps receiving commit notices for a group it is about to be
// removed from. Connections to channels still allowed are left alone,
// so a demotion that changes nothing visible costs nothing.
func (a *API) closeLostChannels(ctx context.Context, userID string) {
	for _, channelID := range a.hub.UserChannels(userID) {
		ok, err := a.userCanView(ctx, userID, channelID)
		if err != nil {
			slog.Error("re-checking channel access", "err", err, "channel_id", channelID)
			continue
		}
		if !ok {
			n := a.hub.DisconnectUserFrom(userID, channelID)
			slog.Info("closed connections after losing access",
				"user_id", userID, "channel_id", channelID, "count", n)
		}
	}
}
