-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- User avatars (avatars.go; decisions.md Feature decisions, "User
-- avatars and profiles", stage 1). One picture per account, set in
-- Settings, Profile. Seen by everyone signed in to this server, so not
-- end-to-end encrypted (like usernames), but sealed under the account's
-- keystore key, so deleting the account shreds it in database backups
-- too.
--
--   image       the sealed bytes of a square PNG or WebP, cropped and
--               shrunk to 256 x 256 in the user's browser. Small, so kept
--               in the row rather than the blob store (like the server
--               icon, migration 0033)
--   image_type  image/png or image/webp, read from the bytes at upload
--   version     from a sequence, never reused: the image URL carries it,
--               so clients cache a version for good, and removing and
--               re-adding an avatar can't bring an old cached one back
--
-- Removing an avatar deletes the row; deleting the account cascades.
CREATE SEQUENCE user_avatar_version_seq;

CREATE TABLE user_avatars (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    image      BYTEA       NOT NULL,
    image_type TEXT        NOT NULL CHECK (image_type IN ('image/png', 'image/webp')),
    version    BIGINT      NOT NULL DEFAULT nextval('user_avatar_version_seq'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
