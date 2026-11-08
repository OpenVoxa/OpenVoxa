// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// This file is the one place that answers "may this account view this
// channel?". Everything that grants or checks channel access - the
// websocket, voice tokens, the MLS endpoints, the channel list, and the
// list of devices that belong in a channel's encryption group - goes
// through it.
//
// The rule (migration 0012): an account may view a channel when one of
// its groups (Everyone included) is on the channel's allow-list, or one
// of its groups carries the administrator switch. It may post when such a
// group's entry has can_post, or again with administrator. One SQL form
// serves the caller and other accounts alike; only the ban and deletion
// checks differ, because requireAuth has already made them for the
// caller.
//
// Direct messages (kind 'dm', migration 0036) follow their own rule and
// never the administrator path: a DM is visible to its two people only,
// and since allowedDevices comes from this same rule, nobody else's
// devices can ever be added to its encryption group. Posting in one
// needs both people still able to send DMs (mayDMSQL) and no block in
// either direction; otherwise it is read-only for both.

// errChannelNotFound covers both a missing channel and one the caller may
// not view. Callers answer 404 for either, so a hidden channel is not
// confirmed to exist.
var errChannelNotFound = errors.New("channel not found")

// channelPerms is what the caller may do in one channel.
type channelPerms struct {
	Kind      string
	Encrypted bool
	ForcePTT  bool
	CanPost   bool
}

// isAdminSQL, canViewSQL and canPostSQL are boolean expressions over an
// account u and a channel c; both aliases must be in scope.
const isAdminSQL = `
	EXISTS (SELECT 1 FROM effective_groups eg
	          JOIN perm_groups g ON g.id = eg.group_id
	         WHERE eg.user_id = u.id
	           AND 'administrator' = ANY(g.permissions))`

const canViewSQL = `(CASE WHEN c.kind = 'dm' THEN ` + isDMMemberSQL + `
	ELSE (` + isAdminSQL + `
	OR EXISTS (SELECT 1 FROM channel_access ca
	             JOIN effective_groups eg ON eg.group_id = ca.group_id
	            WHERE ca.channel_id = c.id AND eg.user_id = u.id)) END)`

const canPostSQL = `(CASE WHEN c.kind = 'dm' THEN ` + dmCanPostSQL + `
	ELSE (` + isAdminSQL + `
	OR EXISTS (SELECT 1 FROM channel_access ca
	             JOIN effective_groups eg ON eg.group_id = ca.group_id
	            WHERE ca.channel_id = c.id AND eg.user_id = u.id
	              AND ca.can_post)) END)`

// isDMMemberSQL: u is one of DM c's two people.
const isDMMemberSQL = `
	EXISTS (SELECT 1 FROM dm_channels dc
	         WHERE dc.channel_id = c.id AND u.id IN (dc.user_low, dc.user_high))`

// dmCanPostSQL: u is one of DM c's two people, neither has blocked the
// other, and both may still send DMs.
const dmCanPostSQL = `
	EXISTS (SELECT 1 FROM dm_channels dc
	         WHERE dc.channel_id = c.id AND u.id IN (dc.user_low, dc.user_high)
	           AND NOT ` + dmBlockedSQL + `
	           AND NOT EXISTS (SELECT 1 FROM users x
	                            WHERE x.id IN (dc.user_low, dc.user_high)
	                              AND NOT (` + mayDMSQL + `)))`

// dmBlockedSQL: either of dm_channels row dc's people blocks the other.
const dmBlockedSQL = `
	EXISTS (SELECT 1 FROM user_blocks ub
	         WHERE (ub.blocker_id = dc.user_low AND ub.blocked_id = dc.user_high)
	            OR (ub.blocker_id = dc.user_high AND ub.blocked_id = dc.user_low))`

// mayDMSQL: account x may send direct messages. It exists, isn't under
// an active ban, and holds the direct_messages switch or any staff switch
// (Administrator included). The list is every switch in perm.All, which
// TestDMSwitchList keeps in step; a name not on it, such as a corrupt
// one, grants nothing.
const mayDMSQL = `
	x.deleted_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM bans b
	                 WHERE b.user_id = x.id
	                   AND (b.expires_at IS NULL OR b.expires_at > now()))
	AND EXISTS (SELECT 1 FROM effective_groups eg
	              JOIN perm_groups g ON g.id = eg.group_id
	             WHERE eg.user_id = x.id
	               AND g.permissions && ` + dmSwitchesSQL + `)`

const dmSwitchesSQL = `ARRAY['administrator', 'manage_groups', 'manage_channels',
	'delete_messages', 'view_reports', 'ban', 'force_ptt', 'server_mute',
	'move_members', 'manage_stickers', 'direct_messages']::text[]`

// hasMessages reports whether a channel kind carries messages: text
// channels and direct messages.
func hasMessages(kind string) bool { return kind == "text" || kind == "dm" }

const accessSQL = canViewSQL + `, ` + canPostSQL

// channelPermsFor answers the access question for the caller. It returns
// errChannelNotFound when the channel does not exist or the caller may
// not view it. Any other error is an internal failure.
func (a *API) channelPermsFor(
	ctx context.Context, session Session, channelID string,
) (channelPerms, error) {
	var out channelPerms
	var canView bool
	err := a.pool.QueryRow(ctx,
		`SELECT c.kind, c.encrypted, c.force_ptt,`+accessSQL+`
		   FROM channels c, users u
		  WHERE c.id = $1 AND u.id = $2`,
		channelID, session.UserID,
	).Scan(&out.Kind, &out.Encrypted, &out.ForcePTT, &canView, &out.CanPost)
	if errors.Is(err, pgx.ErrNoRows) {
		return channelPerms{}, errChannelNotFound
	}
	if err != nil {
		return channelPerms{}, fmt.Errorf("looking up channel: %w", err)
	}
	if !canView {
		return channelPerms{}, errChannelNotFound
	}
	return out, nil
}

// The form of the rule for OTHER accounts. $1 is always the channel ID.
// An account may view a channel when it is not deleted, not under an
// active ban, and the rule above allows it.
//
// Bans are checked here, not just at login, because this answers for
// accounts that are not the caller: a banned user's devices must drop off
// the allowed list so that reconciliation removes them from the group.
const viewerJoins = `
	  FROM channels c
	  JOIN users u ON u.deleted_at IS NULL`

const viewerFilter = `
	 WHERE c.id = $1
	   AND ` + canViewSQL + `
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
