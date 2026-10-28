-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Sessions are server-side state rather than self-contained tokens (JWTs).
-- Two reasons that matter for this project:
--
--   1. Revocation. Deleting a row ends a session immediately. A JWT stays
--      valid until it expires no matter what the server wants.
--   2. Account deletion. ON DELETE CASCADE means shredding an account drops
--      every session with it, with no window where a stale token still works.
--
-- token_hash stores SHA-256 of the token, never the token itself. A database
-- dump therefore does not hand an attacker working sessions.

CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   BYTEA       NOT NULL UNIQUE,

    -- User-supplied label so people can tell their devices apart when we
    -- build a session list. Multi-device is decision 4; this is the stub.
    device_name  TEXT,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
