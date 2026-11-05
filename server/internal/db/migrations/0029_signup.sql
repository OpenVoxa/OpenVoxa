-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Who may create an account (signup.go; decisions.md Feature decisions,
-- "Server password"). Set by administrators in Server settings, Sign-Up.
--
--   signup_mode            open: anyone; password: the server password
--                          is needed; closed: no new accounts
--   signup_password        the current server password. Kept readable on
--                          purpose: administrators view and copy it to
--                          invite people, and it only lets someone create
--                          an account
--   signup_password_prev   the one before a scheduled rotation, still
--   signup_prev_until      accepted until this time (an hour), so a friend
--                          sent it just before doesn't miss out
--   signup_rotate_hours    rotate automatically this often; NULL: never
--   signup_rotated_at      when the password last changed
--
-- Existing servers stay open until an administrator picks otherwise.
ALTER TABLE server_settings
    ADD COLUMN signup_mode          TEXT NOT NULL DEFAULT 'open'
                                    CHECK (signup_mode IN ('open', 'password', 'closed')),
    ADD COLUMN signup_password      TEXT,
    ADD COLUMN signup_password_prev TEXT,
    ADD COLUMN signup_prev_until    TIMESTAMPTZ,
    ADD COLUMN signup_rotate_hours  INTEGER CHECK (signup_rotate_hours BETWEEN 1 AND 8760),
    ADD COLUMN signup_rotated_at    TIMESTAMPTZ,
    ADD CONSTRAINT signup_password_set CHECK (signup_mode <> 'password' OR signup_password IS NOT NULL);
