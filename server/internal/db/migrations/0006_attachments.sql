-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Attachments are split into two tables because the bytes and the
-- reference to them have different lifetimes.
--
-- blobs is content-addressed: the primary key is the SHA-256 of the
-- contents, so the same file uploaded by ten people is stored once. The
-- row exists while at least one attachment references it.
--
-- attachments is the per-message reference, carrying the filename and
-- type the uploader supplied. Two people can attach identical bytes under
-- different names and neither sees the other's.
--
-- Note that content addressing is a deduplication mechanism, not a
-- privacy one: a hash collision check reveals that someone else has
-- uploaded the same file. Once channels are encrypted, clients will
-- encrypt attachment bytes before upload, which breaks deduplication
-- across users and is the correct tradeoff.

CREATE TABLE blobs (
    hash       BYTEA PRIMARY KEY,
    size       BIGINT      NOT NULL CHECK (size >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL until the message that carries it is sent. Uploads happen
    -- first so the client can show progress and the server can reject an
    -- oversized file before anyone types anything. A row that stays NULL
    -- is an abandoned upload and gets swept.
    message_id   UUID        REFERENCES messages(id) ON DELETE CASCADE,

    channel_id   UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    uploader_id  UUID        REFERENCES users(id) ON DELETE SET NULL,

    blob_hash    BYTEA       NOT NULL REFERENCES blobs(hash),

    -- As supplied by the uploader. Never used to build a path on disk:
    -- the blob's location comes from its hash, so a filename of
    -- "../../etc/passwd" is just an odd label.
    filename     TEXT        NOT NULL,
    content_type TEXT        NOT NULL,
    size         BIGINT      NOT NULL,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_blob_idx    ON attachments (blob_hash);

-- Finds abandoned uploads for the sweep.
CREATE INDEX attachments_orphan_idx ON attachments (created_at)
    WHERE message_id IS NULL;
