-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- External join and group reset (build-order step 11, step 8).
--
-- A permitted device joins with no member online by building an external
-- commit from the group's published GroupInfo (RFC 9420). Whoever
-- commits uploads a fresh one, because every commit makes the previous
-- one useless. And a group nobody permitted can commit to is replaced,
-- not rescued (docs/decisions.md, Encryption).

ALTER TABLE mls_groups
    -- Bumped each time the group is replaced. The client puts it in the
    -- MLS group ID, so a device holding state from a replaced group can
    -- tell, and every commit names it so a stale device cannot commit
    -- into the new group by matching its epoch number by accident.
    ADD COLUMN generation       BIGINT NOT NULL DEFAULT 0,

    -- The newest GroupInfo a member uploaded, with the ratchet tree
    -- inside it. Opaque, like everything else here: public data that lets
    -- a permitted device build a join commit, not read anything. Handed
    -- only to accounts that may view the channel.
    ADD COLUMN group_info       BYTEA,

    -- The epoch group_info belongs to. Usable for a join only while it
    -- equals epoch; an older one is what lets the server allow a reset.
    ADD COLUMN group_info_epoch BIGINT;
