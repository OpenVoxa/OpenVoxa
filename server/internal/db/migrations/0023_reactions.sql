-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Emoji reactions on messages (reactions.go).
--
-- Stored in the clear in every channel, encrypted ones included: the
-- server sees who reacted with which emoji to which message, never what
-- the message says. Same kind of metadata as mentions (decisions.md,
-- "Reactions are metadata the server sees").
--
-- Rows go when the message is deleted (handler), expires (cascade), its
-- author is purged (purge) or the reacting account is deleted (cascade).
CREATE TABLE message_reactions (
    message_id UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, emoji, user_id)
);

-- Account deletion removes someone's reactions everywhere.
CREATE INDEX message_reactions_user_idx ON message_reactions (user_id);
