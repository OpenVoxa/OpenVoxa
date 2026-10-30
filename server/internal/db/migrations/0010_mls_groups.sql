-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- MLS groups.
--
-- One group per encrypted channel. The server holds no group state it can
-- read: it tracks an epoch number for ordering, stores opaque handshake
-- blobs so members who were offline can catch up, and holds welcome
-- messages until the devices they are addressed to collect them.

CREATE TABLE mls_groups (
    channel_id        UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,

    -- The group's current epoch, as asserted by whichever client last
    -- committed.
    --
    -- This is the ONE piece of MLS state the server reasons about, and it
    -- exists only to serialise commits. Two clients committing against
    -- the same epoch would fork the group irrecoverably, so a commit must
    -- state which epoch it builds on and is rejected if that is not
    -- current.
    --
    -- The value is not trusted, only ordered. ts-mls frames commits as
    -- private messages, so the server cannot read the real epoch out of
    -- them; a client that lies has its commit accepted here and then
    -- rejected cryptographically by every other member, which is a
    -- self-correcting failure.
    epoch             BIGINT      NOT NULL DEFAULT 0,

    created_by_device UUID        REFERENCES devices(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The handshake log.
--
-- Members who were offline when a commit landed replay from here to
-- catch up. New members do NOT read this: they get a welcome and the
-- ratchet tree, and see nothing from before they joined. That is the
-- forward secrecy guarantee working, recorded in docs/decisions.md.
CREATE TABLE mls_handshakes (
    id               BIGSERIAL PRIMARY KEY,
    channel_id       UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

    -- The epoch this commit was built ON, not the one it produces.
    -- A client at epoch N asks for everything with epoch >= N.
    epoch            BIGINT      NOT NULL,

    sender_device_id UUID        REFERENCES devices(id) ON DELETE SET NULL,
    blob             BYTEA       NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mls_handshakes_catchup_idx
    ON mls_handshakes (channel_id, epoch, id);

-- One commit per epoch per channel. Belt and braces alongside the
-- compare-and-swap: even if two requests somehow passed the epoch check,
-- only one of their log entries can exist.
CREATE UNIQUE INDEX mls_handshakes_one_per_epoch_idx
    ON mls_handshakes (channel_id, epoch);

-- Welcome messages, addressed to a specific device.
--
-- Held until collected because the recipient is almost certainly offline
-- when they are added; that is the whole reason key packages are
-- published in advance.
--
-- The ratchet tree is stored alongside because a joiner needs both, and
-- splitting them across two fetches would mean a window where a welcome
-- is useless.
CREATE TABLE mls_welcomes (
    id                  BIGSERIAL PRIMARY KEY,
    channel_id          UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    recipient_device_id UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

    welcome             BYTEA       NOT NULL,
    ratchet_tree        BYTEA       NOT NULL,

    -- The epoch the joiner lands in, so they know where to resume the
    -- handshake log.
    epoch               BIGINT      NOT NULL,

    sender_device_id    UUID        REFERENCES devices(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at          TIMESTAMPTZ
);

CREATE INDEX mls_welcomes_pending_idx
    ON mls_welcomes (recipient_device_id, created_at)
    WHERE claimed_at IS NULL;

-- A device is added to a channel once. A second pending welcome for the
-- same pair means something has gone wrong, and failing loudly beats
-- having a device join twice into divergent states.
CREATE UNIQUE INDEX mls_welcomes_one_pending_idx
    ON mls_welcomes (channel_id, recipient_device_id)
    WHERE claimed_at IS NULL;
