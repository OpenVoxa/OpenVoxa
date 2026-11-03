# CLAUDE.md — OpenVoxa working notes

Read this first. It is the short version; the long versions are linked.
Keep it under ~150 lines and update the **Current state** section at the
end of every session that changes it.

## What this is

Self-hosted, non-monetised Discord/TeamSpeak alternative: text channels,
voice, screen share, forum-style features. Pre-alpha.
Repo: github.com/OpenVoxa/OpenVoxa. Owner: Ryan (new to much of this,
leans on AI for code — explain non-obvious choices, don't assume expertise).

Fixed decisions (decisions.md "Blocking decisions", ~L50; don't reopen):

- **Go server** + PostgreSQL. Rust only for pieces that need it.
- **Electron desktop client** (bundled Chromium = same WebRTC/E2EE/screen
  capture on every OS) plus the web client. Electron not started yet
  (`client-desktop/` doesn't exist); it will load the same bundles.
- **AGPLv3** (`AGPL-3.0-or-later` SPDX header on every file), DCO sign-off.
- **Our own protocol, not Matrix.** Built from scratch by choice; MLS
  (RFC 9420) for group crypto.
- **No federation in v1.** Each instance is an island; server identity
  stays in the protocol so federation is possible later.
- **Per-channel E2EE, admin-controlled.** Text channels: encrypted or
  not, chosen at creation by whoever holds `manage_channels`, fixed
  after (`channels.encrypted`). Voice/screen share always E2EE, no toggle;
  DMs will be too.
- **Account deletion = crypto-shredding** (destroy the user's key
  material so their ciphertext is unreadable even in backups). **Not
  built yet:** `purgeUser`/`PurgeUserTx` (`account.go`) blanks message
  bodies, sets `deleted` (tombstone) and deletes the user row (cascades
  to sessions/devices). Plaintext channels will always need that path.

Deep references (read only the section you need, not the whole file):

- `docs/decisions.md` — every architectural decision and tradeoff.
  Sections: Goals, Threat model, Blocking decisions (~L50), Feature
  decisions, Architecture, Known tensions (~L152), **Encryption** (~L212),
  **Implementation notes** (~L447, hard-won gotchas), Permission groups
  (~L1087), **Build order** (~L1226), **Open items** (~L1494).
- `README.md` — public-facing status, threat model, stack.
- `deploy/README.md` — compose setup, TLS paths, LiveKit, storage,
  troubleshooting.

## Layout

```
server/            Go server (module root here; go.mod says go 1.26)
  main.go, cli.go     cli.go = host commands (grant-admin, list-admins,
                      list-users, delete-user)
  Dockerfile          multi-stage: client-core -> client-web -> Go -> distroless
  internal/httpapi/   HTTP + WS; debugui/chat.html = old debug client
  internal/db/        Postgres, migrations/00NN_*.sql (embedded, ordered;
                      latest 0016)
  internal/{auth,blob,config,gif,hub,password,perm,ratelimit,unfurl}
client-core/       TypeScript protocol + crypto, no UI
  src/mls/provider.ts  MlsProvider interface (swappable)
  src/mls/tsmls.ts     ts-mls implementation (pinned 1.6.2)
  src/identity.ts      device keys, registration, key packages
  src/groups.ts        MLS group lifecycle (create/join/commit/persist)
  src/chat.ts          text chat: Chat (account) + ChannelView (channel)
  src/attachments.ts   per-file AES-256-GCM keys + message envelope
  src/recovery.ts      recovery key / encrypted backup
  src/voice.ts         voice + screen share (VoiceClient); not in index
  src/storage.ts       IndexedDB persistence
  src/index.ts         exports -> global `OpenVoxaCore`
  scripts/patch-ts-mls.mjs  build-time fix of a ts-mls validation bug
  build.mjs            esbuild IIFE -> dist/core.js (+ LiveKit bundles)
client-web/        Vite + React + TS, plain CSS; imports client-core source
deploy/            docker-compose.yml, caddy/, livekit.yaml, .env.example,
                   scripts/update-node-ip.sh
```

client-web is embedded into the server (`webui.go`) and served at `/`.

## Stack

Go + PostgreSQL server · LiveKit SFU (server only mints tokens, never in
the media path) · Caddy optional for TLS · client-core in TS, bundled by
esbuild and **embedded into the Go binary** (`debugui/core.js`) · MLS via
ts-mls, ciphersuite 1 · React web client now, Electron shell later.

## Build and run

Compile checks (before any commit):

- `cd client-core && npm install && npm run build`
- `cd client-web && npm install && npm run build`
- `cd server && go build ./...` — **Go is not installed on Docker or
  in the device shell**; the Docker image build (golang:1.26) is the Go
  compile check. The cloud container has go1.24, no module proxy, and
  Postgres 16; a type-check there needs a temporary go.mod (recipe in
  the handoff doc, "Working notes"). Never commit that go.mod.
- Node 22 (NodeSource, `/usr/bin/node`) is installed on Docker,
  matching the Dockerfile's node:22-alpine.

Docker (run on Docker, from `~/OpenVoxa/deploy`; build context is the repo
root, the compose file handles that):

```bash
# first time
cp .env.example .env                                  # then edit it
docker run --rm livekit/livekit-server generate-keys  # keys into .env
docker compose --profile tls up -d --build            # tls = with Caddy
docker compose logs server | grep setup_code          # first admin signup
# routine
docker compose --profile tls up -d --build            # rebuild + restart
docker compose --profile tls up -d --force-recreate   # after .env edits
docker compose ps
docker compose logs server --tail 30                  # or caddy / livekit
docker compose exec server /openvoxa-server list-users   # host commands
docker compose --profile tls down
```

No `tls` profile = no Caddy (own proxy + `OPENVOXA_TRUST_PROXY=true`).

## Workflow (important)

- **Check `hostname` first.** If it says `docker`, this session runs on
  the Docker host itself (Debian 12 VM on Ryan's Proxmox homelab), repo
  at `~/OpenVoxa`, live stack in `~/OpenVoxa/deploy`. Claude edits,
  builds, commits, pushes AND rebuilds the stack from here. Ryan's only
  terminal is this chat (he can't paste into the VM), so Claude runs
  host commands (compose, logs, psql) itself. Elsewhere (Git-terminal,
  Windows, `~/Documents/openvoxa`; cloud container) Claude can't reach
  Docker, so give Ryan the Docker block below after every push.
- Commits: DCO sign-off required (`git commit -s`), author
  `rynd-automation <rynd_automation@outlook.com>`. Short imperative
  subject lines, one logical change per commit.
- Pushing works: a fine-grained token (OpenVoxa/OpenVoxa only,
  Contents read/write) is stored via `credential.helper store
  --file=.git/push-credentials` (never commit or print it). If a push
  asks for a username, the token expired: Ryan makes a new one.
- Commit/push only when asked. Never commit `.env`, keys, or
  `docker-compose.override.yml`.
- **On Docker, after a push that changes the app, offer to rebuild**
  (`docker compose --profile tls up -d --build` from `deploy/`). It
  restarts the server: connections drop for a few seconds and friends
  may be online. Afterwards check `docker compose ps` and
  `logs server --tail 15`, then tell Ryan to hard-refresh (Ctrl+Shift+R).
  Env changes need `--force-recreate`. Not on Docker: give the block,
  with the expected hash, without being asked (he multitasks):
     ```bash
     # DOCKER
     cd ~/OpenVoxa && git pull && git log --oneline -1
     cd ~/OpenVoxa/deploy && docker compose --profile tls up -d --build
     ```
- Debug from the host: `docker compose logs server --since 10m` shows
  every request (e.g. backup `PUT /me/backup/chunks/...`); psql via
  `docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER"
  -d "$POSTGRES_DB"'`. The server image is distroless (no shell).
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
- core.js, the LiveKit bundles and client-web dist must be copied before
  `go build` (embed). Don't let `go mod tidy` raise the `go` directive
  above the Dockerfile's base image (golang:1.26).
- Permission revocation must explicitly reach live WebSockets.
- LiveKit is self-hosted from `debugui/` and pinned exactly in
  client-core/package.json: the E2EE worker must be same-origin and the
  same build as the main library. Never point it back at a CDN tag.
- Palette: variables in `client-web/src/styles.css` only.

## Current state (update every session)

_Last updated: 2026-11-03. M5 session A (account settings) done and
verified (S1-S5); next M5 session B (groups and members). External join was already done (2026-10-31). Older
full handoff: project doc claude/handoff-step-13.md._

Done and verified on Docker (details: decisions.md Build order 9-12):
MLS text E2EE, encrypted attachments in core + chat.html (Giphy GIFs stay
plain, Ryan's call), voice/screen-share E2EE, automatic membership from
channel access, permission groups (chat.html console helpers
`showGroups()`, `mkChannel()`, `setAccess()` ...), device expiry, history
sharing, two-admin floor, password rules. Blobs on Docker: bind mount
`/mnt/openvoxa-blobs`.

Step 13 (real client): M1 login + recovery -> M2 text -> M3 voice ->
M4 attachments/GIFs/unfurls/notices -> M5 settings and admin panes.

- M1 DONE (K1 flows 2-5 deferred by Ryan). M3 DONE (V3). Channel
  management DONE (C1).
- M2 DONE and verified 2026-11-03 (tuckilufigus + staff): paging,
  unread markers incl. hidden channels, encrypted archive, scheduled
  backup, sign-out/restore. Fix 7d91eb3: user panel now refreshes the
  backup time after scheduled uploads (console logs `backup uploaded`).
- M4 session A DONE (markdown, previews, GIFs, notices, tones, Settings).
  G1/Y1 verified; G2-G4 to test. Also pending: P3 password, D1 delete-user.
- Deploy: LiveKit on host networking (v1.13.11, `host.docker.internal:7880`),
  `update-node-ip.sh` on cron. Temporarily open to two friends (port 8443;
  teardown in handoff).
- External join is DONE (built and verified 2026-10-31, `b550c95`,
  `ccba824`; `groups.open`, used by client-web via `chat.ts`). A new
  device joins encrypted channels and voice with nobody online. The
  2026-11-03 handoff wrongly listed it as unbuilt; check git log and
  decisions.md Build order before calling something "not built".
- M4 session B DONE and verified on Docker 2026-11-03: attachment
  upload in client-web ("+" picker, paste, drag and drop, upload tray,
  encrypted files decrypted inline; `client-web/src/attachments.tsx`,
  `ChannelView.upload`). Test plan in the next item.
- To test (A1-A4): A1 plain channel: picker with 2 images + a PDF, all
  show for the other account. A2 encrypted channel: paste a screenshot,
  drop a video; other account sees them decrypt; the PDF downloads with
  its real name. A3 a video over 10 MB shows "Load". A4 an 11th file is
  refused; a file over 25 MB fails in the tray and Send leaves it out.
  A1-A4 PASSED 2026-11-03. Then added an image viewer + Settings toggle
  "Open images in a new tab"; A5 (viewer + toggle) PASSED too.
- M5 split (Ryan, 2026-11-03): A account settings, B admin groups and
  members, C moderation (bans, reports, delete-user). A DONE and verified
  on Docker 2026-11-03: Settings dialog with Account/Voice/Chat tabs
  (`client-web/src/SettingsDialog.tsx`): change password, recovery key
  incl. "Make a new key", devices list/remove, delete account. S5 found
  that live views kept a deleted author's name; fixed (`userPurged`
  clears it, client-web shows "Deleted user").
- Next: M5 session B. Server endpoints exist (`/groups`, `/users`,
  `/users/{id}/groups/{group}`); chat.html console helpers show usage.
  `moderation_log` has no read endpoint yet (C needs server work).
  Crypto-shredding is unbuilt, not
  yet in Build order. Encrypting local IndexedDB keys is unblocked
  (decisions.md Open items).
