-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A random secret per login session, the server's half of unlocking a
-- browser tab's local storage after a page refresh (decisions.md,
-- Encryption, "Local storage is encrypted under the password, with a
-- server-held half for refreshes").
--
-- The tab keeps its data key in sessionStorage encrypted under this
-- secret. The secret lives on the session row, so it goes when the
-- session does (logout, revocation, expiry, account deletion), and any
-- copy the browser left behind becomes unreadable. The server never sees
-- the data key, only this secret.
--
-- NULL until the client first asks for it; created then (sessionsecret.go).
ALTER TABLE sessions ADD COLUMN unlock_secret BYTEA;
