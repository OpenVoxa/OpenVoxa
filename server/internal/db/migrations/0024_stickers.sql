-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Custom stickers (stickers.go; decisions.md Open items, "Custom
-- stickers").
--
-- One set for the whole server, uploaded by holders of manage_stickers.
-- A sticker is a contribution to the server, not its uploader's own
-- content: the image is stored in the clear (not sealed under the
-- uploader's key) and survives the uploader's account deletion, which
-- only clears uploader_id.
--
-- A message carries the sticker's id in its text (inside the ciphertext
-- in encrypted channels), so nothing here points at messages. Deleting a
-- sticker leaves those messages showing "sticker removed".
CREATE TABLE stickers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT        NOT NULL UNIQUE,
    alt          TEXT        NOT NULL DEFAULT '',
    blob_hash    BYTEA       NOT NULL REFERENCES blobs(hash),
    content_type TEXT        NOT NULL,
    size         BIGINT      NOT NULL,
    width        INTEGER     NOT NULL,
    height       INTEGER     NOT NULL,
    uploader_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The limits, changeable by an administrator. Defaults agreed with Ryan
-- (2026-11-04): 1 MB, 512 x 512 px, 100 stickers.
ALTER TABLE server_settings
    ADD COLUMN sticker_max_bytes INTEGER NOT NULL DEFAULT 1048576
        CHECK (sticker_max_bytes BETWEEN 16384 AND 10485760),
    ADD COLUMN sticker_max_px    INTEGER NOT NULL DEFAULT 512
        CHECK (sticker_max_px BETWEEN 64 AND 2048),
    ADD COLUMN sticker_max_count INTEGER NOT NULL DEFAULT 100
        CHECK (sticker_max_count BETWEEN 1 AND 1000);

-- The Moderator group gets the new switch by default. Administrator
-- implies it already. Matched by name: a group the operator renamed is
-- left alone, and they can add the switch by hand.
UPDATE perm_groups
   SET permissions = array_append(permissions, 'manage_stickers')
 WHERE name = 'Moderator'
   AND NOT ('manage_stickers' = ANY (permissions));
