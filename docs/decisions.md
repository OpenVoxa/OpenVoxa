# OpenVoxa — Design Decisions

Why things are the way they are, including the tradeoffs taken on purpose.
Read this before proposing architectural changes; most of the obvious
questions already have recorded answers.

## Goals and scope

OpenVoxa is a self-hosted text, voice and screen-sharing platform that
gives the operator and the user full control over their data. AGPLv3,
developed in the open.

What it commits to:

- Message content in encrypted channels is readable only by channel
  members, never by the server operator.
- Voice and screen media is end-to-end encrypted, relayed by a media
  server that cannot decrypt it.
- Every channel displays its retention policy and encryption status before
  anyone posts.
- Account deletion renders that user's content permanently unrecoverable
  on the server, and removes it from connected clients immediately.
- No telemetry, no analytics, no third-party data sharing.

Explicit non-goals for v1: federation, native mobile apps, large-scale
deployments. Target is tens of concurrent users per instance.

## Threat model

Goes in the README verbatim. Stating the limits is the point.

**Protects against:** a curious or malicious server operator reading
message content in encrypted channels; a network observer; another
instance operator; a subpoena served on the server that yields ciphertext
only.

**Does not protect against:** a compromised client device, since plaintext
lives there; metadata analysis by the operator, who can see who talks to
whom and when; a malicious channel member, who can always screenshot; a
compromised or coerced client build, since users run what we ship.

**Not yet proven.** Until a qualified reviewer has audited the
implementation, the README describes OpenVoxa as aiming for these
properties, not providing them.

Signalling metadata is visible to the server even when content is not.
True of essentially every system in this class; stated rather than glossed
over.

## Blocking decisions

| # | Decision | Chosen | Why |
| --- | --- | --- | --- |
| 1 | Protocol | Build from scratch | Learning is part of the point; full control over the data model. Accepts a longer road to parity than building on Matrix. |
| 2 | Federation | No | Instances stay independent, TeamSpeak-style. Keeps the deletion promise honest and avoids a corporate-style shared backend. Server identity stays in the protocol so federation remains possible later. |
| 3 | Clients | Desktop and web | Shared codebase, low marginal cost. Mobile deferred until v1 is stable. |
| 4 | Multi-device | Yes | Each device is its own MLS leaf. Identity model built for it from the start; single-device implemented first. |
| 5 | Encryption scope | Per-channel toggle, admin-controlled | Voice and DMs always encrypted with no toggle. Public channels at admin discretion, with a visible badge. |
| 6 | Message storage | Server stores ciphertext, admin-configurable retention | Retention window shown plainly in each channel. Bounds the scrollback key-handoff problem as a side effect. |
| 7 | Account deletion | Crypto-shredding | Destroy the user's key material; ciphertext becomes permanently unreadable. Survives contact with backups, unlike row deletion. |
| 8 | Server language | Go | Faster iteration than Rust for a solo first implementation. Rust reserved for pieces that need it. |
| 9 | Client shell | Electron | Bundled Chromium gives identical WebRTC, insertable-streams and screen-capture behaviour on every OS. Predictability beats binary size for a media app. |
| 10 | License | AGPLv3, DCO sign-off | Network-use copyleft prevents a closed-source hosted fork. DCO rather than a full CLA. |

## Feature decisions

| Area | Decision |
| --- | --- |
| Guest access | Off by default, admin-toggleable per instance |
| File attachments | Required. Size limit set by the admin. Attachments follow the channel retention policy. |
| Moderation | Client-supplied plaintext with server-side signature verification |
| Voice input | Push-to-talk and voice activation, user-selectable; moderators can force PTT per voice channel |
| Media stack | LiveKit, self-hosted. MIT-licensed, built-in E2EE, SFU relays ciphertext only. |
| GIF provider | Admin-selectable between Giphy and Tenor, or disabled entirely. Neither is privacy-clean; the tradeoff is documented rather than solved. |
| Markdown | Hand-rolled minimal renderer rather than a library: bold, italic, strikethrough, inline and fenced code, blockquote, autolinks. Small enough to audit, and avoids trusting a dependency with untrusted input. |
| TLS | Required in practice. Caddy provided but optional; three deployment paths documented. |

### How reporting works under encryption

The server has no decryption key, so the plaintext of a reported message
must come from a client that can read it. That plaintext is not trusted.

Every message is signed by its author's key, which MLS does automatically.
A report carries the claimed plaintext, the author's signature and the
message ID. The server verifies the signature against the author's public
key for that group and epoch.

A user who edits a message before reporting it cannot produce a valid
signature over the altered text, so the check fails. Filing a provably
forged report is itself actionable.

Requirements that follow:

