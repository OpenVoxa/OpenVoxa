-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Screen share quality limit for the whole server (sharelimit.go;
-- decisions.md Open items, "Screen share bitrate ceiling").
--
-- The SFU sends one copy of a share to each viewer, so the host's upload
-- is roughly bitrate x viewers. An administrator may cap it. All three
-- NULL (the default, Ryan's call 2026-11-04) means no limit; otherwise
-- all three are set:
--   share_max_res  the "p" of a preset (1080 for 1080p): the shorter side
--                  of the picture, so portrait and ultrawide screens
--                  count by the same rule
--   share_max_fps  frames per second (client side only: LiveKit does not
--                  report frame rates)
--   share_max_kbps bitrate of the best layer, which is what each viewer
--                  receives at most
ALTER TABLE server_settings
    ADD COLUMN share_max_res  INTEGER CHECK (share_max_res  BETWEEN 144 AND 8640),
    ADD COLUMN share_max_fps  INTEGER CHECK (share_max_fps  BETWEEN 1 AND 240),
    ADD COLUMN share_max_kbps INTEGER CHECK (share_max_kbps BETWEEN 100 AND 1000000),
    ADD CONSTRAINT share_limit_all_or_none CHECK (
        (share_max_res IS NULL) = (share_max_fps IS NULL) AND
        (share_max_res IS NULL) = (share_max_kbps IS NULL));
