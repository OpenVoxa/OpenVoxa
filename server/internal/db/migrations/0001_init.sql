-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Initial schema.
--
-- Note on messages.body: BYTEA, not TEXT, from the very first migration.
-- Plaintext channels store UTF-8 bytes here; encrypted channels will store
-- MLS ciphertext in the same column. Enabling encryption later then needs
-- no migration and no dual-column awkwardness.

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Set when the account is deleted. Crypto-shredding destroys the user's
    -- key material and leaves this tombstone so reply chains stay intact.
    deleted_at    TIMESTAMPTZ
);

CREATE TABLE channels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    kind        TEXT        NOT NULL CHECK (kind IN ('text', 'voice')),

    -- Whether message bodies in this channel are end-to-end encrypted.
    -- Admin-controlled per channel, surfaced to users as a badge.
    encrypted   BOOLEAN     NOT NULL DEFAULT false,

    -- NULL means messages are kept indefinitely. Otherwise messages older
    -- than this are purged. Displayed in the channel so users know before
    -- they post.
    retention   INTERVAL,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

    -- Nullable so a shredded author leaves the message structurally intact.
    author_id  UUID        REFERENCES users(id) ON DELETE SET NULL,

    body       BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_channel_created_idx
    ON messages (channel_id, created_at DESC);

-- One channel to talk in while the rest of the system is built.
INSERT INTO channels (name, kind) VALUES ('general', 'text');
