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
| File attachments | Content-addressed blobs on local disk, deduplicated by SHA-256. Per-file size limit set by the admin. Attachments inherit their channel's retention through the message that carries them. |
| Moderation | Client-supplied plaintext with server-side signature verification |
| Voice input | Push-to-talk and voice activation, user-selectable; moderators can force PTT per voice channel |
| Media stack | LiveKit, self-hosted. MIT-licensed, built-in E2EE, SFU relays ciphertext only. |
| GIF provider | Admin-selectable between Giphy and Tenor, or disabled entirely (the default). Every image is proxied by the server and a chosen GIF is stored locally as an attachment, so clients never contact the provider. |
| Moderation | Message removal by author or moderator; reports verified server-side; bans that revoke sessions and live connections. Purging a banned user's history is administrator-only and separate from the ban itself. |
| Markdown | Hand-rolled minimal renderer rather than a library: bold, italic, strikethrough, inline and fenced code, blockquote, autolinks. Small enough to audit, and avoids trusting a dependency with untrusted input. |
| TLS | Required in practice. Caddy provided but optional; three deployment paths documented. |
| Permissions | Admin-defined groups, each with its own permissions, assigned to channels (Discord roles / TeamSpeak server groups). Replaces the fixed four roles later; the fixed roles stay until then. Decided by Ryan, 2026-10-30. |
| Encrypted channel membership | Follows channel access automatically. Nobody adds people to encryption groups by hand; every device that joins is announced to the channel. Decided by Ryan, 2026-10-30; see Encryption. |

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

**The server's permission list decides who joins encrypted channels.**
Automatic membership means a malicious operator, or anyone who takes over
the server, can grant a device of their own access and have members'
clients add it. They then read everything sent from that point on (not
before: new members see no history). This is the trade Discord's voice
E2EE and most group messengers make. It is bounded by visibility rather
than prevented: every join is announced to the channel, so a ghost
device cannot be added silently. Device verification (comparing safety
numbers, as Signal does) would let users confirm each other's devices
and is the eventual stronger answer. Self-hosting limits who the operator
is; it does not remove the operator from the trust model.

**Per-account login limiting can be weaponised.** Five failed attempts
throttles an account, so someone who knows a username can lock them out
for a few minutes. Mitigated by a short window, slow refill and an
immediate reset on successful login. Every major service picks some
version of this tradeoff; there is no clean answer.

**Live deletion reaches connected clients only.** An offline client keeps
whatever it cached until it reconnects, and nothing prevents a screenshot.
Deletion is enforced server-side and propagated live, which is the part
that can be enforced.

## Encryption

Decided before any of it was built, because each of these is expensive to
change later.

**ts-mls now, OpenMLS possibly later, behind an interface.** OpenMLS is
the reference implementation and more heavily scrutinised, but there is no
published JavaScript or WebAssembly build of it. Using it means authoring
a Rust crate that wraps it with wasm-bindgen, adding a Rust toolchain to
the build, and solving state persistence across browser restarts. That
wrapper would itself be unreviewed security-sensitive code written by
someone new to Rust, so "use the audited library" buys less than it
sounds like.

ts-mls is pure TypeScript and installs with npm. It is younger and
self-describes as containing possible undiscovered vulnerabilities. The
protocol work - identity, key packages, groups, commit ordering, encrypted
messages - is the same either way and is weeks of effort that has nothing
to do with which library sits underneath. So: build against an
`MlsProvider` interface, implement it with ts-mls, and treat the OpenMLS
wrapper as a possible hardening pass once there is a working system and
tests to swap behind.

**Ciphersuite 1, `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`.**
Mandatory to implement in RFC 9420, so any conforming implementation can
interoperate - which is the point, given the provider may be replaced. It
also has the smallest dependency footprint ts-mls offers. Post-quantum
suites are available and deliberately unused: they add packages and
address a threat that is not this project's first problem.

