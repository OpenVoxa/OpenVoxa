-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- @mentions. The sender's client says who a message mentions, the server
-- keeps only those who may view the channel, and tells them.
--
-- This is the same list in every channel. In an encrypted channel the
-- server cannot read the body, so the list is the only way it can know;
-- the cost is that it learns WHO was mentioned, never what was said
-- (decisions.md, "Mentions are metadata the server sees").
--
-- Rows go when the message is deleted (handler), expires (cascade) or
-- either account is deleted (cascade, and purge for the author's).
CREATE TABLE message_mentions (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);

-- The channel list asks "newest mention of me in each channel".
CREATE INDEX message_mentions_user_idx ON message_mentions (user_id);
