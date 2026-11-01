-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Device expiry (docs/decisions.md, Open items): devices unseen for 30
-- days are revoked by a sweep. Until now nothing updated
-- devices.last_seen_at, so it still holds each device's creation time.
-- Start every active device's clock now, or the first sweep would revoke
-- devices that are in daily use.

UPDATE devices SET last_seen_at = now() WHERE revoked_at IS NULL;