- Moderator UI shows verification status, and the system blocks action on
  unverified reports in code rather than relying on the moderator noticing
  a badge.
- Every report is logged with its verification result.
- In plaintext channels the server compares against its own stored copy.

## Architecture

Five components, three of them off the shelf:

```
Desktop (Electron) ─┐                      ┌─ LiveKit SFU
                    ├─ WebSocket + REST ──▶├─ (relays encrypted media)
Web (React) ────────┘                      │
                              │            │
                    OpenVoxa server (Go) ──┘ mints JWTs
                              │
                    Postgres + object store
```

The server does auth, channel and permission state, message relay and
storage, MLS message routing (forwarding opaque blobs it cannot read),
retention enforcement, LiveKit token minting, link unfurling and file
metadata. It never decrypts anything in an encrypted channel and never
sits in the media path.

The server acts as an MLS delivery service: it forwards handshake and
application messages without understanding them, since all group key
agreement happens on clients. It therefore needs no MLS implementation for
v1.

| Layer | Choice |
| --- | --- |
| Server | Go |
| Database | PostgreSQL |
| Client core | TypeScript, shared by desktop and web |
| Desktop shell | Electron |
| Media | LiveKit, self-hosted |
| Reverse proxy | Caddy, optional |
| Group encryption | MLS (RFC 9420) |

Repo layout:

```
/server          Go: HTTP + WebSocket, Postgres, LiveKit tokens
/client-core     TypeScript: protocol, MLS glue, state
/client-web      React
/client-desktop  Electron shell
/deploy          docker-compose, Caddy configs
/docs            threat model, decisions, protocol notes
```

The `client-core` split is non-negotiable. If desktop and web diverge into
separate codebases, everything gets maintained twice.

## Known tensions

These do not have clean answers. Recorded so they are not rediscovered as
surprises.

**Link previews leak URLs to the server.** The client extracts the URL
locally and asks a server-side unfurl endpoint to fetch the preview. The
server learns which links are shared but never sees message bodies, and
user IPs never touch the linked site. Least-bad, not clean.

**Search is client-side only in encrypted channels.** The server indexes
nothing it cannot read. Bounded retention keeps the local corpus small
enough for this to work.

**Crypto-shredding still removes content.** Thread structure, reply chains
and message counts survive; message bodies do not. A shredded message
renders as a placeholder. Intended behaviour, not a defect.

**Shredding does not apply to plaintext channels.** No key exists to
destroy, so deletion there means emptying the body and leaving a tombstone
row. Two code paths, one user-visible result.

**Account recovery depends on the user.** Recovery keys are generated at
signup and held by the user. A lost password with no recovery key means
lost history, permanently.

**Bandwidth is the real hosting cost.** Ten viewers on one 1080p60 stream
is roughly 50 to 100 Mbps of sustained egress. "Free to host" assumes the
operator has the upstream.

**Per-account login limiting can be weaponised.** Five failed attempts
throttles an account, so someone who knows a username can lock them out
for a few minutes. Mitigated by a short window, slow refill and an
immediate reset on successful login. Every major service picks some
version of this tradeoff; there is no clean answer.

**Live deletion reaches connected clients only.** An offline client keeps
whatever it cached until it reconnects, and nothing prevents a screenshot.
Deletion is enforced server-side and propagated live, which is the part
that can be enforced.

## Implementation notes

Things that cost real time to discover and will be invisible when the
production client is written.

**LiveKit screen shares ignore `videoEncoding`.** Screen-share tracks read
`screenShareEncoding` and `screenShareSimulcastLayers`, not the video
equivalents. Setting the wrong one fails silently and leaves LiveKit's
default of 1080p at 15fps and ~1.5 Mbps in place, producing a stream that
appears to ignore every setting.

**`contentHint` defaults to detail on display capture.** That tells the
encoder to hold resolution and sacrifice frame rate, which pins screen
shares around 15fps regardless of bitrate. Set it to `motion` for video
content. The "prioritise detail / motion" control sets both this and
`degradationPreference`.

**H.264 simulcast is poorly supported; VP8 simulcast is mature.** So VP8
when simulcast is on, H.264 when it is off and hardware decoding matters
(notably Safari and iOS). Awkward and inherent to WebRTC today.

**`adaptiveStream` picks a layer from on-screen element size.** Sensible
for saving bandwidth, wrong when a fixed quality is wanted. Exposed as a
"pin max quality" toggle; it is Room-level so it only applies at join.

**Middleware that wraps `ResponseWriter` breaks WebSockets.** Wrapping
removes any interface beyond `ResponseWriter` itself, including
`http.Hijacker`, and every upgrade fails. The request logger forwards
`Unwrap` and `Hijack` for this reason. Any future wrapping middleware must
do the same.

