-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Crypto-shredding, step S1 (docs/decisions.md, Encryption, "Account
-- deletion is crypto-shredding"). Plaintext-channel bodies are now stored
-- sealed under a key per author, kept in a folder outside the database
-- (OPENVOXA_KEY_DIR), so deleting the key makes the body unreadable in
-- every database backup too.
--
-- sealed says which rows hold sealed bytes. Encrypted-channel rows never
-- do: their body is MLS ciphertext the server cannot read anyway. Rows
-- written before this migration stay false until the upgrade step that
-- seals them (S2).
ALTER TABLE messages ADD COLUMN sealed BOOLEAN NOT NULL DEFAULT false;
