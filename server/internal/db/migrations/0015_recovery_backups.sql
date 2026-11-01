-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Recovery backups (docs/decisions.md, build order 13: "Recovery key v1 =
-- history backup only"). A user's client encrypts its local plaintext
-- archive with a key derived from their recovery key and uploads it here
-- in chunks. The server stores the bytes and never reads them: it holds
-- no key, and chunk names are client-chosen opaque strings, so it does
-- not even learn which channels a chunk covers.

-- One backup per account. Starting a new backup (a new recovery key)
-- replaces this row and drops every chunk, because chunks sealed under
-- the old key are useless with the new one. The id changes each time so
-- a device still uploading under the old key is refused.
CREATE TABLE recovery_backups (
    user_id    UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    -- Client-defined header: format version, KDF salt and parameters, a
    -- key check value. Opaque here; small.
    meta       BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recovery_chunks (
    user_id    UUID        NOT NULL REFERENCES recovery_backups(user_id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    body       BYTEA       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, name)
);