**A device is the cryptographic identity, not an account.** Each device
holds its own signature key and is its own leaf in every group. That is
what allows reading a channel on a desktop and a phone without either
holding the other's private keys. Only single-device is implemented, but
the schema is multi-device from the start: retrofitting it onto a
user-keyed design would mean rebuilding every group.

**Key packages are single use, with a reusable last resort.** You are
added to groups while offline, so devices publish key packages in advance
and the server hands them out one at a time. Handing the same one out
twice would mean two groups sharing an initial secret, which is exactly
the forward secrecy failure MLS exists to prevent. Claiming is an
`UPDATE ... FOR UPDATE SKIP LOCKED` so simultaneous adds take different
packages.

When a device's pool runs dry there is a last-resort package, which RFC
9420 permits and is explicit about: it is reusable and therefore weakens
forward secrecy for joins that use it. The claim response reports when one
was used so a client can surface the weaker guarantee rather than hide it.
It is a fallback, not the normal path, and clients replenish before
reaching it.

**New members see no history.** Forward secrecy and new-member scrollback
are mutually exclusive: old keys are destroyed as the group ratchets
forward, and handing them to a newcomer means anyone added later, or any
member who is compromised, gets the archive too.

Rather than weaken the guarantee or build a re-encryption mechanism, the
existing per-channel encryption toggle answers this. An encrypted channel
is private from the operator and shows nothing from before you joined; a
plaintext channel has full searchable history for everyone. Both states
are already displayed in the channel label beside the retention policy,
so users know which kind of space they are in before they post. Bounded
retention softens the edge considerably: in a channel that keeps thirty
days, "nothing before you joined" is a small loss.

**Ratchet trees are serialised with our own codec, not MLS wire format.**
A joiner needs the group's ratchet tree alongside the welcome, and it has
to reach them through the server as bytes. The RFC-intended route is the
`ratchet_tree` extension, which would make the welcome self-contained;
ts-mls exposes no encoder for a bare tree and no documented way to
populate that extension, and several attempts at inferring one failed.

So the tree travels as JSON with explicit tags for the types JSON cannot
represent. What that costs is interoperability: another MLS
implementation could not read those bytes. That matters only for
interoperability this project does not have and is not promising, and
swapping the provider would change this layer anyway.

What it does not cost is anything cryptographic. A ratchet tree is public
data - it is what a joiner is handed precisely because it reveals no
secrets - so how it is framed in transit is a compatibility question, not
a security one.

This is nonetheless the weakest part of the crypto layer and the first
thing to replace if ts-mls documents the extension. Three types needed
explicit handling and each was found by failure rather than by reading:

- `Uint8Array`, which JSON turns into an object with numeric keys
- `BigInt`, used for leaf indices and generations, which JSON throws on
  rather than silently narrowing to a float
- `undefined`, used for blank nodes, which JSON converts to `null` in
  arrays - and this one is the dangerous shape, because it SUCCEEDS and
  returns something subtly different. ts-mls then tests for an absent
  node, a null passes the test, and it reads a property off nothing.

Hand-rolled serialisation of another library's internal structure is
fragile by nature. The failures that throw are fine; the one to fear is
the one that round-trips cleanly and is wrong.

**Group state is stored as bytes with its configuration rebuilt.**
`encodeGroupState` loses exactly one field, `clientConfig`, and for a good
reason: it holds an authentication service and other callables that
cannot be serialised at all. It is reconstructed from the library
defaults on load rather than carried across, because a config captured
before a restart could hold stale callables closed over a dead session.

The encoded state contains private key material and never leaves the
device.

**The server is a delivery service, never a participant.** It stores and
routes key packages, handshake blobs and ciphertext, and parses none of
it. Its one substantive job is ordering commits: MLS groups advance in
epochs, and two clients committing against the same epoch is a conflict,
so the server picks a winner by refusing any commit whose epoch is not
current.

