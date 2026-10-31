-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Custom permission groups replace the fixed four roles (build-order
-- step 12; decided by Ryan 2026-10-30 and 2026-10-31).
--
--   * A group carries permission switches (perm.All in Go). An account's
--     powers are the union of its groups' switches. Rank grants nothing.
--   * Groups are ranked by position. You may only act on accounts and
--     groups strictly below your highest group.
--   * Each channel lists the groups that may view it and, of those, which
--     may post. No deny rules. Holders of the administrator switch see
--     every channel.
--   * Everyone is a built-in group every account is implicitly in. It
--     replaces the guest role: a channel open to Everyone is public.
--
-- The existing roles convert so that nothing behaves differently after
-- the upgrade: Member (user), Moderator, Administrator.

CREATE TABLE perm_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    -- Higher is more senior. Everyone is 0; ties do not outrank.
    position    INTEGER     NOT NULL CHECK (position >= 0),
    permissions TEXT[]      NOT NULL DEFAULT '{}',
    -- Exactly one row: the implicit group every account is in.
    is_everyone BOOLEAN     NOT NULL DEFAULT false,
    -- New accounts are put in these groups at registration.
    auto_assign BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT is_everyone OR (position = 0 AND NOT auto_assign))
);

CREATE UNIQUE INDEX perm_groups_one_everyone ON perm_groups (is_everyone)
    WHERE is_everyone;

CREATE TABLE user_perm_groups (
    user_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID        NOT NULL REFERENCES perm_groups(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, group_id)
);

CREATE INDEX user_perm_groups_group_idx ON user_perm_groups (group_id);

-- A row means the group may view the channel; can_post adds posting
-- (and speaking, in a voice channel).
CREATE TABLE channel_access (
    channel_id UUID    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    group_id   UUID    NOT NULL REFERENCES perm_groups(id) ON DELETE CASCADE,
    can_post   BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (channel_id, group_id)
);

CREATE INDEX channel_access_group_idx ON channel_access (group_id);

-- Every group an account is in, Everyone included, for every account
-- that still exists. All access checks go through this.
CREATE VIEW effective_groups AS
    SELECT ug.user_id, ug.group_id
      FROM user_perm_groups ug
    UNION
    SELECT u.id, g.id
      FROM users u CROSS JOIN perm_groups g
     WHERE g.is_everyone;

-- Audit log, as role_changes was for roles. Group names are copied so the
-- trail survives a group being deleted.
CREATE TABLE perm_group_changes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
    subject_id UUID        REFERENCES users(id) ON DELETE SET NULL,
    group_id   UUID        REFERENCES perm_groups(id) ON DELETE SET NULL,
    group_name TEXT        NOT NULL,
    -- added / removed for memberships; created / edited / deleted for
    -- the group itself (subject_id NULL).
    action     TEXT        NOT NULL,
    detail     TEXT        NOT NULL DEFAULT '',
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX perm_group_changes_subject_idx
    ON perm_group_changes (subject_id, changed_at DESC);

-- ---------------------------------------------------------------- convert

INSERT INTO perm_groups (name, position, permissions, is_everyone, auto_assign) VALUES
    ('Everyone',      0,  '{}', true,  false),
    ('Member',        10, '{}', false, true),
    ('Moderator',     20, '{delete_messages,view_reports,ban,force_ptt}', false, false),
    ('Administrator', 30, '{administrator}', false, false);

-- Accounts stack groups, Discord-style: a moderator is a Member plus a
-- Moderator, so taking Moderator away later leaves an ordinary member.
-- Guests get nothing beyond Everyone.
INSERT INTO user_perm_groups (user_id, group_id)
SELECT u.id, g.id
  FROM users u
  JOIN perm_groups g ON g.name = 'Member'
 WHERE u.role IN ('user', 'moderator', 'administrator');

INSERT INTO user_perm_groups (user_id, group_id)
SELECT u.id, g.id
  FROM users u
  JOIN perm_groups g ON g.name = 'Moderator'
 WHERE u.role = 'moderator';

INSERT INTO user_perm_groups (user_id, group_id)
SELECT u.id, g.id
  FROM users u
  JOIN perm_groups g ON g.name = 'Administrator'
 WHERE u.role = 'administrator';

-- Channel minimums become allow-lists. Because groups stack, granting the
-- lowest qualifying group covers everyone above it. An administrator-only
-- minimum needs no row: the administrator switch sees every channel.
INSERT INTO channel_access (channel_id, group_id, can_post)
SELECT c.id, g.id,
       (SELECT rank FROM roles WHERE name = c.min_role_post)
         <= (SELECT rank FROM roles WHERE name = r.role)
  FROM channels c
  JOIN (VALUES ('guest', 'Everyone'), ('user', 'Member'),
               ('moderator', 'Moderator')) AS r(role, gname) ON true
  JOIN perm_groups g ON g.name = r.gname
 WHERE c.min_role_view = r.role;

-- Posting can need a higher group than viewing (for example view: guest,
-- post: user). Add the posting group where it differs from the viewing
-- one.
INSERT INTO channel_access (channel_id, group_id, can_post)
SELECT c.id, g.id, true
  FROM channels c
  JOIN (VALUES ('user', 'Member'), ('moderator', 'Moderator')) AS r(role, gname)
       ON c.min_role_post = r.role AND c.min_role_view <> r.role
  JOIN perm_groups g ON g.name = r.gname
ON CONFLICT (channel_id, group_id) DO UPDATE SET can_post = true;

-- The old columns go; the roles and role_changes tables stay as history.
ALTER TABLE users    DROP COLUMN role;
ALTER TABLE channels DROP COLUMN min_role_view,
                     DROP COLUMN min_role_post;
