-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- The server's own name and icon (serverinfo.go; decisions.md Feature
-- decisions, "Server name and icon"). Set by administrators in Server
-- settings, General; shown in the desktop app's server pane, the browser
-- tab and the sign-in page. Public: GET /api/v1/server-info needs no
-- sign-in, since the pane shows them before anyone signs in.
--
--   server_name   up to 40 characters; '' means none (the address shows)
--   icon          a square PNG or WebP, cropped and shrunk to 256 x 256 in
--                 the administrator's browser. Small, so kept in the row
--                 rather than the blob store
--   icon_type     image/png or image/webp, read from the bytes at upload
--   icon_version  bumped on every change; the icon URL carries it, so
--                 caches never show an old icon
ALTER TABLE server_settings
    ADD COLUMN server_name  TEXT NOT NULL DEFAULT '',
    ADD COLUMN icon         BYTEA,
    ADD COLUMN icon_type    TEXT CHECK (icon_type IN ('image/png', 'image/webp')),
    ADD COLUMN icon_version INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT icon_has_type CHECK ((icon IS NULL) = (icon_type IS NULL));