ts-mls frames commits as private messages, which means the server cannot
read the epoch out of them. The client therefore sends `{epoch, opaque
blob}` and the server does a compare-and-swap on the epoch. The epoch is
a hint for ordering, never something trusted: a client that lies about it
has its commit accepted by the server and then rejected cryptographically
by every other member, which is a self-correcting failure.

**Group membership follows channel access, automatically.** Being allowed
into a channel, text or voice, is what puts a user's devices into its MLS
group, and losing access is what takes them out. Decided by Ryan,
2026-10-30. The alternative, a member approving every add by hand, is
stronger against a hostile server but unusable at the scale of a real
community, and it is not what Discord or TeamSpeak users expect.

The constraint that shapes how: the server cannot add anyone. A commit
can only be produced by a device already in the group, because only
members hold the group's secrets, and that is the point of the design. So
the server's role is to say who *should* be in, and clients do the rest:

1. **Member reconciliation (the normal path).** The server reports, per
   channel, which permitted devices are missing from the group and which
   members no longer have access. Any member's client that is online
   adds the missing and removes the revoked, in the background. The
   existing commit compare-and-swap means two members doing this at once
   cannot fork the group; the loser rebases and finds nothing left to do.
2. **External join (the fallback, not yet verified).** When no member is
   online, a permitted device joins on its own from a GroupInfo the group
   publishes to the server (RFC 9420 external commit). Whether ts-mls
   1.6.2 supports this has to be established by experiment before it is
   designed in. Until then a new member waits for any member to come
   online, which for voice is usually immediate: you are joining a call
   somebody is already in.

The server still checks access before accepting any commit or welcome,
so a client cannot add someone the permissions do not allow.

Access is answered by one server-side question, "may this account view
this channel?", which today is the role check and later is the custom
groups check. Membership is built against that question, so custom groups
change its answer without touching the encryption code.

