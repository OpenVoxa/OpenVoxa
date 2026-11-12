-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Category permissions (categories.go; decisions.md Feature decisions,
-- "Channel ordering and categories", "Category permissions").
--
-- A category has permissions of its own, in the same shape as a channel's
-- (channel_access): a row means the group may view, can_post adds posting
-- (speaking, in voice). A channel either follows its category's
-- permissions ("Same as category") or keeps its own ("Custom").
--
-- A following channel's permissions are COPIED into channel_access
-- whenever the category's change or the channel moves. Every access check
-- (canViewSQL, canPostSQL), voice kick and encryption-group sweep still
-- reads channel_access alone, so none of them changed.
CREATE TABLE category_access (
    category_id UUID    NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
    group_id    UUID    NOT NULL REFERENCES perm_groups(id) ON DELETE CASCADE,
    can_post    BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (category_id, group_id)
);

CREATE INDEX category_access_group_idx ON category_access (group_id);

-- Every channel starts as Custom: nothing anyone can see changes until
-- someone chooses "Same as category". A channel outside any category
-- can't follow one (deleteCategory and moves clear the flag first).
ALTER TABLE channels
    ADD COLUMN follows_category BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT channels_follows_needs_category
        CHECK (NOT follows_category OR category_id IS NOT NULL);

-- Existing categories start with the server default for new channels:
-- Everyone may view, groups new accounts join may post.
INSERT INTO category_access (category_id, group_id, can_post)
SELECT k.id, g.id, g.auto_assign
  FROM channel_categories k CROSS JOIN perm_groups g
 WHERE g.is_everyone OR g.auto_assign;
