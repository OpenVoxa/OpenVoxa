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
)

var channelNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

type userSummary struct {
	ID        string          `json:"id"`
	Username  string          `json:"username"`
	Rank      int             `json:"rank"`
	Groups    []userGroupName `json:"groups"`
	CreatedAt time.Time       `json:"created_at"`
}

type userGroupName struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// listUsers is for anyone holding a permission switch. Staff need to see
// who they are moderating; ordinary users do not need a roster of every
// account. Everyone is left out of each account's groups: it is implied.
func (a *API) listUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.pool.Query(r.Context(),
		`SELECT u.id, u.username,
		        COALESCE((SELECT max(g.position) FROM user_perm_groups ug
		                    JOIN perm_groups g ON g.id = ug.group_id
		                   WHERE ug.user_id = u.id), 0),
		        COALESCE((SELECT json_agg(json_build_object('id', g.id, 'name', g.name)
		                            ORDER BY g.position DESC, g.name)
		                    FROM user_perm_groups ug
		                    JOIN perm_groups g ON g.id = ug.group_id
		                   WHERE ug.user_id = u.id), '[]'::json),
		        u.created_at
		   FROM users u WHERE u.deleted_at IS NULL ORDER BY u.username`)
	if err != nil {
		slog.Error("listing users", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list users")
		return
	}
	defer rows.Close()

	users := make([]userSummary, 0)
	for rows.Next() {
		var u userSummary
		if err := rows.Scan(&u.ID, &u.Username, &u.Rank, &u.Groups, &u.CreatedAt); err != nil {
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

type createChannelRequest struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Encrypted bool   `json:"encrypted"`

	// Access is the allow-list, as for PUT /channels/{id}/access. Omitted
	// means the old default: Everyone may view, and the groups new
	// accounts join (Member) may post.
	Access *[]struct {
		GroupID string `json:"group_id"`
		CanPost bool   `json:"can_post"`
	} `json:"access"`
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

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting channel creation", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create channel")
		return
	}
	defer tx.Rollback(r.Context())

	var c channelResponse
	err = tx.QueryRow(r.Context(),
		`INSERT INTO channels (name, kind, encrypted)
		 VALUES ($1, $2, $3)
		 RETURNING id, name, kind, encrypted`,
		req.Name, req.Kind, req.Encrypted,
	).Scan(&c.ID, &c.Name, &c.Kind, &c.Encrypted)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a channel with that name already exists")
			return
		}
		slog.Error("creating channel", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create channel")
		return
	}

	if req.Access != nil {
		var access channelAccessRequest
		for _, e := range *req.Access {
			if !uuidPattern.MatchString(e.GroupID) {
				writeError(w, http.StatusBadRequest, "invalid group id "+e.GroupID)
				return
			}
			access.Access = append(access.Access, e)
		}
		err = writeChannelAccess(r.Context(), tx, c.ID, access)
	} else {
		_, err = tx.Exec(r.Context(),
			`INSERT INTO channel_access (channel_id, group_id, can_post)
			 SELECT $1, id, auto_assign FROM perm_groups
			  WHERE is_everyone OR auto_assign`, c.ID)
	}
	if errors.Is(err, errUnknownGroup) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		slog.Error("writing channel access", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create channel")
		return
	}

	if err := tx.QueryRow(r.Context(),
		`SELECT `+channelAccessJSON+` FROM channels c WHERE c.id = $1`, c.ID,
	).Scan(&c.Access); err != nil {
		slog.Error("reading channel access", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create channel")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing channel", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create channel")
		return
	}

	c.Retention = "forever"
	// manage_channels does not by itself put the creator on the list.
	if p, err := a.channelPermsFor(r.Context(), sessionFrom(r.Context()), c.ID); err == nil {
		c.CanPost = p.CanPost
	}
	a.NotifyChannelChanged(c.ID)
	writeJSON(w, http.StatusCreated, c)
}

// deleteChannel removes a channel and, by cascade, every message in it.
// Needs manage_channels, and irreversible by design.
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
