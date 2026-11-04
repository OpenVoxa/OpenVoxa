-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- The last upload speed test of this server (uploadtest.go), shown in
-- Server settings > Voice and Video to suggest a screen share limit.
-- NULL until an administrator runs one.
ALTER TABLE server_settings
    ADD COLUMN upload_test_mbps DOUBLE PRECISION,
    ADD COLUMN upload_test_at   TIMESTAMPTZ,
    ADD COLUMN upload_test_site TEXT;
