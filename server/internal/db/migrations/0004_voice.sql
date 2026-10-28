-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Voice channels reuse the channels table; kind = 'voice' already exists
-- from 0001. What voice adds is a per-channel policy knob.

-- force_ptt makes every participant use push-to-talk regardless of their
-- own preference. Administrators and moderators set this on channels where
-- open mics cause problems (large channels, meetings).
--
-- Today this is advisory: the server tells the client and the client
-- obeys. Real enforcement means the server muting participants through
-- LiveKit's server API, which is a later piece of work. Treat the current
-- behaviour as a UX default, not a security control.
ALTER TABLE channels
    ADD COLUMN force_ptt BOOLEAN NOT NULL DEFAULT false;

-- A voice channel to join while the client is being built. Same permission
-- defaults as #general: anyone may listen, accounts may speak.
INSERT INTO channels (name, kind) VALUES ('voice-general', 'voice');
