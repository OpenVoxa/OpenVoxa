-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- MLS identity.
--
-- An account is not a cryptographic identity. A DEVICE is. Each device
-- holds its own signature key and appears as its own leaf in every group
-- it belongs to, which is what lets someone read a channel on a desktop
-- and a phone without either knowing the other's private keys.
--
-- Only one device per account is implemented today, but the schema is
-- shaped for several from the start: retrofitting multi-device onto a
-- user-keyed design means rebuilding every group.

CREATE TABLE devices (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Shown to the user when they review or revoke their devices.
    -- Supplied by the client, never trusted for anything.
    label        TEXT        NOT NULL DEFAULT '',

    -- The device's MLS signature public key. The server keeps it so it
    -- can verify report signatures later, and so clients can detect a
    -- device whose key has changed underneath them.
    signature_key BYTEA      NOT NULL,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Set when the device is removed. The row survives so its past
    -- messages still resolve to a known device rather than to nothing.
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

-- Key packages.
--
-- To add someone to a group you need a key package they published in
-- advance, because they are probably offline when you add them. Each one
-- is SINGLE USE: reusing a key package means two groups share an initial
-- secret, which breaks the forward secrecy the whole design rests on.
--
-- Clients publish a batch and replenish as the pool drains. When it does
-- run dry there is a last-resort package, deliberately reusable, so that
-- adds fail degraded rather than outright. RFC 9420 allows this and is
-- explicit that it weakens forward secrecy for those joins, so it is a
-- fallback and not the normal path.
CREATE TABLE key_packages (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id      UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Opaque MLS wire format. The server routes it and never parses it.
    package        BYTEA       NOT NULL,

    is_last_resort BOOLEAN     NOT NULL DEFAULT false,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at     TIMESTAMPTZ,
    claimed_by     UUID        REFERENCES users(id) ON DELETE SET NULL
);

-- The claim path looks for an unclaimed package for a device, newest
-- first, so this index carries exactly that.
CREATE INDEX key_packages_available_idx
    ON key_packages (device_id, created_at)
    WHERE claimed_at IS NULL AND is_last_resort = false;

-- One last-resort package per device, replaced rather than accumulated.
CREATE UNIQUE INDEX key_packages_last_resort_idx
    ON key_packages (device_id)
    WHERE is_last_resort = true;

CREATE INDEX key_packages_user_idx ON key_packages (user_id);
