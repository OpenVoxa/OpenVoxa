-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Profiles (profiles.go; decisions.md Feature decisions, "User avatars
-- and profiles", stage 2). What the profile card shows beyond the
-- avatar (0037), the username, groups and join date. One row per
-- account, created the first time any of it is set; deleting the
-- account cascades.
--
--   bio             plain text, at most 300 characters, sealed under the
--                   account's keystore key like the avatar (seen by the
--                   whole server, so not end-to-end encrypted, but
--                   shredded with the account). NULL: no bio
--   show_last_seen  the Profile setting "Show when I was last online".
--                   Off hides it both ways: others don't see yours and
--                   you don't see theirs
--   last_seen_on    the UTC date the account last had the app open,
--                   written when its events socket opens and closes.
--                   Only a date, never a time, so nobody can work out
--                   when someone was online from it. Kept NULL while
--                   show_last_seen is off
CREATE TABLE user_profiles (
    user_id        UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bio            BYTEA,
    show_last_seen BOOLEAN     NOT NULL DEFAULT true,
    last_seen_on   DATE,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
