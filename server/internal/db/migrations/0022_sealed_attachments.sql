-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Crypto-shredding, step S3 (docs/decisions.md, Encryption, "Account
-- deletion is crypto-shredding").
--
-- Attachments in plaintext channels (GIFs included) are stored sealed:
-- the bytes under a random key per file (internal/sealedfile), and that
-- key plus the real filename under the uploader's account key. file_key
-- and sealed_name hold those; filename then holds only the placeholder
-- 'file'. NULL file_key means stored as uploaded: encrypted channels
-- (the client already encrypted the bytes), GIFs in encrypted channels,
-- and rows the server has not converted yet (it does so at startup).
--
-- Every file now has its own key, so identical uploads no longer share a
-- blob in plaintext channels: deduplication there is gone, which also
-- stops it revealing that someone else uploaded the same file.
ALTER TABLE attachments
    ADD COLUMN file_key    BYTEA,
    ADD COLUMN sealed_name BYTEA;

-- Files from accounts that were deleted before this existed have no key
-- to seal under and should already be gone. Account deletion left them
-- behind; remove the rows, and the blob collector removes the bytes.
DELETE FROM attachments
 WHERE uploader_id IS NULL AND file_key IS NULL
   AND channel_id IN (SELECT id FROM channels WHERE NOT encrypted);