Every device joining or leaving is shown in the channel ("staff added a
device", "ryan's laptop was removed"). That is the mitigation for the
tension below and is part of the feature, not polish.

The "Add everyone" and "Add everyone to voice" buttons in the debug page
are test scaffolding for this and go away when reconciliation exists.

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

**Attachments are claimed, not asserted.** Upload happens before the
message is sent, so an oversized file fails before anyone has composed
anything. When a message claims attachment IDs, the `UPDATE` matches only
rows where uploader, channel and unclaimed status all line up. Guessing
someone else's attachment ID matches nothing, so the authorisation check
and the claim are the same statement.

**Attachment downloads use signed URLs, not sessions.** A browser will not
send an `Authorization` header on an `<img src>` or `<video src>`, so the
download route cannot require a session. Putting the session token in the
URL would write credentials into access logs, which is exactly what the
websocket ticket exists to avoid. Instead the server mints an HMAC-signed,
time-limited link when it delivers the message, and the permission check
happens at minting time when the caller's role is known.

The tradeoff is the one presigned object-storage URLs make: anyone holding
the link can fetch the file until it expires, regardless of channel
access. A two-hour lifetime bounds it. The signing key is random per
process, so a restart invalidates outstanding links and clients get fresh
ones on their next history load.

**SVG is not in the inline-serving allowlist.** It is an image to users
and a scriptable document to browsers. Served inline it is stored
cross-site scripting against our own origin. Content type is taken from
the file extension rather than the client's claim, and anything
unrecognised becomes `application/octet-stream` with `nosniff` and an
attachment disposition.

**Docker applies image directory ownership only on a volume's first
mount.** A named volume for the blob store arrives owned by root, and the
server runs as `nonroot` (UID 65532), so directory creation fails and the
container crash-loops. Distroless has no shell, so the Dockerfile uses a
throwaway Alpine stage to create the directory with the right ownership
and copies it into the final image. Changing this after a volume exists
requires removing the volume.

**Oversized uploads must be rejected before the multipart parser runs.**
`MaxBytesReader` kills the parser before it yields a file, so the error
that surfaces is "malformed form" when the truth is "file too large".
Checking `Content-Length` first gives the right message and avoids
buffering the upload at all; the body cap stays as a backstop because a
chunked request declares no length.

**Blobs are safe on network storage; Postgres is not.** Attachment bytes
are write-once, read-many, with no locking, which NFS handles fine. A
database over NFS is a well-documented way to corrupt things. The blob
directory is a single path in config precisely so it can be a bind mount
to whatever an operator wants.

**Clients never contact the GIF provider.** Thumbnails in the picker are
proxied through this server, and picking a GIF makes the server download
it once and store it as an ordinary attachment. Linking to the provider's
CDN instead would mean every viewer, for as long as the message exists,
quietly tells Giphy they are reading this channel. As an attachment it is
also deduplicated, governed by channel retention, and destroyed with its
message.

The server still sends search queries to the provider, so they learn what
this instance searches for but not who searched. Same shape as link
previews, which is why the feature is off by default and an operator opts
in knowingly. The media proxy only fetches from a hardcoded list of
provider CDN hosts, and only URLs this server signed: a provider response
is still remote input.

**Reports carry the reporter's copy and are verified against ours.** A
reporter's client sends what it believes the message said. In a plaintext
channel the server compares that against its own stored copy; in an
encrypted channel it will verify the author's MLS signature over the
claimed bytes instead. A mismatch is rejected and recorded, because filing
a provably false report is itself actionable. `verified` is nullable so a
moderator can tell "checked and failed" apart from "could not be checked",
and the UI offers destructive actions only on verified reports.

**Banning is not deleting.** Deletion is the user's own right; using it as
a punishment would destroy both the evidence that justified the ban and
content other people are still reading. A banned account stays, locked.
Purging their history is a separate, administrator-only decision on top of
the ban, and it is irreversible: unbanning restores the account, never its
messages.

There is a tension worth knowing before it bites: purging destroys the
evidence for the ban. If the ban is later disputed, the moderation log
records that a purge happened and how many messages it covered, but not
what they said. Resolving the reports first preserves the reported content
in the `reports` table.

**Revoking access must reach live connections explicitly.** A websocket is
authenticated once, at upgrade, and then runs until it is closed. Deleting
sessions stops the next request and does nothing to a socket already open,
so a banned user kept posting until they happened to disconnect. The hub
tracks which user owns each connection and closes them on ban or account
deletion. Any future change that revokes access, including role demotion,
needs the same treatment.

**Index predicates cannot reference `now()`.** Postgres requires them to
be IMMUTABLE, because an index whose membership changed with the clock
would silently stop matching its own definition. "One active ban per user"
is therefore a unique index over permanent bans only, with overlapping
temporary bans caught in the handler under a row lock. Any time-dependent
uniqueness constraint needs the same split.

**One parse-time throw disables every handler below it.** The debug client
is a single script with no module boundaries. A reference to an element
that did not exist threw while handlers were being attached, and
everything after that line — including the login button — was silently
never wired up. The symptom was a button that did nothing, with no network
request and no error anywhere obvious. GIF and moderation controls are now
attached through a helper that warns rather than throws. This disappears
with `client-web`, where components fail independently.

**Seven ts-mls API details were observed rather than documented.** Each
was written against the README first and was wrong. The pattern, not any
individual case, is the useful record: this library's documentation
describes what the functions are for, not what they return or in what
shape, and inferring either from prose did not work once.

That is the real argument for the OpenMLS swap, and it is not that its
MLS is better. It is that its API would be types that can be read.
Against that, the wrapper would be unreviewed Rust written by someone new
to Rust, so the trade is API clarity for a new risk surface rather than a
clear win. Recorded so the decision can be made on accurate costs.

The details themselves:

- `createCommit` returns `commit` as a COMPLETE MLSMessage carrying its
  own version and wireformat, while `welcome` comes back as a bare
  Welcome that still needs wrapping in `encodeMlsMessage`. The asymmetry
  produces confusing errors deep inside the encoder.
- Commits are framed as private messages by default.
- The exporter is `mlsExporter(exporterSecret, label, context, length,
  ciphersuite)`. It takes the key schedule's exporter secret, not the
  group state, and the ciphersuite's `kdf` object has only `extract`,
  `expand` and `size` - no `expandWithLabel`.
- `@noble/curves` and `@noble/hashes` are OPTIONAL peer dependencies, so
  npm skips them, but esbuild follows every import reachable from the
  entry point and needs them present regardless of which ciphersuite is
  used. Optional peer dependencies and bundlers do not mix.
- `encodeGroupState` exists and round-trips, minus `clientConfig`. There
  is no equivalent for a bare ratchet tree.
- Passing a `ratchet_tree` extension to `createGroup` is accepted but
  does not put the tree in the welcome; joining still reports "No
  RatchetTree passed and no ratchet_tree extension". Whatever populates
  that extension was not found.
- `joinGroup` takes the tree as an in-memory object, so transporting it
  is entirely the caller's problem.

**The Docker build context is the repository root.** The server image
bundles client-core alongside the Go binary, so the Node stage and the Go
stage both need to be in context. The bundle must be copied in BEFORE
`go build`: the embed directive reads the directory at compile time, so a
bundle copied afterwards silently produces a server with no client.

**Attachments in encrypted channels are encrypted per file, keyed in the
message.** The client encrypts each file with a fresh random AES-256-GCM
key before upload. The key, nonce, real filename, real type and size go
inside the MLS message that claims the attachment, in a small JSON
envelope (`{"ovx":1,"text":...,"files":[...]}`; anything else decodes
as bare text, so earlier messages stay readable). The server stores the
ciphertext under the name `encrypted` as `application/octet-stream`, and
overrides whatever the client sent, so a client bug cannot leak a real
filename into the database.

A per-file key rather than one derived from the epoch: the file stays
readable to anyone who can read the message, which is what opt-in
history sharing will need, and its lifetime is not tied to group state.
GCM authenticates the bytes and the key arrives in an authenticated
message, so a swapped or altered blob fails to decrypt rather than
showing something else.

Still visible to the server: approximate file size (ciphertext is
plaintext plus 16 bytes; no padding yet), upload time, and which message
carries how many files. Deduplication is gone for these blobs, as
intended.

Decrypted files are shown through `blob:` URLs, which belong to our
origin. The type given to the blob comes from the same allowlist the
server uses for inline serving, never from the sender, and saving uses a
`download` link rather than opening a tab. Otherwise a member could send
an HTML file that runs as us when opened. Previews decrypt the whole file
up front: GCM cannot be streamed into a `<video>` without chunking.

**A message can be decrypted once.** MLS deletes each message key as
soon as it is used, which is what forward secrecy means. Reloading the
page and decrypting history again therefore fails for every message,
not just ones from before joining. The client keeps a local archive of
plaintext (IndexedDB, keyed by message id) and checks it before trying
to decrypt; attachment keys survive reloads because they are inside
that plaintext. Messages read before the archive existed are gone for
good on that device. Received messages are processed through a single
queue, because two decryptions running at once each start from the same
saved group state and the later save throws away the earlier one's
ratchet progress.

**Encrypted channels must not ask the server to look at content.** Link
previews did: the server fetches the URL, so it would learn every link
posted. Previews are skipped in encrypted channels.

**Provider GIFs are allowed in encrypted channels, unencrypted.** A GIF
from the picker is public content the server fetched itself; storing it
in the clear tells the server which public image was picked, not
anything a user wrote or uploaded. The protection that matters there is
that users never contact the provider, which still holds. A `.gif` a
user uploads from their own device is an attachment like any other and
is encrypted. Decided by Ryan, 2026-10-30.

**`go mod tidy` silently raises the `go` directive.** Running it with a
newer local toolchain than the Dockerfile's base image rewrites `go.mod`
and the container build then fails with a confusing version error. Keep
the Dockerfile's Go version at or above the directive.

**Media keys come from the voice channel's own MLS group.** A voice
channel gets a group exactly like an encrypted text channel. Each member
derives the frame key with the MLS exporter (label `OpenVoxa media key
v1`, context = channel ID, 32 bytes) and hands it to LiveKit, which runs
it through HKDF to an AES-GCM key and encrypts every frame in a worker
before it leaves the browser. The key is never transmitted. A membership
change is a new epoch and therefore a new key, so removal and addition
rotate media keys with no separate key distribution.

**LiveKit key slots are epoch mod 16.** Members process a commit at
different moments, so for a short while some encrypt under the new epoch
and some under the old. LiveKit keeps a ring of keys and every frame
carries the slot it was encrypted with, so both keys stay usable during
the handover. `ExternalE2EEKeyProvider.setKey` always writes slot 0, which
would overwrite the old key mid-handover; the client subclasses
`BaseKeyProvider` instead. Options: `sharedKey: true`, `ratchetWindowSize:
0` (keys come only from MLS, never from LiveKit's ratchet),
`failureTolerance: -1` (a failed frame never marks a key invalid; with the
default of 10 a member who is briefly behind would discard the right key).

**Voice refuses to start without encryption.** Keys are loaded and
`setE2EEEnabled(true)` is called before `connect`, so nothing is ever
published in the clear, and a browser without insertable streams or
`RTCRtpScriptTransform` cannot join. `room.isE2EEEnabled` reads false until
connected (it waits for an event naming the local participant);
`localParticipant.isE2EEEnabled` is what governs publishing and is true
from the start.

**LiveKit is served from our origin, pinned exactly.** Browsers refuse a
Worker script from another origin, and the E2EE worker speaks a message
protocol to the main library that changes between releases, so a floating
CDN tag would eventually break encryption silently. Self-hosting also
removes a third party able to serve code that sees every decrypted frame.
`client-core/build.mjs` copies both files from `node_modules`; the
Dockerfile puts them in `debugui/`. The worker is not terminated by
LiveKit; the client terminates it on leave.

**Voice commits are polled.** `group_advanced` only reaches subscribers of
the text channel a socket is connected to, so a call also catches up on
its voice group when someone joins, on any decryption error, and every 5
seconds. Cheap at this scale; a socket subscribed to several channels
would replace it.

## Build order

1. ✅ Server skeleton, auth, one text channel
2. ✅ Permissions: Administrator, Moderator, User, Guest
3. ✅ Voice via LiveKit, unencrypted
4. ✅ TLS deployment
5. ✅ Screen sharing with configurable resolution and frame rate
6. ✅ Retention enforcement, account deletion, live deletion events
7. ✅ Rich text — markdown, link previews, attachments, GIF picker
8. ✅ Moderation tooling — message removal, verified reports, bans
9. 🔶 MLS for text — the largest single piece of work
   - ✅ `client-core` package, build pipeline, MLS provider interface
   - ✅ Browser self-test: group create, add, join, encrypt, decrypt,
     matching exported secrets
   - ✅ Server-side device identity and key package storage
   - ✅ Client identity: real keys in IndexedDB, device registration,
     key package publishing and replenishment
   - ✅ Server-side group state, epoch-ordered commits, handshake log,
     welcome delivery
   - ✅ Tree and state serialisation proven end to end in the browser
   - ✅ Client group logic: create or join, apply commits, persist,
     rebase on conflict
   - ✅ Encrypted application messages (verified single-user: ciphertext
     at rest, plaintext channels unchanged)
   - ✅ Two-party test: welcome path and forward-secrecy boundary on a
     real second device (ryan + staff, 2026-10-30)
   - ✅ Encrypted attachments: client-side AES-GCM, key in the MLS
     message. Verified on Docker 2026-10-30 (ryan + staff): image, mp3
     and PDF readable by the other member; stored blob is opaque data;
     server row shows `encrypted` / octet-stream
10. ✅ Media encryption keyed off the MLS exporter secret
   - ✅ Exporter-derived media key, verified in Node: members agree,
     key changes per epoch and per channel
   - ✅ LiveKit E2EE wired with epoch-indexed key slots, self-hosted
     and pinned LiveKit 2.23.0; checked headless against the real bundle
   - ✅ Two-party call on Docker (ryan + staff, 2026-10-30): a device
     outside the group is refused; adding it rotates the key (epoch 1);
     audio and screen share both ways, simultaneous streams fine
11. ⬜ Automatic group membership from channel access: member
    reconciliation, join and leave notices, then external join if ts-mls
    supports it. Built against the current roles.
12. ⬜ Custom permission groups replacing the fixed roles
13. ⬜ The real client: `client-web`, `client-desktop`

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
- [ ] Role demotion does not reach a live websocket. A demoted moderator
      keeps whatever their open connection already permits until they
      reconnect. Same fix as bans: close or re-evaluate the connection.
- [ ] Nothing reads `moderation_log` yet. The data accumulates; a review
      interface does not exist.
- [ ] Reports in encrypted channels will need MLS signature verification
      before `verified` can be anything but NULL there.
- [ ] Group state persists to IndexedDB as bytes, but UNENCRYPTED. The
      protection today is browser origin isolation; anyone able to read
      browser profile data on the device can read the keys. The fix needs
      recovery keys to exist first, since encrypting with a key also
      stored in IndexedDB would look like protection while providing
      none.
- [ ] The `ratchet_tree` column in migration 0010 assumes the tree
      travels separately from the welcome. If the extension route is ever
      made to work, both that column and the custom serialiser go away.
- [ ] Recovery keys do not exist. Without one, a forgotten password means
      permanently unreadable history, because the server holds only
      ciphertext. The key has to be generated at signup and shown once.
- [ ] Removing a revoked device from the groups it belongs to is
      client-side work. The server cannot do it, because it cannot
      produce a commit.
- [ ] Attachments in PLAINTEXT channels are still content-addressed and
      deduplicated across users, which reveals that someone else uploaded
      an identical file. Accepted there; encrypted channels no longer
      dedup.
- [ ] Encrypted attachment sizes are visible to the server. Padding to
      size buckets would blur them at some storage cost.
- [ ] The local plaintext archive is deleted per message on deletion
      events, but a message removed by retention while not on screen
      stays in IndexedDB. Needs timestamps stored with entries and a
      sweep against the channel's retention.
- [ ] Link previews in encrypted channels: would need to be generated by
      the sender's client and carried inside the message, as Signal does.
- [ ] Opt-in history sharing for encrypted channels (requested). An
      admin-set per-channel option, shown in the channel badge like
      retention, under which an existing member's client re-encrypts the
      plaintext it holds into the current epoch for a newly added device.
      Weakens the "new members see no history" guarantee by design, so it
      must be visible and off by default. Needs a local plaintext archive
      on member devices first; only own sent messages are kept today.
- [ ] A device whose commit the server accepted but which crashed before
      persisting the new state is stuck: it cannot process its own commit
      from the handshake log. Recovery would be a rejoin (external commit
      or re-invite).
- [ ] Media frames are authenticated to the group, not to a sender. The
      key is shared, so any member could forge frames under another
      member's identity. MLS gives per-sender keys for text; per-sender
      media keys (exporter context including the leaf) would close this
      at the cost of one key per participant.
- [ ] Group membership is still manual in the debug page ("Add
      everyone", "Add everyone to voice"). Policy decided (membership
      follows access, see Encryption); build-order step 11.
- [ ] LiveKit's `encryption` option also turns on data channel
      encryption. Nothing uses data channels yet; anything that does
      later gets it for free, but must not assume the SFU can read them.
- [ ] Unfurl endpoint is a deliberate SSRF surface. Worth naming in
      SECURITY.md so reviewers look at it first.
