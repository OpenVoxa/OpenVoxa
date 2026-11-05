# CLAUDE.md — OpenVoxa working notes

Read this first; the long versions are linked. Keep it under ~180 lines.
At the end of a session, rewrite **Current state** (don't append to it):
what's true now and what's next. History belongs in decisions.md and git.

## What this is

Self-hosted, non-monetised Discord/TeamSpeak alternative: text channels,
voice, screen share, forum-style features. Pre-alpha.
Repo: github.com/OpenVoxa/OpenVoxa. Owner: Ryan (new to much of this,
leans on AI for code: explain non-obvious choices, don't assume expertise).

Fixed decisions (decisions.md "Blocking decisions"; don't reopen):

- **Go server** + PostgreSQL. Rust only for pieces that need it.
- **Electron desktop client** (bundled Chromium = same WebRTC/E2EE/screen
  capture on every OS) plus the web client. `client-desktop/`: a shell
  with a server pane; each server's own web client loads in its own view.
- **AGPLv3** (`AGPL-3.0-or-later` SPDX header on every file), DCO sign-off.
- **Our own protocol, not Matrix**; MLS (RFC 9420) for group crypto.
- **No federation in v1.** Server identity stays in the protocol.
- **Per-channel E2EE, admin-controlled.** Text channels: encrypted or not,
  chosen at creation (`manage_channels`), fixed after. Voice/screen share
  always E2EE; DMs will be too.
- **Account deletion = crypto-shredding** (built). Encrypted channels
  need nothing (MLS forward secrecy); plaintext bodies are sealed under a
  per-account key file (`internal/keystore`), destroyed after `purgeUser`.

## Where things are written down

`docs/decisions.md` is the record of every decision; search it by
section name, not line number. Sections: Goals and scope, Threat model,
Blocking decisions, Architecture, **Feature decisions** (one #### per
feature under Text and chat / Voice and screen share / Accounts and
administration / Desktop app, then Planned), Permission groups,
**Encryption**, Known tensions, **Implementation notes** (hard-won
gotchas grouped MLS / LiveKit / Electron / server / web client / builds:
read the group before touching that code), **Build order** (what was
built when, with test IDs; new work goes in its dated list), **Open
items** (Next up, not built, untested, security gaps, Closed).
`README.md` is public status; `deploy/README.md` covers compose, TLS,
LiveKit, storage, key backups, share limit, troubleshooting.
Older full handoff: project doc claude/handoff-step-13.md.

## Layout

```
server/            Go (module root; go.mod says go 1.26)
  main.go, cli.go     host commands: grant-admin, list-admins, list-users, delete-user
  Dockerfile          client-core -> client-web -> Go -> distroless
  internal/httpapi/   HTTP + WS, one file per feature; livekitapi.go = LiveKit
                      admin calls; webui/ = embedded client-web build
  internal/db/        Postgres; migrations/00NN_*.sql embedded, ordered (latest 0028)
  internal/{auth,blob,config,gif,hub,keystore,password,perm,ratelimit,sealedfile,unfurl}
client-core/       TypeScript protocol + crypto, no UI. src/: mls/ (ts-mls,
                   pinned 1.6.2), identity, groups (MLS lifecycle), chat
                   (Chat + ChannelView), voice (VoiceClient, lazy), attachments,
                   recovery, storage, stickers. npm run build only applies
                   scripts/patch-ts-mls.mjs (fixes a ts-mls bug in node_modules)
client-web/        Vite + React + TS, plain CSS; imports client-core source.
                   Embedded into the server (webui.go), served at /.
client-desktop/    Electron shell: src/main.ts (window, server views,
                   permissions, origin lock), src/panePreload.ts (the only
                   bridge, pane only), pane/ (server pane, plain HTML/JS).
deploy/            docker-compose.yml, caddy/, livekit.yaml, .env.example, scripts/
```

Stack: LiveKit SFU (the server mints tokens and calls its admin API,
never in the media path) · Caddy optional for TLS · MLS ciphersuite 1.

## Build and check

- `cd client-core && npm run build` (and `npx tsc --noEmit`: the build
  doesn't type-check)
- `cd client-web && npm run build` (runs tsc)
- `cd client-desktop && npm run release:win`: bumps the patch version,
  builds the NSIS installer (Wine container) and publishes it to
  `deploy/desktop-updates` (served at `/desktop-updates/`); installed apps
  update from there. `npm run package:win` alone: zip in `release/`.
  Smoke-test in a throwaway `node:22-bookworm` container with Xvfb
  (`--remote-debugging-port` to eval JS). For Ryan: `python3 -m
  http.server 8099 --bind 192.168.1.9`, new file name per build, check he fetched it.
- Go is not installed on Docker. Quick compile, vet and tests from
  `server/`:
  `docker run --rm -v "$PWD":/src -v ovx-gomod:/go/pkg/mod -w /src golang:1.26 sh -c 'go vet ./internal/httpapi/ && go test ./internal/<pkg>/ && go build ./...'`
  (`ovx-gomod` caches modules). The image build is the final check.
- Cloud container: go1.24, no proxy; needs a temporary go.mod (handoff
  doc, "Working notes"). Never commit it.
- client-web dist is copied into `webui/` before `go build` (embed). Don't let `go mod tidy` raise the `go` directive
  above golang:1.26.

Docker stack (from `~/OpenVoxa/deploy`):

```bash
docker compose --profile tls up -d --build            # rebuild + restart (tls = Caddy)
docker compose --profile tls up -d --force-recreate   # after .env edits
docker compose ps
docker compose logs server --tail 30                  # or caddy / livekit; --since 10m
docker compose exec server /openvoxa-server list-users   # host commands
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

First-time setup: deploy/README.md. The server image is distroless (no shell).

## Workflow (important)

- **Check `hostname` first.** `docker` = this session runs on the Docker
  host (Debian 12 VM on Ryan's homelab; repo `~/OpenVoxa`, live
  stack `~/OpenVoxa/deploy`). Claude edits, builds, rebuilds, commits and
  pushes from here and runs host commands itself: Ryan's only terminal is
  this chat. Elsewhere (Git-terminal, `~/Documents/openvoxa`; cloud
  container) Claude can't reach Docker: after every push give Ryan this
  block, with the expected hash, unasked:
  ```bash
  # DOCKER
  cd ~/OpenVoxa && git pull && git log --oneline -1
  cd ~/OpenVoxa/deploy && docker compose --profile tls up -d --build
  ```
- **On Docker, rebuild without asking as soon as builds pass** (Ryan is
  the only user). Order: build, rebuild, check `ps` + `logs server --tail
  15`, Ryan hard-refreshes (Ctrl+Shift+R) and tests, then commit + push.
- Give Ryan numbered test steps with IDs (e.g. SL1-SL5); he reports them
  back as passed or failed.
- Discuss designs with Ryan before building anything with a real choice
  in it. Verify LiveKit/ts-mls behaviour by experiment, not docs.
- Commits: only when asked. `git commit -s`, author `rynd-automation
  <rynd_automation@outlook.com>`, short imperative subject, one logical
  change per commit. Never commit `.env`, keys or
  `docker-compose.override.yml`.
- Push token: fine-grained, stored via `credential.helper store
  --file=.git/push-credentials` (never print or commit it). A username
  prompt means it expired: Ryan makes a new one.
- Call the hosts "Docker" and "Git-terminal", not "the VM" / "your desktop".

## Rules of thumb (don't relearn these)

- The server is a delivery service for MLS: it stores and routes opaque
  blobs, never parses them. Commit ordering is compare-and-swap on a
  client-supplied epoch hint. `messages.body` is opaque `BYTEA`.
- A **device** is the crypto identity, not an account. Schema is
  multi-device; only single-device is implemented.
- Key packages are single-use (`FOR UPDATE SKIP LOCKED`) plus one
  reusable last resort.
- Encrypted channels show no history from before you joined. By design.
- Ratchet trees travel as tagged JSON (our codec): watch `Uint8Array`,
  `BigInt`, and `undefined`-vs-`null` blank nodes.
- ts-mls docs describe intent, not return shapes: verify by experiment.
- LiveKit track info (size, layer bitrates) is what the browser
  declared, never measured. LiveKit is pinned exactly and its E2EE
  worker is bundled by Vite from client-core's copy (`voiceWorker.ts`):
  it must be same-origin, same build.
- Permission changes must explicitly reach live WebSockets and live
  voice calls (`kickFromLostVoice`).
- Defaults: visual pop-ups off, in-page sounds on; least friction for
  end users.
- **UI:** colours only as variables in `client-web/src/styles.css`
  (users override them via `appearance.ts`). Ryan wants things to match
  exactly: sizes, spacing, Title Case tab names. Buttons must look like
  buttons; reuse `primary` (filled accent), `outline` (accent outline),
  `save` (green, grey when disabled, bottom left) and `Modal wide fixed`
  (Settings and Server settings, both 80% of the window, footer `.modal-foot`).
  Grey out unavailable controls instead of hiding them. Check before
  showing him.

## Current state (rewrite every session)

_2026-11-05._ **About tab** (AB1-AB8) and **channel menus with rename**
(CM1-CM9) done; decisions.md Feature decisions "About tab in Settings"
and "Channel menus". About: `AboutSettings.tsx`, bandwidth from
`client-core/src/traffic.ts` + `VoiceClient.trafficBytes()`, staff-only
`GET /api/v1/version` stamped by the Dockerfile's `version` stage (compose
passes `.git` as the `gitdir` build context). Menus: `ChannelMenu.tsx`
(right-click or long-press), `PATCH /api/v1/channels/{id}/name`. Ryan's
desktop app is 0.1.8. Publish a patch: `cd client-desktop && npm run
release:win` (commit the package.json bump).

- Groups: Administrator 30, Moderator 20, Member 10 (new accounts),
  Everyone 0. Test accounts: quillbrook (Ryan), staff, secondadmin,
  testuser. Voice channels: voice-general, vip-voice (admins only).
- Docker deploy: LiveKit v1.13.11, host networking (server reaches it
  at `host.docker.internal:7880`), `update-node-ip.sh` on cron. Blobs on
  bind mount `/mnt/openvoxa-blobs`. Account keys in volume
  `deploy_key-data`, wrapped under a KEK (Ryan holds the only copies),
  backed up daily 03:30 to `~/openvoxa-key-backups` (7 days). Closed off:
  Ryan is the only user. Disk is at 86% (17 GB of Docker build cache).
- Known gaps and untested steps (K1 flows 2-5, G2-G4, P3, D1): decisions.md
  Open items.
- **Next:** the backlog, discuss each with Ryan before building: touchscreen
  push-to-talk button, avatars, server icons, bug reports (then enable the
  About tab's Report a Bug), channel links (Copy Link), maybe channel
  actions in the moderation log (Ryan undecided). Desktop updates later:
  code signing, "server needs app version X".
