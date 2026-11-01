-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Editing messages (build order 13, M2). An edit replaces the body in
-- place; there is no edit history on the server. In an encrypted channel
-- the new body is a fresh MLS ciphertext the server cannot read, exactly
-- like the original.
--
-- edited_at is NULL for a message never edited. Clients use it to tell
-- whether the plaintext they archived is the latest version.
ALTER TABLE messages ADD COLUMN edited_at TIMESTAMPTZ;

-- History paging walks a channel backwards by (created_at, id). The
-- existing (channel_id, created_at DESC) index serves the range; id breaks
-- ties between messages in the same microsecond.
CREATE INDEX messages_channel_created_id_idx
    ON messages (channel_id, created_at DESC, id DESC);

DROP INDEX IF EXISTS messages_channel_created_idx;
