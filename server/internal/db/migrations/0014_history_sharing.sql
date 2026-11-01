-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Opt-in history sharing for encrypted channels (docs/decisions.md,
-- "History sharing is opt-in per channel"). Off by default: turning it
-- on weakens "new members see nothing from before they joined", and the
-- channel label says so.

ALTER TABLE channels
    ADD COLUMN history_sharing BOOLEAN NOT NULL DEFAULT false;

-- A bundle of earlier messages one member's client encrypted for a
-- device that was just added. The body is an MLS application message,
-- as opaque to the server as any other. Deleted when the recipient has
-- imported it, or by the sweep after a week.
CREATE TABLE mls_history_shares (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id          UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    recipient_device_id UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    sender_device_id    UUID        REFERENCES devices(id) ON DELETE SET NULL,
    body                BYTEA       NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One pending bundle per device and channel. When several members try
-- to share with the same newcomer, the first one wins.
CREATE UNIQUE INDEX mls_history_shares_one_pending
    ON mls_history_shares (channel_id, recipient_device_id);
