-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Two corrections to the identity model, found when building the client.
--
-- 1. The device ID is carried inside the MLS credential, so it has to
--    exist before the key package is generated. A server-assigned ID
--    would mean registering, then regenerating every key package to put
--    the new ID in the credential. Clients therefore supply the ID.
--
--    Nothing is lost: a device ID is an identifier, not a secret, and the
--    server still enforces uniqueness and ownership. A client that picks
--    an ID already in use is simply rejected.
--
-- 2. signature_key becomes nullable. Whether a device has ONE stable
--    signature key across all its key packages depends on the MLS
--    implementation, and ts-mls generates key material inside
--    generateKeyPackage rather than taking a supplied identity key. Until
--    that is settled, storing a single key per device would be recording
--    something that may not be true.
--
--    The column stays because report verification in encrypted channels
--    will need it. It is left empty rather than filled with a guess.

ALTER TABLE devices
    ALTER COLUMN signature_key DROP NOT NULL;

COMMENT ON COLUMN devices.signature_key IS
    'MLS signature public key, when the implementation exposes a stable '
    'one per device. Nullable until that is confirmed. Needed for report '
    'verification in encrypted channels.';
