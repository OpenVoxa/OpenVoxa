-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Server-wide settings an administrator changes from the client (build
-- order 13, M5 session C). One row, enforced by the CHECK on id: typed
-- columns rather than a key/value table, so each setting has a real type
-- and default.
--
-- modlog_archive_days: moderation log entries older than this show under
-- "Archived" instead of the main list. Display only; nothing is deleted.
CREATE TABLE server_settings (
    id                  BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    modlog_archive_days INTEGER NOT NULL DEFAULT 30
                        CHECK (modlog_archive_days BETWEEN 1 AND 3650)
);

INSERT INTO server_settings DEFAULT VALUES;
