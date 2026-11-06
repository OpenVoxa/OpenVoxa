-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Two-factor sign-in (twofactor.go; decisions.md, Feature decisions,
-- "Planned", two-factor). TOTP (RFC 6238) plus ten single-use backup
-- codes.
--
-- The server must read the TOTP secret to check codes, so it cannot be
-- hashed like a password. It is sealed under the account's own key
-- (internal/keystore), which lives outside the database: a database dump
-- alone yields no secrets, and deleting the account shreds them.
--
--   totp_secret        sealed secret, in use once totp_enabled_at is set
--   totp_pending       sealed secret from a setup not yet confirmed with
--                      a code; replaced by each new setup
--   totp_enabled_at    NULL: two-factor is off
--   totp_last_step     the 30-second step of the last accepted code, so
--                      a code cannot be used twice
--   totp_backup        sealed JSON list of the backup codes not yet used
ALTER TABLE users
    ADD COLUMN totp_secret     BYTEA,
    ADD COLUMN totp_pending    BYTEA,
    ADD COLUMN totp_enabled_at TIMESTAMPTZ,
    ADD COLUMN totp_last_step  BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN totp_backup     BYTEA,
    ADD CONSTRAINT totp_enabled_has_secret
        CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL);

-- Who must have two-factor, set in Server settings, Security:
--   off       nobody (anyone may still turn it on)
--   staff     anyone holding a permission switch
--   everyone  every account
-- Those it covers and who have none are held at the setup screen.
ALTER TABLE server_settings
    ADD COLUMN two_factor_required TEXT NOT NULL DEFAULT 'off'
               CHECK (two_factor_required IN ('off', 'staff', 'everyone'));
