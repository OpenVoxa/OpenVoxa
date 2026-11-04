-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Server mute (voicemute.go; decisions.md Feature decisions, "Server
-- mute"). A moderator takes away someone's microphone and screen share
-- audio in every voice channel, until unmuted or until expires_at.
--
-- Unlike force-PTT this is enforced by LiveKit, not by the client: the
-- join token leaves the microphone out of the allowed sources, and a
-- call in progress has it taken away through the admin API.
--
-- One row per muted account. An expired row means nothing; the sweep
-- deletes it and gives the microphone back in any live call.
CREATE TABLE voice_mutes (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    actor_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL: until a moderator unmutes.
    expires_at TIMESTAMPTZ
);

CREATE INDEX voice_mutes_expiry_idx ON voice_mutes (expires_at)
    WHERE expires_at IS NOT NULL;

-- The Moderator group gets the new switch by default, as with
-- manage_stickers (0024). Matched by name: a renamed group is left alone.
UPDATE perm_groups
   SET permissions = array_append(permissions, 'server_mute')
 WHERE name = 'Moderator'
   AND NOT ('server_mute' = ANY (permissions));
