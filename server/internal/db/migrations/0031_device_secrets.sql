-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- The server's half of unlocking a browser that signed in by QR login
-- (signinlinks.go; decisions.md, Feature decisions, "Planned", "QR login
-- settled"). Such a browser never had the password, so its local data
-- key is wrapped under one of these secrets instead. The secret is handed
-- out only to a signed-in session of the same account, so the files
-- alone still need a sign-in to open. The first password sign-in on that
-- browser rewraps under the password and deletes the row.
--
-- Goes with the account (ON DELETE CASCADE). The server never sees the
-- data key, only this secret.
CREATE TABLE device_secrets (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret     BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX device_secrets_user ON device_secrets (user_id, created_at);
