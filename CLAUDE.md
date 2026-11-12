# CLAUDE.md — OpenVoxa working notes

Read this first; the long versions are linked. Keep it under ~180 lines.
Public and generic: it describes the project for any contributor. Notes
about one person's own machines, servers or accounts go in a gitignored
`CLAUDE.local.md` (Claude Code loads it alongside this file), never here.

## What this is

Self-hosted, non-monetised Discord/TeamSpeak alternative: text channels,
voice, screen share, forum-style features. Beta. **Built for
gaming groups:** smooth game screen shares (60 fps, every viewer) and
low-latency voice come first; never trade them away for savings.
Repo: github.com/OpenVoxa/OpenVoxa. Explain non-obvious choices; don't
assume the reader is an expert in MLS, WebRTC or Go.

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
- **Account deletion = crypto-shredding** (built): plaintext is sealed
  under a per-account key file (`internal/keystore`), destroyed on delete.

## Where things are written down

`docs/decisions.md` records every decision; search by section name.
Key sections: **Feature decisions** (one #### per feature, then
Planned), **Encryption**, **Implementation notes** (gotchas grouped MLS /
LiveKit / Electron / server / web client / builds: read the group before
touching that code), **Build order** (dated, with test IDs), **Open
items** (Next up, not built, untested, security gaps, Closed).
`README.md` is public status; `deploy/README.md` is operations;
`CONTRIBUTING.md` covers DCO and PRs.

## Layout

```
server/            Go (module root; go.mod says go 1.26)
  main.go, cli.go     host commands: grant-admin, list-admins, list-users,
                      delete-user, reset-two-factor
  Dockerfile          client-core -> client-web -> Go -> distroless
  internal/httpapi/   HTTP + WS, one file per feature; livekitapi.go = LiveKit
                      admin calls; webui/ = embedded client-web build
  internal/db/        Postgres; migrations/00NN_*.sql embedded, ordered (latest 0041)
  internal/{auth,blob,config,gif,hub,keystore,password,perm,ratelimit,sealedfile,totp,unfurl}
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
- `cd client-desktop && npm run release:win` (update address in the
  gitignored `update-url.local`): bumps the patch version, builds the NSIS
  installer (Wine container) and publishes it to `deploy/desktop-updates`
  (served at `/desktop-updates/`); installed apps update from there.
  `npm run package:win` alone: zip in `release/`. deploy/README.md,
  "Desktop app".
- Go without installing it: quick compile, vet and tests from `server/`:
  `docker run --rm -v "$PWD":/src -v ovx-gomod:/go/pkg/mod -w /src golang:1.26 sh -c 'go vet ./internal/httpapi/ && go test ./internal/<pkg>/ && go build ./...'`
  (`ovx-gomod` caches modules). The image build is the final check.
  DB tests (`TestDMAccess`) skip unless `OPENVOXA_TEST_DATABASE_URL` is
  set: start a throwaway `postgres:17-alpine` on a `docker network`, pass
  `--network` and the URL to the golang container, remove both after.
- Don't let `go mod tidy` raise the `go` directive above golang:1.26.

Running stack (from `deploy/`):

```bash
docker compose --profile tls up -d --build            # rebuild + restart (tls = Caddy)
docker compose --profile tls up -d --force-recreate   # after .env edits
docker compose ps
docker compose logs server --tail 30                  # or caddy / livekit; --since 10m
docker compose exec server /openvoxa-server list-users   # host commands
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

First-time setup: deploy/README.md. The server image is distroless (no shell).

## Workflow

- After a change: build, rebuild the local stack, check `ps` and `logs
  server --tail 15`, hard-refresh (Ctrl+Shift+R) and test, then commit.
- Test steps get IDs (e.g. SL1-SL5) and are recorded in decisions.md.
- Discuss designs before building anything with a real choice in it.
  Verify LiveKit/ts-mls behaviour by experiment, not docs.
- `git commit -s` (DCO), short imperative subject, one logical change per
  commit. Never commit `.env`, keys, `docker-compose.override.yml` or
  `CLAUDE.local.md`.

## Rules of thumb (don't relearn these)

- The server is a delivery service for MLS: it stores and routes opaque
  blobs, never parses them. Commit ordering is compare-and-swap on a
  client-supplied epoch hint. `messages.body` is opaque `BYTEA`.
- A **device** is the crypto identity, not an account. Schema is
  multi-device; only single-device is implemented.
- Key packages are single-use (`FOR UPDATE SKIP LOCKED`) plus one
  reusable last resort. Encrypted channels show no earlier history.
- Ratchet trees travel as tagged JSON (our codec): watch `Uint8Array`,
  `BigInt`, and `undefined`-vs-`null` blank nodes.
- ts-mls docs describe intent, not return shapes: verify by experiment.
- LiveKit track info (size, layer bitrates) is what the browser
  declared, never measured. LiveKit is pinned exactly and its E2EE
  worker is bundled by Vite from client-core's copy (`voiceWorker.ts`):
  it must be same-origin, same build.
- Permission changes must explicitly reach live WebSockets and live
  voice calls (`kickFromLostVoice`).
- Defaults: visual pop-ups off, in-page sounds on; least friction.
- **UI:** colours only as variables in `client-web/src/styles.css`
  (users override them via `appearance.ts`). Match existing UI
  exactly: sizes, spacing, Title Case tab names. Buttons must look like
  buttons; reuse `primary` (filled accent), `outline` (accent outline),
  `save` (green, grey when disabled, bottom left) and `Modal wide fixed`
  (Settings and Server settings, both 80% of the window, footer `.modal-foot`).
  Grey out unavailable controls instead of hiding them.

## Current state

Releases are tags `v1.0.0-beta.N` (fixes `v1.0.0-beta.N.M`). What's
untested, known gaps and what's next: decisions.md, Open items.
