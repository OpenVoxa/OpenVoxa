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

`client-web` / `client-desktop` do not exist yet.

## Stack

Go + PostgreSQL server · LiveKit SFU (server only mints tokens, never in
the media path) · Caddy optional for TLS · client-core in TS, bundled by
esbuild and **embedded into the Go binary** (`debugui/core.js`) · MLS via
ts-mls, ciphersuite 1 · Electron/React clients later.

## Workflow (important)

- Develop on **Git-terminal** (Windows, Git Bash, repo at
  `~/Documents/openvoxa`). Ryan deploys to **Docker** (Proxmox homelab)
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
- Commit/push only when asked. Never commit `.env`, keys, or
  `docker-compose.override.yml`.
- When handing over changes, always give Ryan both:
  1. Repo update (on Git-terminal): `git pull` (or the push commands
     if he is committing).
  2. Docker update:
     ```bash
     cd OpenVoxa && git pull && cd deploy
     docker compose --profile tls up -d --build
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
  by experiment/types, never from the README.** See the seven listed
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

_Last updated: 2026-10-30, after step 10 verified and the membership decision._

- Build-order step 9 (MLS for text) is functionally working on Docker:
  messages in an encrypted channel are ciphertext in Postgres (only the
  MLS framing header — group ID, epoch — is in the clear); plaintext
  channels show plaintext. Two-party test passed (ryan + staff): welcome
  path works, pre-join messages unreadable, messages flow both ways.
- Done: device identity + key packages; group create/join/catch-up;
  epoch-ordered commits with rebase; encrypted text end to end; own sent
  plaintext kept locally (MLS senders can't decrypt their own messages).
- Encrypted attachments verified on Docker: per-file AES-256-GCM in
  `client-core/src/attachments.ts`, key carried in a JSON envelope inside
  the MLS message; server stores ciphertext as `encrypted` / octet-stream
  regardless of what the client sends. Link previews skipped in encrypted
  channels. Giphy GIFs stay unencrypted there by Ryan's decision (public
  content); user-uploaded .gif files are encrypted.
- Local plaintext archive (IndexedDB) so messages survive reloads: MLS
  keys are single-use. Inbound messages are processed through one queue.
- Blob storage on Docker is a bind mount: `/mnt/openvoxa-blobs`.
- Media encryption (build-order step 10) verified on Docker 2026-10-30:
  voice channels have their own MLS group; `groups.mediaKey()` feeds
  LiveKit E2EE at key slot epoch mod 16; outsiders refused; audio and
  screen share work both ways. LiveKit 2.23.0 served from our origin.
- Decided 2026-10-30: encryption-group membership follows channel access
  automatically, with every join/leave announced (decisions.md
  Encryption + Known tensions). Custom permission groups replace the
  fixed roles later. The "Add everyone" buttons are scaffolding.
- Remaining, in order:
  1. Automatic membership (step 11): server reports missing/revoked
     devices per channel; online members' clients reconcile; join/leave
     notices. Then test ts-mls external commit as the no-one-online path.
  2. Multi-party testing.
  3. Custom permission groups (step 12).
  4. Opt-in history sharing (Ryan wants it; see decisions.md Open items).
  5. Local storage encryption (blocked on recovery keys).
- Other open items (revoked-device removal, recovery keys, etc.) live in
  decisions.md "Open items" — check there before proposing new work.
