-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Crypto-shredding, step S2 (docs/decisions.md, Encryption, "Account
-- deletion is crypto-shredding").
--
-- A report keeps a copy of the reported words. They are the accused's
-- words, so they are now sealed under the accused's key like a message
-- body, and become unreadable when that account is deleted. The column
-- turns into bytes to hold the sealed form; claimed_sealed says which
-- rows have been converted. The server seals existing rows itself at
-- startup (it holds the keys, SQL does not).
ALTER TABLE reports
    ALTER COLUMN claimed_body DROP DEFAULT,
    ALTER COLUMN claimed_body TYPE BYTEA USING convert_to(claimed_body, 'UTF8'),
    ALTER COLUMN claimed_body SET DEFAULT ''::bytea,
    ADD COLUMN claimed_sealed BOOLEAN NOT NULL DEFAULT false;

-- Text whose author is already gone has no key to seal under and should
-- not exist at all. Account deletion blanked message bodies but never
-- touched report copies, so blank those now. Messages are covered for
-- completeness: deletion already blanked them.
UPDATE reports SET claimed_body = ''::bytea
 WHERE accused_id IS NULL AND length(claimed_body) > 0;

UPDATE messages SET body = ''::bytea
 WHERE author_id IS NULL AND NOT sealed AND length(body) > 0
   AND channel_id IN (SELECT id FROM channels WHERE NOT encrypted);
