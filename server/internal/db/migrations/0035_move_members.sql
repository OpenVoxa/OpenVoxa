-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Move members (voicemove.go; decisions.md Feature decisions, "Move and
-- disconnect"): move someone in a call to another voice channel, or
-- disconnect them. No table: a move is an instruction to the client plus
-- a LiveKit removal, recorded in the moderation log.
--
-- The Moderator group gets the new switch by default, as with
-- server_mute (0028). Administrator implies every switch already.
-- Matched by name: a renamed group is left alone.
UPDATE perm_groups
   SET permissions = array_append(permissions, 'move_members')
 WHERE name = 'Moderator'
   AND NOT ('move_members' = ANY (permissions));
