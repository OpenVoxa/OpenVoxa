-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Tombstones.
--
-- When a message's content goes away but the message itself must stay, the
-- row survives with an empty body and this flag set. Reply chains keep
-- their shape, message counts stay consistent, and clients can render a
-- placeholder instead of an empty bubble.
--
-- Two things set it:
--
--   Account deletion. Today the body is destroyed outright because
--   channels are plaintext. Once channels are encrypted, deleting the
--   user's key material achieves the same thing without touching the row,
--   and this column marks the result either way.
--
--   Moderator removal of a single message, when that arrives.
--
-- Retention expiry is different: those rows are removed entirely. Nobody
-- needs to know a message existed thirty-one days ago in a channel that
-- keeps thirty.

ALTER TABLE messages
    ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT false;

-- Retention sweeps delete by age across all channels at once, so an index
-- on created_at alone earns its place alongside the per-channel one.
CREATE INDEX messages_created_idx ON messages (created_at);
