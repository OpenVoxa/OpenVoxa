-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Direct messages (dms.go; decisions.md Feature decisions, "Direct
-- messages"). A DM is a channels row of kind 'dm', always encrypted,
-- visible only to its two people (access.go): administrators get no way
-- in, so they are never in its MLS group.

ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check
    CHECK (kind IN ('text', 'voice', 'dm'));
ALTER TABLE channels ADD CONSTRAINT channels_dm_encrypted
    CHECK (kind <> 'dm' OR encrypted);

-- The two people in a DM, as an ordered pair so that each pair has at
-- most one DM. The channel's name is 'dm:<user_low>:<user_high>' too
-- (unique, and a ':' can't appear in an admin-made channel name), which
-- is what makes get-or-create safe under a race.
--
-- Accounts are soft-deleted (deleted_at), so the row outlives a deleted
-- account and the DM stays, read-only, with tombstones.
CREATE TABLE dm_channels (
    channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    user_low   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    CHECK (user_low < user_high),
    UNIQUE (user_low, user_high)
);

CREATE INDEX dm_channels_high_idx ON dm_channels (user_high);

-- Blocks, per person and silent: the blocked account isn't told. Either
-- direction makes their DM read-only for both.
CREATE TABLE user_blocks (
    blocker_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);

CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);

-- The new switch. Member gets it by default so ordinary accounts can DM;
-- administrators take it from a group (or move someone out of Member) to
-- stop them. Staff can always DM (access.go). Matched by name: a renamed
-- group is left alone.
UPDATE perm_groups
   SET permissions = array_append(permissions, 'direct_messages')
 WHERE name = 'Member'
   AND NOT ('direct_messages' = ANY (permissions));
