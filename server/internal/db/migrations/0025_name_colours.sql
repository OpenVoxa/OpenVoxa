-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Username colours by group (namecolours.go; decisions.md Open items,
-- "Username colours by group").
--
-- A name is drawn in the colour of the account's highest group that has
-- one; NULL means the group adds no colour (plain text colour). Stored
-- as lowercase #rrggbb; the server also refuses colours below 3:1
-- contrast against the default background (#333333).
ALTER TABLE perm_groups
    ADD COLUMN colour TEXT CHECK (colour ~ '^#[0-9a-f]{6}$');

-- Defaults agreed with Ryan (2026-11-04). Matched by name: a group the
-- operator renamed is left alone. Everyone stays NULL (white).
UPDATE perm_groups SET colour = '#d96932' WHERE name = 'Administrator' AND colour IS NULL;
UPDATE perm_groups SET colour = '#ff00ff' WHERE name = 'Moderator'     AND colour IS NULL;
UPDATE perm_groups SET colour = '#00ffff' WHERE name = 'Member'        AND colour IS NULL;

-- The server-wide switch, on by default. Each user can still hide the
-- colours for themselves (Settings > Appearance, per browser).
ALTER TABLE server_settings
    ADD COLUMN name_colours BOOLEAN NOT NULL DEFAULT true;
