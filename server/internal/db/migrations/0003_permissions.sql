-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Roles are ordered rather than a set of independent flags:
--
--   guest < user < moderator < administrator
--
-- A check is therefore "is your role at least X", which keeps the whole
-- permission system to one comparison. More granular per-permission grants
-- can be layered on later without changing this; starting granular would
-- mean building a permission matrix before we know what it needs to hold.

CREATE TABLE roles (
    name TEXT PRIMARY KEY,
    rank INTEGER NOT NULL UNIQUE
);

INSERT INTO roles (name, rank) VALUES
    ('guest',         0),
    ('user',          1),
    ('moderator',     2),
    ('administrator', 3);

ALTER TABLE users
    ADD COLUMN role TEXT NOT NULL DEFAULT 'user' REFERENCES roles(name);

-- Per-channel minimums. The defaults are deliberately open: anyone, even a
-- guest, can read; anyone with a real account can post. A channel is
-- restricted by raising these, not by maintaining a membership list.
ALTER TABLE channels
    ADD COLUMN min_role_view TEXT NOT NULL DEFAULT 'guest' REFERENCES roles(name),
    ADD COLUMN min_role_post TEXT NOT NULL DEFAULT 'user'  REFERENCES roles(name);

CREATE INDEX users_role_idx ON users (role);

-- Audit log for permission changes. Who changed whose role, when, and from
-- what. An administrator quietly promoting themselves should leave a trace
-- that other administrators can see.
CREATE TABLE role_changes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
    subject_id UUID        REFERENCES users(id) ON DELETE SET NULL,
    old_role   TEXT        NOT NULL,
    new_role   TEXT        NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX role_changes_subject_idx ON role_changes (subject_id, changed_at DESC);
