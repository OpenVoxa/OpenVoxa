// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// This file is the one place that answers "may this account view this
// channel?". Everything that grants or checks channel access - the
// websocket, voice tokens, the MLS endpoints, and the list of devices
// that belong in a channel's encryption group - goes through it, so that
// custom permission groups (build-order step 12) change the answer here
// and nowhere else.
//
// The rule today has two forms that must agree:
//
//   - channelPermsFor, in Go, for the caller. Their session has already
//     been checked for deletion and bans by requireAuth, so only the role
//     comparison is left.
//   - viewerJoins + viewerFilter, in SQL, for OTHER accounts, where the
//     deletion and ban checks have to be made here. Used for the allowed
//     device list, welcome recipients and key package claims.
//
// listChannels in httpapi.go still filters with its own copy of the rank
// comparison; it goes when custom groups replace roles.

// errChannelNotFound covers both a missing channel and one the caller may
// not view. Callers answer 404 for either, so a hidden channel is not
// confirmed to exist.
var errChannelNotFound = errors.New("channel not found")

// channelPerms is what the caller may do in one channel.
type channelPerms struct {
	Kind     string
	ForcePTT bool
	CanPost  bool
}

// channelPermsFor answers the access question for the caller, given the
// role from their session. It returns errChannelNotFound when the channel
// does not exist or the caller may not view it. Any other error is an
// internal failure, already logged-worthy by the caller.
func (a *API) channelPermsFor(
	ctx context.Context, sessionRole string, channelID string,
) (channelPerms, error) {
	role, err := perm.Parse(sessionRole)
	if err != nil {
		return channelPerms{}, fmt.Errorf("session carries an unknown role %q", sessionRole)
	}

	var out channelPerms
	var minView, minPost string
	err = a.pool.QueryRow(ctx,
		`SELECT kind, min_role_view, min_role_post, force_ptt
		   FROM channels WHERE id = $1`,
		channelID,
	).Scan(&out.Kind, &minView, &minPost, &out.ForcePTT)
	if errors.Is(err, pgx.ErrNoRows) {
		return channelPerms{}, errChannelNotFound
	}
	if err != nil {
		return channelPerms{}, fmt.Errorf("looking up channel: %w", err)
	}

	viewRole, err := perm.Parse(minView)
	if err != nil {
		return channelPerms{}, fmt.Errorf("channel %s has an unknown min_role_view", channelID)
	}
	if !perm.AtLeast(role, viewRole) {
		return channelPerms{}, errChannelNotFound
	}

	postRole, err := perm.Parse(minPost)
	if err != nil {
		return channelPerms{}, fmt.Errorf("channel %s has an unknown min_role_post", channelID)
	}
	out.CanPost = perm.AtLeast(role, postRole)

	return out, nil
}

// The SQL form of the rule. $1 is always the channel ID. An account may
// view a channel when it is not deleted, not under an active ban, and its
// role ranks at least the channel's min_role_view.
//
// Bans are checked here, not just at login, because this answers for
// accounts that are not the caller: a banned user's devices must drop off
// the allowed list so that reconciliation removes them from the group.
const viewerJoins = `
	  FROM channels c
	  JOIN roles cv ON cv.name = c.min_role_view
	  JOIN users u  ON u.deleted_at IS NULL
	  JOIN roles ur ON ur.name = u.role AND ur.rank >= cv.rank`

const viewerFilter = `
	 WHERE c.id = $1
	   AND NOT EXISTS (
	         SELECT 1 FROM bans b
	          WHERE b.user_id = u.id
	            AND (b.expires_at IS NULL OR b.expires_at > now())
	   )`

// userCanView answers the access question for an account other than the
// caller.
func (a *API) userCanView(ctx context.Context, userID, channelID string) (bool, error) {
	var ok bool
	err := a.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1`+viewerJoins+viewerFilter+`
		    AND u.id::text = $2)`,
		channelID, userID,
	).Scan(&ok)
	return ok, err
}

// allowedDevice is a device that belongs in a channel's encryption group.
type allowedDevice struct {
	DeviceID string `json:"device_id"`
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	Label    string `json:"label"`
}

// allowedDevices lists every non-revoked device of every account that may
// view the channel. When only is non-nil the result is limited to those
// device IDs, which is how a commit's welcome recipients are checked
// against exactly the same rule the reconciling client was given.
//
// IDs are compared as text so that a malformed ID from a client is simply
// not allowed, rather than a Postgres cast error.
func (a *API) allowedDevices(
	ctx context.Context, channelID string, only []string,
) ([]allowedDevice, error) {
	rows, err := a.pool.Query(ctx,
		`SELECT d.id::text, u.id::text, u.username, d.label`+viewerJoins+`
		  JOIN devices d ON d.user_id = u.id AND d.revoked_at IS NULL`+viewerFilter+`
		    AND ($2::text[] IS NULL OR d.id::text = ANY($2::text[]))
		  ORDER BY u.username, d.created_at`,
		channelID, only,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]allowedDevice, 0)
	for rows.Next() {
		var d allowedDevice
		if err := rows.Scan(&d.DeviceID, &d.UserID, &d.Username, &d.Label); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
