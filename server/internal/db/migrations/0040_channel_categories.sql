-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Channel ordering and categories (categories.go; decisions.md Feature
-- decisions, "Channel ordering and categories").
--
-- A category is a named folder in the Text or the Voice section of the
-- sidebar, one level deep (no categories inside categories). It is a
-- label only: who may see a channel is still the channel's own
-- allow-list, and a category with nothing you can see isn't sent to you.
--
-- Order: channels.position orders the channels inside one scope (a
-- section's top level, or one category); channel_categories.position
-- orders the categories inside a section. Positions need not be
-- contiguous; ties fall back to the name.
CREATE TABLE channel_categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        TEXT        NOT NULL CHECK (kind IN ('text', 'voice')),
    name        TEXT        NOT NULL,
    position    INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Lets channels reference (id, kind), so a text channel can never sit
    -- in a voice category.
    UNIQUE (id, kind)
);

-- No two categories with the same name (ignoring case) in one section.
CREATE UNIQUE INDEX channel_categories_kind_name ON channel_categories (kind, lower(name));

ALTER TABLE channels
    ADD COLUMN category_id UUID,
    ADD COLUMN position    INTEGER NOT NULL DEFAULT 0,
    -- Deleting a category moves its channels to the section's top level
    -- (SET NULL on category_id only; kind stays).
    ADD CONSTRAINT channels_category_fk FOREIGN KEY (category_id, kind)
        REFERENCES channel_categories (id, kind) ON DELETE SET NULL (category_id);

-- Today's order (by name) becomes the starting order.
UPDATE channels c SET position = o.n
  FROM (SELECT id, row_number() OVER (PARTITION BY kind ORDER BY name) AS n
          FROM channels WHERE kind <> 'dm') o
 WHERE c.id = o.id;
