-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A ban blocks login and kills existing sessions. expires_at NULL means
-- permanent.
--
-- A banned account is not deleted: deletion is the user's own right, and
-- taking it as a punishment would destroy evidence a moderator may need
-- and content other people are still reading. The account stays, locked.
CREATE TABLE bans (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
    reason     TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

-- One permanent ban per user.
--
-- The predicate cannot reference now(): Postgres requires index
-- predicates to be IMMUTABLE, because an index whose membership changed
-- with the clock would silently stop matching its own definition. So the
-- constraint covers permanent bans only, and overlapping temporary bans
-- are prevented by an explicit check in the ban handler.
CREATE UNIQUE INDEX bans_permanent_idx ON bans (user_id)
    WHERE expires_at IS NULL;

-- Lookups always filter on expiry, so the index carries it.
CREATE INDEX bans_user_expiry_idx ON bans (user_id, expires_at);

-- Reports.
--
-- claimed_body is what the reporter's client said the message contained.
-- In a plaintext channel the server has its own copy and can compare
-- directly, which is what `verified` records.
--
-- In an encrypted channel the server will have ciphertext only, and
-- verification will instead check the author's MLS signature over the
-- claimed bytes. A reporter who edits a message before reporting it
-- cannot produce a valid signature, so the check fails and the report is
-- rejected. Either way `verified` means the same thing to a moderator:
-- the accused really wrote this.
CREATE TABLE reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id   UUID        REFERENCES messages(id) ON DELETE SET NULL,
    channel_id   UUID        REFERENCES channels(id) ON DELETE SET NULL,
    reporter_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
    accused_id   UUID        REFERENCES users(id) ON DELETE SET NULL,

    reason       TEXT        NOT NULL DEFAULT '',
    claimed_body TEXT        NOT NULL DEFAULT '',

    -- NULL means verification could not be performed at all, which a
    -- moderator must be able to tell apart from "checked and failed".
    verified     BOOLEAN,

    status       TEXT        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'dismissed', 'actioned', 'rejected')),

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    resolved_at  TIMESTAMPTZ
);

CREATE INDEX reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX reports_accused_idx ON reports (accused_id);

-- A reporter gets one open report per message. Without this, a determined
-- user can bury a moderation queue under duplicates.
CREATE UNIQUE INDEX reports_one_open_idx ON reports (message_id, reporter_id)
    WHERE status = 'open';

-- Every moderator action, including the ones that turned out to be
-- mistakes. An instance where moderators cannot be reviewed is one where
-- users have to take the operator's word for it.
CREATE TABLE moderation_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT        NOT NULL,
    subject_id UUID,
    detail     TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX moderation_log_created_idx ON moderation_log (created_at DESC);
