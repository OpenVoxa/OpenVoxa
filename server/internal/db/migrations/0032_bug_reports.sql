-- Copyright (C) 2026 The OpenVoxa Authors
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Bug reports from users to this server's administrators (bugreports.go;
-- decisions.md, Feature decisions, "Planned", bug reports, "Changed and
-- settled"). Administrators only; one of them may forward a report to
-- the OpenVoxa project on GitHub by hand.
--
--   body              the report: JSON {text, debug}, sealed under the
--                     reporter's account key, so deleting the account
--                     destroys it (crypto-shredding). reporter_id goes
--                     NULL with the account and the text reads as gone.
--   sent_to_github_at set when an administrator pressed Send to GitHub
--                     (the issue itself is filed in their browser).
CREATE TABLE bug_reports (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    body              BYTEA NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    sent_to_github_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at         TIMESTAMPTZ
);

CREATE INDEX bug_reports_status ON bug_reports (status, created_at DESC);
