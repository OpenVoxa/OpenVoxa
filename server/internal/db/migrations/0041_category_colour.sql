-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A category header's text colour (categories.go), set by manage_channels
-- and the same for everyone. Lowercase #rrggbb with the same contrast rule
-- as name colours (namecolours.go, checkNameColour); NULL: the default
-- muted grey.
ALTER TABLE channel_categories
    ADD COLUMN colour TEXT CHECK (colour ~ '^#[0-9a-f]{6}$');
