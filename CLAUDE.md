# CLAUDE.md — OpenVoxa working notes

Read this first. It is the short version; the long versions are linked.
Keep it under ~150 lines and update the **Current state** section at the
end of every session that changes it.

## What this is

Self-hosted, non-monetised Discord/TeamSpeak alternative: text channels,
voice, screen share, forum-style features. Pre-alpha. AGPLv3.
Repo: github.com/OpenVoxa/OpenVoxa. Owner: Ryan (new to much of this,
leans on AI for code — explain non-obvious choices, don't assume expertise).

Deep references (read only the section you need, not the whole file):

- `docs/decisions.md` — every architectural decision and tradeoff.
  Sections: Goals, Threat model, Feature decisions, Architecture,
  Known tensions, **Encryption** (~L191), **Implementation notes** (~L315,
  hard-won gotchas), **Build order** (~L577), **Open items** (~L603).
- `README.md` — public-facing status, threat model, stack.
- `deploy/README.md` — compose setup, TLS paths, LiveKit, storage,
  troubleshooting.

## Layout

```
server/            Go server (module root here)
  main.go
  internal/httpapi/   HTTP + WS handlers; debugui/chat.html is the
                      current (deliberately ugly) single-file client
  internal/db/        Postgres, migrations/000N_*.sql (embedded, ordered)
  internal/{auth,blob,config,gif,hub,perm,ratelimit,unfurl}
client-core/       TypeScript protocol + crypto, no UI
  src/mls/provider.ts  MlsProvider interface (swappable)
  src/mls/tsmls.ts     ts-mls implementation (pinned 1.6.2)
  src/identity.ts      device keys, registration, key packages
  src/groups.ts        MLS group lifecycle (create/join/commit/persist)
  src/chat.ts          text chat: Chat (account) + ChannelView (channel)
  src/storage.ts       IndexedDB persistence
  src/index.ts         exports -> global `OpenVoxaCore`
  build.mjs            esbuild IIFE -> dist/core.js
deploy/            docker-compose.yml, Caddyfiles, livekit.yaml, .env.example
```

`client-web/` (Vite + React + TS, plain CSS) is embedded into the server
(`internal/httpapi/webui/`, `webui.go`) and served at `/`. Build check:
`cd client-web && npm run build`. `client-desktop` does not exist yet.

## Stack

Go + PostgreSQL server · LiveKit SFU (server only mints tokens, never in
the media path) · Caddy optional for TLS · client-core in TS, bundled by
esbuild and **embedded into the Go binary** (`debugui/core.js`) · MLS via
ts-mls, ciphersuite 1 · Electron/React clients later.

## Workflow (important)

- Develop on **Git-terminal** (Windows, Git Bash, repo at
  `~/Documents/openvoxa`). Ryan deploys to **Docker** (homelab)
  by pulling from GitHub. Claude cannot reach Docker.
- Before any change, verify it compiles:
  - `cd client-core && npm run build` (works in the device shell; run
    `npm install` first if `node_modules` is missing)
  - `cd server && go build ./...` — **Go is not installed in the
    device shell.** The cloud container has go1.24 and no Go module
    proxy, but a type-check build works from a clone with a temporary
    go.mod (go 1.24, `replace` golang.org/x/* etc. with their GitHub
    mirrors at older versions, a protoyaml stub); recipe in the handoff
    doc, "Working notes". Never commit that go.mod. The cloud container
    also has Postgres 16 for running the real server end to end.
- Commits: DCO sign-off required (`git commit -s`), author
  `rynd-automation <rynd_automation@outlook.com>`. Short imperative
  subject lines, one logical change per commit.
- Claude can push from the device shell: a repo-scoped GitHub token is
  stored via `credential.helper store --file=.git/push-credentials`
  (never commit or print it). Ryan still rebuilds Docker by hand.
- Commit/push only when asked. Never commit `.env`, keys, or
  `docker-compose.override.yml`.
- **After EVERY push (docs-only included), give Ryan the Docker block**
  in the same reply, without being asked. He multitasks and forgets. No
  Git-terminal `git pull` block: Claude edits that folder directly.
  Docker block, with the expected hash filled in:
     ```bash
     # DOCKER
     cd ~/OpenVoxa && git pull && git log --oneline -1
     cd ~/OpenVoxa/deploy && docker compose --profile tls up -d --build
     ```
     Then hard-refresh the browser (Ctrl+Shift+R) for `debugui/` changes.
     Env changes need `--force-recreate`.
- Naming: call the hosts "Docker" and "Git-terminal", not "the VM" /
  "your desktop".

## Rules of thumb (from decisions.md — don't relearn these)

- Server is a delivery service for MLS: stores/routes opaque blobs,
  never parses them. Commit ordering is compare-and-swap on a
  client-supplied epoch hint.
- A **device** is the crypto identity, not an account. Schema is
  multi-device; only single-device is implemented.
- Key packages are single-use (`FOR UPDATE SKIP LOCKED`) plus one
  reusable last resort; surface when last resort was used.
- Encrypted channels show no history from before you joined. By design.
- `messages.body` is opaque `BYTEA`; encryption needs no migration.
- Ratchet trees travel as tagged JSON (our own codec): watch
  `Uint8Array`, `BigInt`, and `undefined`-vs-`null` blank nodes.
- ts-mls docs describe intent, not return shapes — **verify API shapes
  by experiment/types, never from the README.** See the eleven listed
  gotchas in decisions.md Implementation notes.
- `chat.html` is one script: a throw while wiring handlers silently
  kills every handler after it. Attach new controls via the warn-not-
  throw helper.
- Docker build context is the repo root; core.js must be copied before
  `go build` (embed). Don't let `go mod tidy` raise the `go` directive
  above the Dockerfile's base image.
- Permission revocation must explicitly reach live WebSockets.
- LiveKit is self-hosted from `debugui/` and pinned exactly in
  client-core/package.json: the E2EE worker must be same-origin and the
  same build as the main library. Never point it back at a CDN tag.

## Current state (update every session)

_Last updated: 2026-11-01. Step 13 M1 done; M2 (text in client-web) pushed,
awaiting test M2-1. Full handoff: project doc claude/handoff-step-13.md._

Done and verified on Docker (details in decisions.md, Build order 9-12 and
Implementation notes): MLS text encryption (ciphertext in Postgres, no
pre-join history, local plaintext archive in IndexedDB), encrypted
attachments (Giphy GIFs stay plain by Ryan's decision), voice/screen-share
E2EE (own MLS group, LiveKit key slot epoch mod 16, LiveKit 2.23.0 from our
origin), automatic membership following channel access (reconcile,
`reconcileSoon`, GroupInfo external joins, resets, join/leave notices per
person), multi-party tested (ryan + staff + tester), custom permission
groups (migration 0012; switches decide what, rank decides whom; channel
allow-lists; chat.html console helpers `showGroups()`, `newGroup()`,
`addToGroup()`, `mkChannel()`, `setAccess()`, `setHistorySharing()` ...),
30-day device expiry, history sharing, two-admin floor, password rules.
Blob storage on Docker is a bind mount: `/mnt/openvoxa-blobs`.

Step 13 (real client), order M1 signup/login + recovery key -> M2 text ->
M3 voice/screen share -> M4 attachments/GIFs/unfurls/notices -> M5
settings and admin panes:

- M1 DONE (T1, B1, R1, K1 flow 1; K1 flows 2-5 deferred by Ryan):
  `client-web` login/register, backup storage (migration 0015,
  `recovery.go`), client-core `recovery.ts`, recovery screens
  (`Recovery.tsx`, `backup.ts` BackupManager).
- M2 pushed, NOT yet verified on Docker (test M2-1 in the handoff):
  client-core `chat.ts` (`Chat`, `ChannelView`), client-web `ChatApp.tsx`,
  `ChannelPane.tsx`, `core.ts`; server migration 0016 (`edited_at`),
  `messages.go` (`GET /channels/{id}/messages?before=`, `PATCH
  /messages/{id}`, `channel_activity` to viewers only), send frames carry a
  `ref` echoed on the message. client-web now owns the device: sign-out
  uploads the backup, revokes the device and wipes the local DB.
  Verified end to end in the cloud container (real server + Postgres +
  Playwright, two and three accounts).
- Pending tests from earlier: P3 password test, D1 list/delete-user.
- Palette: variables in `client-web/src/styles.css` only.
- Next after M2: M3 voice in client-web (port voice from chat.html into
  client-core). Open items in decisions.md "Open items".
