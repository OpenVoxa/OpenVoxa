-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Custom status (statuses.go; decisions.md Feature decisions, "User
-- avatars and profiles", stage 2b). An optional emoji plus up to 60
-- characters, shown on the profile card and under the name in voice
-- channels.
--
--   status             JSON {"emoji": "...", "text": "..."} sealed under
--                      the account's keystore key like the bio (seen by
--                      the whole server, shredded with the account).
--                      NULL: no status
--   status_expires_at  when the server clears it ("Clear after" 1 hour,
--                      4 hours or Today); NULL: kept until changed
ALTER TABLE user_profiles
    ADD COLUMN status            BYTEA,
    ADD COLUMN status_expires_at TIMESTAMPTZ;

-- The expiry sweep looks only at statuses that will run out.
CREATE INDEX user_profiles_status_expires_at ON user_profiles (status_expires_at)
    WHERE status_expires_at IS NOT NULL;
