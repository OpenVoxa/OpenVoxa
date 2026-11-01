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
    device shell and go.dev is blocked there.** Use the cloud container
    (has Go; go.mod needs 1.26, so `GOTOOLCHAIN=auto` may be needed) or
    ask Ryan to run it on Git-terminal.
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

_Last updated: 2026-10-31, step 13 (real client) M1 in progress; see project doc claude/handoff-step-13.md._

- Build-order step 9 (MLS for text) is functionally working on Docker:
  messages in an encrypted channel are ciphertext in Postgres (only the
  MLS framing header — group ID, epoch — is in the clear); plaintext
  channels show plaintext. Two-party test passed (ryan + staff): welcome
  path works, pre-join messages unreadable, messages flow both ways.
- Done and verified on Docker: device identity + key packages; group
  create/join/catch-up; epoch-ordered commits with rebase; encrypted text
  and attachments (per-file AES-256-GCM, key inside the MLS message;
  Giphy GIFs stay unencrypted by Ryan's decision); local plaintext
  archive in IndexedDB (MLS keys are single-use; own sent plaintext kept
  since senders can't decrypt their own). Blob storage on Docker is a
  bind mount: `/mnt/openvoxa-blobs`.
- Media encryption (build-order step 10) verified on Docker 2026-10-30:
  voice channels have their own MLS group; `groups.mediaKey()` feeds
  LiveKit E2EE at key slot epoch mod 16; outsiders refused; audio and
  screen share work both ways. LiveKit 2.23.0 served from our origin.
- Decided 2026-10-30: encryption-group membership follows channel access
  automatically, with every join/leave announced (decisions.md
  Encryption + Known tensions). Custom permission groups replace the
  fixed roles later.
- Permission checks: `requirePerm(perm.X, ...)` / `requireStaff`;
  `Session.Perms` + `Session.Rank`. No roles left in Go code.
- Remaining, in order:
  1. Automatic membership (step 11): server side done and verified
     (`access.go`, `GET /channels/{id}/mls/allowed-devices`, welcome
     check, channel-scoped claims; committing needs view, not post).
     Client `groups.reconcile()` done and verified on Docker (step 4).
     Triggers (step 5) done and verified on Docker 2026-10-31:
     `groups.reconcileSoon()` (debounced, staggered by leaf; decisions.md
     Implementation notes), server `access_changed` event, demotion
     closes sockets to lost channels. Join/leave notices (step 6) done and
     verified: `groups.onMembership()`, `mls/device-names` endpoint.
     Real UI: per-person notices by default, per-device as an option,
     mod and admin panes (decisions.md, "Notices are per person").
     Step 7 done: "Add everyone" buttons and `groups.addMembers` gone.
     Step 8 done and verified on Docker 2026-10-31: `groups.open` joins from
     the published GroupInfo when no welcome waits, and resets the group
     when there is no current GroupInfo (migration 0011: generation,
     group_info; `mls/reset`, `mls/group-info` GET/PUT; commits carry
     generation + GroupInfo). Proven end to end in Node against the real
     server. Voice no longer waits for someone in the call. Forget
     device now revokes server-side first.
     Next: multi-party testing (item 2 below).
     Group ops serialised per channel; commit keys wiped only after the
     server accepts; removes and adds in separate commits. Never pass
     `resync = true` (hangs). All in decisions.md Impl. notes.
  2. Multi-party testing: DONE 2026-10-31 (ryan + staff + tester):
     three-way text and voice, add/remove with two members watching (one
     commit each), removal from a live call. Found and fixed: shared
     browser storage between accounts (per-account DB + one tab per
     account), ts-mls throwing on removal at the tree's end (catch-up
     rejoins), banned users staying in calls (LiveKit RemoveParticipant +
     old media keys retired after 10 s). Cosmetic "left voice" on a kick:
     fixed, see item 4.
  3. Custom permission groups (step 12): DONE, verified on Docker
     2026-10-31 (D1-D5). Migration 0012 converts roles to groups
     (Everyone, Member, Moderator, Administrator); switches decide what,
     rank decides whom; channels carry an allow-list (decisions.md
     "Permission groups"). API: `/groups`, `/users/{id}/groups/{group}`,
     `PUT /channels/{id}/access`; event `perms_changed` replaces
     `role_changed`. chat.html console helpers: `showGroups()`,
     `showUsers()`, `newGroup()`, `editGroup()`, `deleteGroup()`,
     `addToGroup()`, `removeFromGroup()`, `mkChannel()`, `setAccess()`.
     No settings UI yet (real client).
     Event socket (`/ws` without channel) added after D3 on Docker:
     server-wide events reach a client with no channel open.
     Voice keys: retired slots must not move LiveKit's current key
     index (`overwriteSlot` in chat.html, fixed `efc38c6`).
  4. Small items before the real client (order agreed 2026-10-31):
     per-person notices (core `MembershipChange.people`, chat.html shows
     them by default, "per-device" checkbox for the old detail and epoch
     lines; DONE, verified on Docker N1-N2) -> call-end wording
     (`describeVoiceEnd` in chat.html: server kick or own MLS removal
     both read as "removed", not "left voice"; DONE, verified V1) ->
     30-day device expiry (`db/deviceexpiry.go`, migration 0013, 410 from
     the key package count, `Identity.start` re-registers; DONE, verified
     E1) -> history sharing (decided: everyone added, all the server
     holds, "shared by" marker; decisions.md Encryption; migration 0014,
     `historyshare.go`, `groups.importSharedHistory`, chat.html helper
     `setHistorySharing(name, on)`; DONE, verified H1). Small items
     finished; next is the real client (build-order 13). -> client (step 13), with
     recovery keys built into the client.
  5. Opt-in history sharing (Ryan wants it; see decisions.md Open items).
  6. Local storage encryption (blocked on recovery keys).
- Step 13 M1 (signup/login + recovery key): part 1 `client-web` login and
  register at `/`, verified (T1). Part 2 backup storage, verified (B1):
  migration 0015 + `recovery.go`, `GET/PUT/DELETE /me/backup` (PUT starts
  a new backup, drops old chunks, returns its id) and
  `PUT/GET/DELETE /me/backup/chunks/{name}?backup=<id>` (raw bytes, 4 MB,
  1000 chunks, 256 MB per account). Part 3 `client-core/src/recovery.ts`:
  `RecoveryKey` (12 BIP-39 words via @scure/bip39, QR payload `OVRK1:<hex>`),
  `Backup` (create/unlock/upload/restore/remove/status), derived key kept
  in the device store; verified (R1). Sign-out wipes the archive: upload
  before it. Next: client-web screens (part 4).
- Password rules (decisions.md): 12+ chars, 3 of 4 kinds, not the
  username, not a (dressed-up) common password (embedded NCSC 100k list),
  not mostly a pattern. `server/internal/password` (register + `PUT
  /me/password`), mirrored minus the list in client-web `password.ts`. Two-admin floor verified A2.
- client-web palette (2026-11-01): #333333 background, #D96932 buttons,
  #FFFFFF text; derived shades in `styles.css` variables (user themes later).
- Always an administrator (decisions.md, Permission groups): floor of two
  admins (`MinAdmins`, guard also on bans) in `lastadmin.go`, verified A1
  for the one-admin version; host command `/openvoxa-server grant-admin
  <user>` / `list-admins` (`cli.go`), setup code from the log for the
  first account on an empty server (`GET /api/v1/setup`).
- Other open items (revoked-device removal, recovery keys, etc.) live in
  decisions.md "Open items" — check there before proposing new work.
