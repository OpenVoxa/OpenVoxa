-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- The Home page and community rules (home.go; decisions.md Feature
-- decisions, "Home page and community rules"). Set by administrators in
-- Server settings, General.
--
--   home_welcome     the Welcome text, markdown; '' means none
--   home_rules       the Rules text, markdown; '' means none
--   home_version     bumped whenever the welcome, rules or banner change;
--                    people land on Home when it is above what they saw
--   rules_enforced   everyone must accept the current rules before doing
--                    anything else (needs rules text)
--   rules_version    bumped when an administrator asks everyone to accept
--                    changed rules; accepting records this number
--   banner           a wide PNG or WebP (16:9 to 4:1), cropped in the
--                    administrator's browser. Public: the sign-in page
--                    shows it. Kept in the row like the icon
--   banner_type      image/png or image/webp, read from the bytes
--   banner_version   bumped on every change; the banner URL carries it
ALTER TABLE server_settings
    ADD COLUMN home_welcome   TEXT NOT NULL DEFAULT '',
    ADD COLUMN home_rules     TEXT NOT NULL DEFAULT '',
    ADD COLUMN home_version   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN rules_enforced BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN rules_version  INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN banner         BYTEA,
    ADD COLUMN banner_type    TEXT CHECK (banner_type IN ('image/png', 'image/webp')),
    ADD COLUMN banner_version INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT banner_has_type CHECK ((banner IS NULL) = (banner_type IS NULL)),
    ADD CONSTRAINT rules_enforced_needs_rules CHECK (NOT rules_enforced OR home_rules <> '');

-- Per account: the Home version last seen (for the dot and landing) and
-- the rules version last accepted. 0: never.
ALTER TABLE users
    ADD COLUMN home_seen_version      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN rules_accepted_version INTEGER NOT NULL DEFAULT 0;