**Browsers cannot send an `Authorization` header on a WebSocket.** The
usual workaround puts the token in the query string, which writes
credentials into access and proxy logs. Instead the client POSTs for a
single-use 30-second ticket and spends it on the upgrade.

**Session tokens get SHA-256, passwords get argon2id.** Password hashing
is deliberately slow to defeat dictionary attacks. A session token is 32
bytes from a CSPRNG with no dictionary to attack, so slow hashing would
cost latency on every request for no security gain.

**Login burns CPU on nonexistent users.** A dummy argon2 verification runs
when the username is not found, so a missing account does not return
noticeably faster than a wrong password. Without it, timing reveals which
usernames exist.

**`X-Forwarded-For` is read rightmost, not leftmost.** A reverse proxy
appends the address it saw, so a forged header produces "fake, real" and
the rightmost value is the trustworthy one. Only honoured when
`OPENVOXA_TRUST_PROXY` is set, since otherwise anyone can choose their own
rate-limit key.

**Retention sweep interval scales to the shortest policy.** A quarter of
the shortest retention on the server, clamped between 30 seconds and 15
minutes. A fixed interval makes the displayed policy wrong by a variable
amount; scaling bounds overshoot to 25% of the stated value.

**`messages.body` is `BYTEA` from the first migration.** Plaintext
channels store UTF-8 there today; encrypted channels will store MLS
ciphertext in the same column. Enabling encryption needs no migration.

**Server-to-client events never grant anything.** `role_changed` updates
what a client displays; the server re-reads the role from the database on
every request regardless. A forged event changes what a client draws and
nothing else.

**The SSRF check belongs in `Dialer.Control`, not `DialContext`.**
`DialContext` receives the hostname, so `net.ParseIP` there returns nil for
every real URL and the filter refuses everything while appearing to work.
`Control` runs once per connection attempt after name resolution, with the
resolved address, which is the only point where the check is both correct
and not racing a second DNS lookup. Checking the hostname instead would be
defeated by any public name with a private A record; `localtest.me`
resolves to `127.0.0.1` and is the standard test for this.

**A filter that blocks everything looks like a passing test.** The first
SSRF test set contained only hostile URLs. All four were refused, so it
looked correct, and the filter was in fact rejecting every request
including legitimate ones. Any test set for a blocklist must include a
known-good case, or a completely broken filter stays invisible.

**Markdown escapes before formatting, never after.** Message bodies are
untrusted input. Escaping first and applying formatting to the escaped
text means no user-supplied angle bracket can become a tag. The reverse
order is a stored XSS vulnerability.

**Link previews are click-to-load for embeds.** An auto-embedded YouTube
player would contact Google for every message containing a link, whether
or not anyone watches it. The thumbnail comes from the preview the server
already fetched, and the iframe (on `youtube-nocookie.com`) is only
created on click.

**Previews are deleted with their message.** A tombstone or retention
sweep removes the preview card too. Leaving it would keep the deleted
content's title and thumbnail on screen, which defeats the deletion.

**`go mod tidy` silently raises the `go` directive.** Running it with a
newer local toolchain than the Dockerfile's base image rewrites `go.mod`
and the container build then fails with a confusing version error. Keep
the Dockerfile's Go version at or above the directive.

## Build order

1. ✅ Server skeleton, auth, one text channel
2. ✅ Permissions: Administrator, Moderator, User, Guest
3. ✅ Voice via LiveKit, unencrypted
4. ✅ TLS deployment
5. ✅ Screen sharing with configurable resolution and frame rate
6. ✅ Retention enforcement, account deletion, live deletion events
7. 🔶 Rich text — markdown and link previews done; attachments and GIFs
   outstanding
8. ⬜ MLS for text — the largest single piece of work
9. ⬜ Media encryption keyed off the MLS exporter secret
10. ⬜ Moderation tooling with signature verification
11. ⬜ The real client: `client-core`, `client-web`, `client-desktop`

## Open items

- [ ] Confirm whether screen sharing should have its own `min_role_stream`
      rather than reusing the voice publish permission
- [ ] Server-side bitrate ceiling so one user cannot saturate the
      operator's uplink
- [ ] Force-PTT is advisory: the server tells the client and the client
      complies. Real enforcement means calling LiveKit's
      `MutePublishedTrack` API.
- [ ] Guest accounts can be assigned but there is no anonymous or invite
      flow to create one
- [ ] Reproducible builds
- [ ] Attachment storage: where blobs live, and how channel retention
      applies to them
- [ ] Unfurl endpoint is a deliberate SSRF surface. Worth naming in
      SECURITY.md so reviewers look at it first.
