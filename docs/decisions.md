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
| Permissions | Admin-defined groups, each with its own permission switches, assigned to channels (Discord roles / TeamSpeak server groups). Replaced the fixed four roles in build-order step 12. Decided by Ryan, 2026-10-30; model settled 2026-10-31, see "Permission groups" below. |
| Encrypted channel membership | Follows channel access automatically. Nobody adds people to encryption groups by hand; every join is announced to the channel: per person by default, per device as a client option (Ryan, 2026-10-31). Decided by Ryan, 2026-10-30; see Encryption. |

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

### Mentions are metadata the server sees

Decided by Ryan, 2026-11-03 (option A of two). `@name` tags someone in a
message and notifies them. The sender's client sends the mentioned user
IDs next to the body (`mentions` on the send frame and on PATCH), in
every channel. The server never reads `@` out of the text, so plaintext
and encrypted channels behave the same way.

- **What the server learns:** who was mentioned in which message, never
  what was said. That is the same kind of metadata as who posted when.
  It's stored in `message_mentions` (migration 0018), deleted with the
  message, on expiry, and when either account is deleted.
- **The rejected option (B):** only the recipient's client spots its own
  name after decrypting. The server learns nothing, but then nothing
  can tell you about a mention while you're offline, and later push
  notifications (Electron, web push) would be impossible for encrypted
  channels.
- **Access rule:** the server keeps only the IDs that may view the
  channel (the same rule as everything in `access.go`, so banned and
  deleted accounts drop out) and drops the author. Anyone else is dropped
  silently, so naming an outsider tells them nothing. Clients draw
  `@name` as a mention only when the server accepted it, so a name typed
  by hand for someone without access stays plain text. At most 20 per
  message.
- **Forgery:** a sender can list someone without writing their name.
  The result is a notification with no visible mention, from a person
  who could already message that channel. Accepted.

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

**Shredding works differently in the two kinds of channel.** Encrypted
channels need no extra key: MLS readers discard each message key after
use, so the server's copy is already unreadable to everyone. Plaintext
channels get a server-held key per account, kept outside the database,
and that is what deletion destroys. See Encryption, "Account deletion is
crypto-shredding". (Superseded 2026-11-03: this paragraph used to say
shredding did not apply to plaintext channels at all.)

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

External join sharpens this slightly. The GroupInfo the server stores is
enough on its own to join, so a hostile server needs no member online to
add a device; the announcement then appears when members next catch up,
not at the moment of the join. Members treat an external join exactly
like any other add: it is announced, and a device that is not on the
channel's allowed list is removed by the next reconciliation.

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
2. **External join.** A permitted device that nobody has added joins on
   its own from a GroupInfo the group publishes to the server (RFC 9420
   external commit), so it does not matter whether a member is online. Verified in Node against
   ts-mls 1.6.2 on 2026-10-30; see Implementation notes for the shape.
   Every commit makes the previous GroupInfo useless, so whoever commits
   also uploads a fresh one, and the server hands it only to devices that
   may view the channel. The joiner's commit goes through the same epoch
   compare-and-swap as any other.

The server still checks access before accepting any commit or welcome,
so a client cannot add someone the permissions do not allow. Decided by
Ryan, 2026-10-31:

- **Committing needs view access, not post.** Commits change membership
  and keys, not content, and every member may need to make one. A
  view-only account (a read-only channel, a listen-only voice user) is a
  member like any other.
- **Banned and deleted accounts are not allowed.** Their devices drop off
  the allowed list, so reconciliation removes them. When a temporary ban
  ends they are added back, with no history from while they were out.
- **Key packages are claimed for a channel.** The claim names a channel
  both the caller and the target may view. Before this, any account
  could claim any other's packages, draining the single-use pool and
  forcing the weaker last-resort package on them.

The rule lives in one file, `server/internal/httpapi/access.go`: one SQL
form (since step 12) for the caller and everyone else, used by the
websocket, voice tokens, every MLS endpoint, and
`GET /channels/{id}/mls/allowed-devices`. That endpoint lists each
non-revoked device of each permitted account. The server cannot say who
is missing from a group, since it cannot read commits; the client
compares the list with its own ratchet tree.

Access is answered by one server-side question, "may this account view
this channel?", which since step 12 is the permission-group allow-list.
Membership is built against that question, so custom groups changed its
answer without touching the encryption code.

Every device joining or leaving is shown in the channel ("staff added a
device", "ryan's laptop was removed"). That is the mitigation for the
tension below and is part of the feature, not polish.

**Notices are per person by default, per device on request.** Decided by
Ryan, 2026-10-31. Most users care who is in a channel, not which of
their devices is. So chat shows, by default:

- "staff joined" when an account's first device enters the group, and
  "staff left" when its last device leaves;
- "ryan joined on a new device" when an account already present gains
  another one. Not silent, because a device slipped in under an existing
  account is exactly what the announcement exists to expose;
- nothing when one of several devices leaves, which lets no one read
  more than before.

A client setting, off by default, shows the full per-device lines
(account, label, device ID, who committed, epoch). Both views come from
the user's own group state, so neither can be faked by the server.

Role-specific detail lives outside the chat, in the real client: a
moderator pane (reports, tickets, bans, deletions) and an admin pane
(device history, membership and encryption log, diagnostics, roles and
channels). The admin pane shows the server's records, useful for running
the server but not a safeguard against it; the per-device view above is
that safeguard and stays available to every user. The debug page keeps
printing everything, as a test tool.

**A group nobody permitted can commit to is replaced, not rescued.**
Decided by Ryan, 2026-10-31. If every remaining member loses access, no
one who is allowed in holds the group's secrets, and only a member can
commit. In order:

1. External join first. If the stored GroupInfo matches the epoch the
   server has on record, the next permitted device joins from it, and
   its own reconciliation then removes the members without access.
   Nothing is lost.
2. Otherwise a fresh group. When there is no GroupInfo, or it is from an
   older epoch than the server's record (the server tracks the epoch for
   commit ordering, so it can tell), the server lets a permitted device
   start a new group for the channel, exactly as a first-time create.
   The old group's handshake log and GroupInfo are dropped.

What a reset costs: devices see no messages from before it, which is the
same rule as joining any encrypted channel today, and the reset is
announced in the channel like any membership change. A hostile server
could force one, and so could a member running a modified client (by
committing without a GroupInfo), but neither gains anything it cannot
already do: the server can grant itself access (see Known tensions), and
a member can already wreck a group with garbage commits.

The "Add everyone" and "Add everyone to voice" buttons that stood in for
this in the debug page were removed on 2026-10-31, along with the public
`groups.addMembers`: reconciliation is the only way into a group.

**Local storage is encrypted under the password, with a server-held
half for refreshes.** Decided by Ryan, 2026-11-03; built the same day
(server `sessionsecret.go` + migration 0019, client-core `localkey.ts`,
`codec.ts`, `storage.ts`, client-web `unlock.ts`). Closes the open item "Group state persists to IndexedDB as
bytes, but UNENCRYPTED".

- *Data key.* Each account database gets one random 256-bit data key.
  Every stored value (device record, key packages, group state, the
  plaintext archive, the remembered backup key) is AES-256-GCM under it,
  with the store name and record key as additional data so values cannot
  be swapped between records. Record keys (channel and message ids) stay
  readable: someone with the files can count messages and channels, not
  read them.
- *Unlock at login.* The data key is wrapped by a key derived from the
  password with **Argon2id** (hash-wasm, pinned exactly, WebAssembly;
  same algorithm as the server's password hashing but a local random
  salt, so the result is unrelated to anything the server holds).
  Parameters start at 64 MiB / 3 passes / 1 lane and get tuned by timing
  on Ryan's machines (aim ~0.5 s). Salt, parameters and the wrapped key
  sit unencrypted in the device store; they are useless without the
  password. PBKDF2 was the alternative: built in, but much weaker against
  GPU guessing.
- *Refresh.* sessionStorage survives a refresh, memory does not. Each
  login session gets a random 32-byte secret on the server (a column on
  the `sessions` row, created on first request, gone with the row). The
  tab keeps the data key in sessionStorage encrypted under that secret,
  and a refresh fetches the secret to unlock silently. Logging out, a
  revoked session, "end other sessions" after a password change, or the
  30-day expiry makes any leftover copy (crash, "restore tabs") useless,
  so signing out a lost laptop's session also locks its keys. The server
  holds half of a tab's unlock for as long as that tab is signed in; it
  never sees the wrapped data key itself. Rejected: keeping the plain
  key in sessionStorage (on disk while the tab is open and after session
  restore), and asking for the password on every refresh.
- *Password change* in Settings rewraps the data key (old and new
  password are both at hand). Changed from another browser: this one
  cannot unwrap at its next login, so it is treated as a new device:
  wipe, register, restore history with the recovery key. Rare enough
  not to need a second wrapping under the recovery key (possible later).
- *Upgrade.* Existing plaintext databases are encrypted in place at the
  next password login. A refresh of an old tab with no data key yet goes
  to the login screen. The remembered backup key is a non-extractable
  CryptoKey and cannot be re-encrypted, so it is dropped once and the
  existing "enter your recovery key" prompt brings it back.
- *Sign-out keeps the device.* Decided by Ryan, 2026-11-03, after
  testing: wiping on sign-out meant typing the recovery key after every
  sign-out ("ease of use, simplicity and clarity" for end users). Sign-out
  now uploads the backup, locks storage and ends the session; keys,
  groups, archive and backup key stay, encrypted, and the password alone
  unlocks them next time. The recovery key is needed only when the device
  is revoked: unused for 30 days (server expiry) or removed in Settings,
  Devices. Its next sign-in wipes it (`Identity.start`, before client-web
  picks a recovery screen) and goes to the recovery-key screen. A signed
  out device stays in its groups, like a closed tab. Account deletion
  still wipes everything. Possible later: a "shared computer, erase
  everything" choice on sign-out.
- *Limits, stated plainly.* Protects a stolen or powered-off machine,
  copied disks and backups, and the browser profile while signed out.
  Someone with this browser AND the password can read the history kept
  here; with the password alone they could already sign in, though they
  would then need the recovery key for history. Does not protect against malware or a hostile script in
  the page while signed in, and a weak password can be guessed offline
  from copied files (the password rules are the defence). Electron can
  later add the OS keychain (`safeStorage`) on top.

**Account deletion is crypto-shredding.** Decided with Ryan, 2026-11-03.
The promise: once an account is deleted, nothing the server holds, its
backups included, can show that person's messages or files again.

*What the user sees.* Settings, Account, Delete account: one plain
paragraph ("This permanently deletes your account. Your messages and
files are erased everywhere this server controls, including its backups.
People who already read them may still have their own copies."), then
the password and the username typed out. On success the browser's local
data is wiped and the account is signed out everywhere. Everyone else
sees that person's messages become "[deleted]" placeholders, as before.
An administrator deleting someone gets the same result without the
password step.

*Why encrypted channels need no new key.* The original plan (Blocking
decisions, row 7) assumed each author's messages sit under a key of
their own. MLS does not work like that: a message is under the group's
key for that epoch, and every reader deletes the message key once it
has decrypted (forward secrecy). The server's copy of an encrypted
message, and every database backup of it, is therefore already
unreadable to anyone, the author included. Nothing to destroy there.

*Plaintext channels: a key per account, outside the database.* The
server reads these bodies, so a database backup holds them in the clear
and blanking the live row is not enough. Instead:
- Every account gets a random 32-byte key, stored as one file per
  account in a key folder (`OPENVOXA_KEY_DIR`, default
  `/var/lib/openvoxa/keys`, its own volume). The server creates the
  folder's contents itself; the operator sets nothing up.
- Plaintext message bodies are stored sealed under the author's key
  (AES-256-GCM, a format byte, a random nonce, and the message's
  channel and author bound in as associated data). `messages.sealed`
  says which rows are sealed; encrypted-channel rows never are.
- Report copies (`reports.claimed_body`) are sealed under the accused's
  key: they are that person's words. After deletion a report reads
  "content deleted"; the reason, status and who resolved it remain.
- Attachments in plaintext channels: the bytes and the filename are
  sealed under the uploader's key. Plaintext channels therefore stop
  deduplicating identical files, which also closes the open item that
  dedup reveals someone else uploaded the same file.
- Existing rows and blobs are sealed once, during the upgrade.
- Deleting the account deletes the key file. The rows stay as
  tombstones (reply chains keep their shape) and are still blanked, so
  the live database is clean at once; backups hold only sealed bytes
  whose key no longer exists. Attachments of the deleted account are
  deleted too (account deletion used to leave them; single deletes and
  ban purges already removed them).

*Why a folder of files rather than a table.* Anything in Postgres is in
every database backup, so a key kept there would be restored with the
data it is meant to destroy. A separate folder can be backed up on its
own, briefly. One file per account makes deletion a single unlink and
keeps a damaged file from affecting anyone else.

*What the operator must know* (`deploy/README.md`): back the key folder
up separately from the database and keep those backups short-lived (a
week, say). Deletion is complete once the last key-folder backup
holding that key has expired. Lose the folder with no backup and every
plaintext channel's history is unreadable. Encrypted channels are
unaffected either way.

*What it cannot do.* Other people's devices hold their own copies: the
local plaintext archive, their recovery backups, screenshots. Honest
clients delete stored copies of a deleted account's messages (they used
to only hide them): they ask the server which archived ids are gone, at
start and after `user_purged`; a modified client need not. The user-facing text says so. Usernames in the moderation log
for administrator deletions stay (that record is the point of the log).

*Not covered, deliberately.* Single message deletion and retention
expiry still blank or drop rows, and backups keep the plaintext until
they age out. A key per message would cover them too, at the cost of a
key store that grows with every message; revisit if anyone asks.

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

**Server-to-client events never grant anything.** `perms_changed` (was
`role_changed`) makes a client refetch what it displays; the server
re-reads permissions from the database on every request regardless. A forged event changes what a client draws and
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
deletion. A role change re-checks each channel the subject has a socket
open to and closes only the ones they can no longer view
(`closeLostChannels`, 2026-10-31). Any future change that revokes access
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

**Eleven ts-mls API details were observed rather than documented.** Each
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
- `joinGroupExternal` returns a bare `PublicMessage`, not an MLSMessage,
  so it needs wrapping (`wireformat: "mls_public_message"`) before
  encoding, and members apply it with `processPublicMessage`, not the
  private-message path every other commit uses.
- `joinGroupExternal(..., resync = true)` hangs forever when the old leaf
  is not found. It looks the old leaf up by signature public key, and a
  fresh key package has a new one; the miss becomes leaf index -0.5 and
  the tree walk never ends. Never pass `resync = true`. See the external
  commit note below for the replacement.
- A removed device learns it was removed from `groupActiveState`
  (`{kind: "removedFromGroup"}` after processing the commit) - except
  when the same commit also adds someone who lands in its old leaf. Then
  it reports `active` and believes the newcomer's leaf is its own. It
  still cannot read anything (it lacks the new epoch's secrets) and its
  messages are rejected, so nothing leaks, but it cannot tell it was
  removed. See the removal note below.
- A removed device processing its own removal THROWS when the removal
  shrinks the tree past its leaf (removing the rightmost leaves):
  "Could not find common ancestor" or "RangeError: Invalid array
  length". Removing a leaf in the middle reports `removedFromGroup` as
  documented. Found on Docker 2026-10-31 (staff stuck reopening
  `stuck-test`), reproduced in Node. So catch-up treats any commit it
  cannot apply as removal: drop the state, rejoin by welcome or
  GroupInfo.

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

**History sharing is opt-in per channel.** Decided by Ryan, 2026-11-01.
An administrator can turn it on for an encrypted channel; it is off by
default and the channel label says when it is on. With it on, every
device added to the group (new members and existing members' new
devices alike) is sent the plaintext existing members hold, for every
message the server still has, so retention is the only limit. The
member whose client committed the add does the sharing; for a device
that joined on its own from the GroupInfo, members take turns (the
reconcile stagger) and the server keeps the first bundle per device.
The bundle is an MLS application message in the current epoch, stored
in `mls_history_shares` until the recipient imports it (or a week).
A shared message is one member's copy and cannot be proven to match
the original, so it is shown with "shared by <name>", or "an unverified
member" when the sharer named inside the bundle is not the device that
uploaded it. This deliberately weakens "new members see no history"
for channels that opt in; the server still sees only ciphertext.

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

**Losing access removes you from the call, and old media keys expire.**
Found on Docker 2026-10-31: a banned account stayed in the call and stayed
audible. A LiveKit token only gates joining, and with `failureTolerance:
-1` nothing ever retired the old epochs' keys, which are all a removed
device can encrypt with. Two fixes. The server calls LiveKit's
`RoomService.RemoveParticipant` (Twirp JSON, room-admin token, internal
URL `OPENVOXA_LIVEKIT_API_URL`, default `http://host.docker.internal:7880`) for every
voice channel the account can no longer view, after a ban, a role change
or an account deletion. And each client overwrites every key slot but the
current one with random bytes 10 seconds after a new epoch key, so frames
under an old key stop decrypting even from a client that ignores the
removal. A member slow to apply a commit can drop out for a moment after
that handover. Revoking a single device does not kick, because LiveKit
identities are accounts and the account's other device may be the one in
the call; the key expiry covers that case.

**Voice commits are polled.** `group_advanced` only reaches subscribers of
the text channel a socket is connected to, so a call also catches up on
its voice group when someone joins, on any decryption error, and every 5
seconds. Cheap at this scale; a socket subscribed to several channels
would replace it.

**Background reconciles are triggered by hints and staggered by leaf.**
Every online member hears the same events, and if all reconciled at
once each would claim a single-use key package for the same new device;
only one commit wins and the other packages are burned. So
`groups.reconcileSoon` debounces (300 ms), coalesces (one run at a time
per channel, plus at most one queued), and waits 1.5 s per member leaf
ahead of its own (capped at 8, plus jitter). The lowest leaf goes first;
later members catch up on its commit and find nothing to do. Nothing
depends on this for correctness: the epoch compare-and-swap still
prevents a fork. Hints, 2026-10-31: the group was opened, a commit
landed (`group_advanced`, and the 5 s voice poll), `perms_changed`,
`user_purged`, and a new `access_changed` event the server sends on ban,
unban, device revoke and key package publish. Publish rather than
device registration, because a device is not addable until it has
packages; it also re-adds a device that was skipped for running dry.
Temporary bans expiring send nothing; the next hint picks them up.

**Join and leave notices come from the group, names from the server.**
Each device diffs the member identities in its own state before and
after every commit it makes or applies, including ones it catches up on
after being offline, so a device the server slips in is seen by every
member regardless of what the server reports. The device ID in each
notice is that ground truth; the account name and label next to it come
from the allowed list (cached) or `GET /channels/{id}/mls/device-names`,
which needs view access and resolves any device ID, revoked included,
because a device that just left is usually one no longer allowed.
Leavers are always looked up fresh, so a revocation shows. The notice
names the committer from the handshake log's `sender_device_id`, which
is also the server's word. Notices are emitted only after the new state
is persisted, and in order through one queue. The debug page holds them
while a channel's history loads, since history clears the log.

**External commit works in ts-mls 1.6.2.** Proven in Node on
2026-10-30 (throwaway script, not committed), with states round-tripped
through `encodeGroupState` as the browser does:

- A member calls `createGroupInfoWithExternalPub(state, [], cs)` and
  wraps the result as `{wireformat: "mls_group_info", version: "mls10",
  groupInfo}`. About 230 bytes; the ratchet tree travels separately in
  our JSON codec, exactly as it does with a welcome.
- The joiner calls `joinGroupExternal(groupInfo, publicPackage,
  privatePackage, false, cs, tree)` and gets `{publicMessage, newState}`.
  Existing members process the wrapped message and all three agree on
  epoch, member list and exporter secret; messages flow every way, and
  ordinary commits work afterwards.
- A GroupInfo from an older epoch still lets the joiner build a commit,
  but members refuse it ("epoch too old"). Our compare-and-swap would
  refuse it first.
- `createGroupInfoWithExternalPubAndRatchetTree` also works: the tree
  rides inside the GroupInfo (about 1.2 KB for four members) and the
  joiner passes no tree. This is the first route found that puts a tree
  in a ts-mls message at all.
- A device that lost its state rejoins with `resync = false`. The group
  briefly holds two leaves with the same device ID; any member then
  removes the one that is not the rejoiner's own leaf with an ordinary
  remove proposal, and the rejoiner follows that commit normally.
- Removal is `{proposalType: "remove", remove: {removed: leafIndex}}` in
  `createCommit`'s `extraProposals`, where the leaf index is the tree
  array index divided by two, found by matching the credential identity.

**Removes and adds go in separate commits.** Observed in Node,
2026-10-30, ts-mls 1.6.2:

- A combined add + remove commit works for every remaining member, but
  an add fills the lowest blank leaf, which is often the one just freed.
  The removed device then misreads its own state (see the ts-mls list
  above). So reconciliation commits removals first and additions in a
  second commit.
- As a second check, after any commit a client confirms the leaf at its
  own index still carries its own signature key; if not, it treats
  itself as removed. That catches the case whatever caused it.
- A member cannot remove itself ("Commit cannot contain a remove
  proposal removing committer"). A device that loses access is removed
  by another member's client, never by its own.
- Removing a blank or out-of-range leaf is refused ("Tried to remove
  empty leaf node"), so a stale leaf index fails loudly rather than
  removing the wrong device - provided the index is looked up in the
  same state the commit is built on.

**The own-leaf check is a signature probe.** ts-mls keeps only the
private signature key in group state and its `Signature` interface
cannot derive the public half, so the client signs 32 random bytes with
its private key and verifies them against the public key in the leaf at
its own index (`privatePath.leafIndex`). Proven in Node 2026-10-31: in a
combined remove + add commit the removed device reports `active` and its
leaf holds the newcomer, and the probe fails as it should.

**Spent commit keys are wiped only after the server accepts.**
`createCommit` returns `consumed` arrays to zero, but they are shared
with the state the commit was built on. A commit that loses the epoch
race is discarded and that same state processes the winner; if the keys
were already zeroed this fails with "Could not verify confirmation tag"
and the device is stuck. Found 2026-10-31 by a Node race test of
reconcile; the add path had the bug since step 9 but no real race had
hit it. `CommitResult.wipeSpent()` is called after the commit is
accepted and persisted. Application messages are not retried, so they
still wipe immediately.

**Group operations are serialised per channel.** Every operation reads
state, awaits, and writes new state, so a background reconcile
interleaved with a send would let one silently overwrite the other.
`Groups` queues open, catchUp, addMembers, reconcile, encrypt and
decrypt per channel; private helpers do not queue, so queued operations
can call them.

**External join and reset live in `groups.open`.** Built 2026-10-31.
Opening a channel tries, in order: stored state (catch up); no group
(create); a waiting welcome; the published GroupInfo (external join); and
when that is missing or older than the server's epoch, a reset. It does
not wait for an online member to add the device first: an external join
is announced and access-checked exactly like an add, needs no key
package, and a member's add that lands first simply wins the epoch race,
after which the next attempt takes the welcome. Voice uses the same
path, so a new device no longer needs someone in the call. Details:

- The GroupInfo carries the ratchet tree inside it
  (`createGroupInfoWithExternalPubAndRatchetTree`, about 430 bytes for
  one member, 300 more per member), so the joiner needs nothing else.
  Every commit uploads the one for the epoch it produces, in the same
  transaction as the epoch advance, so it is never stale while clients
  follow the protocol. A member that opens a group with no current one
  (created before this existed) uploads it with
  `PUT /channels/{id}/mls/group-info`, refused unless it names the
  current epoch.
- `mls_groups.generation` counts resets. The client puts it in the MLS
  group ID: the bare channel ID for generation 0 (every existing group),
  `<channel>#<n>` after that. Commits name it and the compare-and-swap
  checks it with the epoch, because epochs restart at 0 and a device
  still holding the old group could otherwise land a commit in the new
  one by matching the number. Catch-up names it too; the server answers
  410 if it moved, and the client throws `GroupReset` (a
  `RemovedFromGroup`), drops its state and rejoins.
- `POST /channels/{id}/mls/reset` carries the new group's GroupInfo, so
  the replacement is joinable the moment it exists. The server locks the
  row, refuses while a current GroupInfo exists or if the generation
  moved, then bumps the generation, zeroes the epoch, and deletes the
  handshake log and pending welcomes. It sends `group_advanced` (epoch 0)
  so connected devices find out.
- The joiner checks the GroupInfo's group ID is this channel's before
  committing; one for another group would put a commit no member can
  process into the log.
- Upgrade cost, once: the first device to open a group created before
  this, when no member of it has opened it since, resets it.
- Proven 2026-10-31 against the real server and Postgres with separate
  Node processes running client-core: external join with the only member
  idle; a demoted sole member replaced by an external join and removed
  by reconciliation; a pre-existing group given a GroupInfo by a member
  reopening; a reset, with both old members rejoining (one learning from
  catch-up, one from stored state); two simultaneous external joins; a
  stale-generation commit refused (409) and catch-up told 410.

**One browser database per account, one tab per account.** Found on
Docker 2026-10-31: two windows of one Brave profile signed in as
different accounts shared the single `openvoxa` IndexedDB, so they shared
one device identity slot and one copy of each group. Each sign-in wiped
the other's identity, and a window that loaded the other account's group
state removed its own real leaf as a "duplicate" and rejoined, 70 epochs
in a few minutes. Now each account has its own database
(`openvoxa-<user id>`); the old shared one is moved into its owner's on
first sign-in and deleted. Two tabs of the same account would share keys
just as badly, so a Web Lock lets one tab per account and browser hold
them; a second tab is refused with a message. And a client drops any
stored group whose own leaf is not its device, whatever put it there.

**Own echoes are paired by a ref, not by order.** The debug page paired
its own echoed messages with what it sent by queue order, so a send the
server refused ("slow down") left an orphan and every later own message
in that session was archived with the previous one's text. A send frame
now carries an optional client-chosen `ref` (up to 64 chars), echoed on
the resulting message and on an error about that frame; client-core
pairs by it. The debug page still sends none and is unaffected.

**MLS handshake bodies have their own size cap.** Every JSON body was
capped at 64 KB. An add commit carries the Welcome and the whole ratchet
tree (tagged JSON) once per added device, so it grows with the square of
the devices added at once; adding about ten devices to a new channel got
413 and nobody was added (found 2026-11-01 in the cloud test). Group
creation, commits, resets and GroupInfo uploads now allow 8 MB
(`maxMLSBody`). Sending the tree once per commit instead of per welcome
would make it linear; not needed at our scale yet.

**ts-mls tree validation is patched.** ts-mls (1.6.2 to at least 1.6.4)
checks unmerged leaves wrongly: for an unmerged leaf of a parent node it
demands that every non-blank node on the leaf's whole direct path carry
exactly the same unmerged list, where RFC 9420 7.9.1 only requires the
nodes between the leaf and that parent to list the leaf. A higher node
legitimately lists more (adds into its other subtree), so a group with two
adds into different subtrees and no path update in between refused every
new device ("non-blank intermediate node must list leaf node in its
unmerged_leaves"), by welcome or external join. Found 2026-11-01 when a
voice group had collected many devices in the cloud test.
`client-core/scripts/patch-ts-mls.mjs` fixes the check in node_modules,
idempotently, from `build.mjs` and client-web's build, and fails the build
if the code it expects is gone (re-check a new ts-mls before dropping it).

**LAN clients and a public node IP (no hairpin NAT).** With
`LIVEKIT_NODE_IP` set to the public IP for outside friends, a client on
the server's own LAN was offered only the public address and got no
audio unless the router hairpinned the traffic (it didn't on Ryan's
UniFi: LiveKit logged `requestsReceived: 0`). Fix (2026-11-01): LiveKit
runs with `network_mode: host` and `rtc.advertise_internal_ip: true`, so
it offers the host's own addresses (the LAN IP, plus Docker bridge
addresses nobody reaches) alongside the node IP. Verified in the cloud:
the browser received both a host candidate for the internal address and
one for the (unreachable) node IP, and audio flowed. Needs livekit-server
1.13.6+ (the option is ignored with an explicit node IP before
mediatransportutil f234b53), so the image is pinned to v1.13.11. Bridge
networking can't do this: the "internal" address would be the
container's. Caddy and the server reach LiveKit at
`host.docker.internal:7880` (`extra_hosts: host-gateway`).

**Old LiveKit servers hang publishing.** Against livekit-server 1.9.0 the
2.23 client connected but publishing timed out in negotiation; 1.10.1
works. Docker runs `livekit/livekit-server:latest`.

**Edits and the archive.** The archive is keyed by message id and MLS
keys are single-use, so an edited message needs a second decryption and
a way to know whether the archived text is the latest. An edit's
plaintext replaces the archived text and an `edit:<id>` entry in the same
store records the `edited_at` it belongs to (a plain string, so backups
carry it with no format change). On a history load, a matching mark means
the archive is current; otherwise the body is decrypted; if that fails the
older archived text is shown, labelled as not the newest version. The
editor cannot decrypt its own edit, so the plaintext is kept from the
PATCH until the `message_edited` echo or the response, whichever comes
first. A backup restore only takes an edit mark together with its text.

**Only a device removes its own duplicate leaves.** After rejoining from
a GroupInfo a device can hold two leaves. Another member cannot tell
which is live, and removing the wrong one would kick the device out, so
reconcile removes duplicates of its own device ID only.

## Permission groups

Build-order step 12, decided by Ryan 2026-10-31.

**Switches decide what you can do; rank decides whom you can do it to.**
A group carries permission switches (`perm.All`: administrator,
manage_groups, manage_channels, delete_messages, view_reports, ban,
force_ptt). An account holds the union of its groups' switches. Groups
are ranked by `position`, and an account's rank is its highest group's.
Rank grants nothing on its own: Member and Everyone carry no switches,
so an ordinary account cannot ban a guest whatever the order. Rank only
limits targets: a moderator with ban can ban members and guests, not
another moderator. Ryan's concern was keeping a clear line between
standard and power-user accounts; that line is "holds any switch", and
the account list is shown to anyone over it.

**Channels carry an allow-list, no deny rules.** Each channel lists the
groups that may view it and, of those, which may post (and speak, in
voice). Everyone on the list makes a channel public; an empty list
leaves it to administrators, who see every channel. Chosen over
Discord-style allow/deny overrides because there is never a precedence
question to answer.

**Groups stack.** A moderator is in Member and Moderator, so taking
Moderator away leaves an ordinary member, and a channel only needs its
lowest qualifying group on the list.

**Managing groups is bounded twice.** With manage_groups you may only
touch groups below your rank and accounts below your rank (never your
own), and only hand out, add or remove switches you hold yourself. So
manage_groups cannot mint an administrator, and a group manager without
ban cannot give ban away. For parity with the old roles you may put
someone in a group at your own position (an administrator can make
another administrator); neither can then undo the other.

**Everyone is built in.** Every account is implicitly in it (the
`effective_groups` view). Its permissions can be edited; its name,
position (0) and membership cannot. It replaced the guest role.

**The upgrade changed nothing visible.** Migration 0012 converted the
roles: Member (auto-assigned to new accounts), Moderator
(delete_messages, view_reports, ban, force_ptt), Administrator
(administrator). Channel minimums became allow-lists. `users.role` and
`channels.min_role_*` were dropped; `roles` and `role_changes` stay as
history, and `perm_group_changes` is the new audit log.

**Group-wide changes sweep instead of iterating accounts.** Editing or
deleting a group, or replacing a channel's allow-list, can move many
accounts at once. The server sends `perms_changed` with no user (every
client refetches `/me` and reconciles), re-checks every open socket,
and asks LiveKit who is in each voice room (`ListParticipants`) rather
than checking every account against every room. A change to one
account's groups uses the per-account path, as a role change did.

**Clients keep an event socket.** `GET /ws` with no channel is a
socket for server-wide events only (perms_changed, channel_changed,
access_changed, channel_deleted, user_purged). Found on Docker
2026-10-31: losing a group closed staff's only socket, so the re-add
never arrived and the channel list stayed stale until a reload. The
debug client opens one at sign-in and reconnects it; channel sockets
skip those event types while it is up.

### There is always an administrator

Decided with Ryan 2026-11-01, instead of a built-in "root" account with
a long password (one internet-facing login with total power is a
password-guessing and phishing target, and a shared secret nobody can be
held to). The Linux model is copied instead: root needs the machine.

- **Two-administrator floor** (`lastadmin.go`, `adminGuard`,
  `MinAdmins = 2`; raised from one the same day at Ryan's request): one is
  not enough, because whoever takes over an administrator account could
  remove the others and be the sole controller. Any transaction that can
  take the switch from someone (deleting an account, either way; editing
  or deleting a group; removing a group member; a ban, since banned
  administrators don't count) locks, counts active administrators
  (holding the switch through any group, not deleted, not banned) before
  and after, and is refused with 409 if the count drops AND ends below
  two. A server already under two (new, or older than this rule) is not
  frozen, only kept from dropping further; startup and `list-admins` warn.
  With exactly two, neither can leave until a third is added. The floor
  limits what a rogue administrator can remove; it does not stop other
  damage they can do with the switch, and same-rank administrators
  already cannot remove each other.
- **Host recovery** (`cli.go`): `docker compose exec server
  /openvoxa-server grant-admin <username>` puts the account in the
  top-positioned group with the switch, creating one above all others if
  needed, and writes the audit log (actor NULL, "server command line").
  `list-admins` shows who holds it; `list-users` lists every account
  (groups, banned, created, last seen); `delete-user <name>...` deletes
  like self-deletion (shared `PurgeUserTx`), one transaction per name,
  keeping the two-admin floor unless `--force`. A deleted user's already
  open socket stays until it reconnects (the CLI can't reach the hub).
  Nothing is reachable over the network.
- **Setup code**: an empty server (no rows in `users`) is no longer
  claimed by whoever registers first. A random code is printed in the
  server log at startup (and again on a refused attempt) and the first
  registration must carry it (`setup_code`); `GET /api/v1/setup` tells the
  sign-up form to ask. The code changes on every restart.

### Password rules

Decided with Ryan 2026-11-01: 12 to 256 characters using at least three
of the four kinds: upper-case letter, lower-case letter, number, symbol
(anything not a letter, digit or space). First all four; relaxed to 3 of
4 the same day as a middle ground. Checked when a password is set
(registration, `PUT /api/v1/me/password`), never at login, so older
accounts still sign in.

Hardened the same day (Ryan: `Password12345` passes 3-of-4 but anyone
guessing puts the capital first). Also refused: passwords containing the
username; common passwords, including dressed-up ones (lower-cased,
look-alikes like @/0/$ undone, digits and symbols stripped off both ends,
so `Password12345`, `P@ssw0rd!2024`, `Sunshine2025!` all match); and
passwords more than half made of runs of 3+ with the same predictable step
(aaa, abc, 321, qwerty). The list is the UK NCSC top 100,000 (from HIBP
breach data, via SecLists, MIT; `common-passwords.LICENSE`), gzipped and
embedded (~430 KB), loaded on first use (~0.2 s): nothing is sent to a
third party. On 20,000 random 12-character passwords that pass the kind
rule, under 10 are refused. Code: `server/internal/password` (`Problem`);
client-web `password.ts` mirrors everything but the list for the live
checklist. Changing the password
needs the current one, uses the login rate limit, signs out every other
session and closes all sockets. There is no forgotten-password reset (no
email by design); a host command would be the natural path if wanted.
Composition rules are not what NIST SP 800-63B recommends (it favours
length plus a breached-password list). Ryan's reasoning, from years in
IT: without them users pick `password1234` and, after a breach, reset to
`password2345`; the rules force a rethink. The sign-up form shows the
checklist live, and "Passwords don't match." under the confirm field once
the password itself passes.

### Palette

client-web default (Ryan, 2026-11-01): background #333333, buttons
#D96932, text #FFFFFF; derived shades are `styles.css` variables. Light
mode later: same orange, black text instead of white. Users will be able
to pick their own colours later, so every colour stays a variable.

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
11. ✅ Automatic group membership from channel access: member
    reconciliation, join and leave notices, then external join.
    Built against the current roles.
   - ✅ ts-mls external commit and removal behaviour proven in Node
   - ✅ Server: one access rule (`access.go`), allowed-devices endpoint,
     welcome recipients checked, key package claims scoped to a channel.
     Verified on Docker 2026-10-31 (ryan + staff, admin-only channel):
     allowed list correct, staff refused the list, claim for staff
     refused, claim without channel refused, commit with a welcome to
     staff refused, existing channel and "Add everyone" unaffected
   - 🔶 Client: `groups.reconcile(channelId)` built (removals commit,
     then additions commit, own-leaf check after every commit, removed
     device discards its state and rejoins from a welcome). Passed a Node
     run against a fake server incl. a real epoch race, 2026-10-31.
     Verified on Docker 2026-10-31 (ryan + staff, `mods-only-test`, staff
     toggled user/moderator): nothing added without access; staff added
     (epoch 1), removed (2), re-added (3) while offline; staff then joined
     from the newest welcome at epoch 3 and messages flowed both ways
   - ✅ Triggers (`reconcileSoon`, `access_changed`, demotion closes
     lost sockets, chat.html handles `RemovedFromGroup` and joins on
     `group_advanced` while waiting). Verified on Docker 2026-10-31
     (ryan + staff, `mods-only-test`): demote closed staff's socket and
     ryan removed it automatically (epoch 4); promote re-added it (5);
     staff revoking its own device while connected showed the removal as
     a normal event and ryan removed it (6); the new device was added
     automatically after publishing key packages (7). One commit per
     change, both sides in sync, messages both ways
   - ✅ Join/leave notices (`groups.onMembership`,
     `GET /channels/{id}/mls/device-names`). Verified on Docker
     2026-10-31 (ryan + staff + an incognito ryan device): removal and
     re-add named on the committer (epochs 8, 9); staff added the new
     device (10) and removed it after revocation, marked revoked (11);
     ryan's main device, offline throughout, announced both on
     reconnecting, credited to staff
   - ✅ "Add everyone" buttons and public `groups.addMembers` removed
     (2026-10-31)
   - ✅ External join and stuck-group reset. Verified on Docker
     2026-10-31 (ryan + staff): a new staff device joined an empty voice
     call from the group info; with staff demoted as the only member,
     ryan joined `stuck-test` from the group info and removed staff
     automatically; with the group info deleted, staff replaced
     `ext-test` (generation 2), ryan, connected throughout, saw
     "replaced; rejoining" and joined on his own; a device returning with
     the previous group's state rejoined and said so; messages both ways
   - ✅ "Forget this device" revokes it on the server first. Before, the
     device stayed active and members kept re-adding a device nobody held
     keys for (found in the step 8 test; old ones revoked by hand)
12. ✅ Custom permission groups replacing the fixed roles (migration
    0012, `groups.go`, `perm`). Verified on Docker 2026-10-31 (ryan,
    staff, tester): upgrade kept every account's access; new group +
    encrypted channel; removal and re-add while connected (one commit
    each, no reload, after adding the event socket); losing access mid
    call removed staff via the LiveKit sweep; a ban-only group at rank 12
    could act on a Member but not on staff, and could not hand out
    groups. Found on the way: retiring old voice keys switched every
    device onto junk keys 10 s after a key change (fixed `efc38c6`)
13. ⬜ The real client: `client-web`, `client-desktop`
    Decided with Ryan 2026-10-31:
    - `client-web` is Vite + React + TypeScript with plain hand-written CSS
      (dark, Discord-like). The Go binary embeds the build (`webui/`,
      `webui.go`) and serves it at `/` as a single-page app; chat.html stays
      at `/debug/`. Same origin keeps the LiveKit E2EE worker working and
      lets the new client read the IndexedDB the debug page wrote.
      `client-desktop` (Electron) later loads the same bundle.
    - Order: M1 signup/login + recovery key, M2 text (history paging),
      M3 voice/screen share, M4 attachments/GIFs/unfurls/notices,
      M5 settings and admin panes.
    - Recovery key v1 = history backup only: generated at signup, shown
      once (words/characters AND a QR code), confirmed by retyping part
      of it; it encrypts an uploaded backup of the local plaintext
      archive (server stores opaque chunks). Existing accounts are asked
      once. Local IndexedDB encryption reuses it later.
    - Backup storage (server, migration 0015): one backup per account, a
      small opaque header (format, KDF salt, key check) plus named opaque
      chunks. Chunk names are client-chosen so the server does not learn
      which channel a chunk covers. Starting a backup replaces the header,
      drops all chunks and issues a new backup id; uploads carry that id
      and get 409 if it is stale, so chunks sealed under two keys never
      mix. Limits: 4 MB per chunk, 1000 chunks, 256 MB per account.
    - Recovery key and backup format (client-core `recovery.ts`): 128
      random bits as 12 BIP-39 words (checksum catches typos; first four
      letters of each word suffice) or a QR payload `OVRK1:<hex>`. The key
      is random, not a password, so HKDF-SHA256 with a per-backup salt is
      enough (no Argon2). Header holds format, salt and a key-check value
      so a wrong key reads as wrong, not as damage. Each upload writes a
      whole new generation `<gen>-<n>` then deletes the old one, so an
      interrupted upload leaves one complete copy. Chunks are gzip'd JSON
      under AES-256-GCM with the backup id and chunk name as additional
      data. Restore only adds entries the device lacks. The derived key
      (not the words) is kept on the device as a non-extractable
      CryptoKey for later uploads; another device starting a new backup
      locks the others until they enter the new key.
    - Recovery screens (client-web, M1 part 4; decided with Ryan
      2026-11-01): signup shows the 12 words and a QR, then asks for 3
      random words (first four letters suffice, as in parse) before
      `Backup.create`; no "Not now" at signup. An older account without a
      backup is asked once per browser (remembered in localStorage). A
      backup this device cannot use (never unlocked here, or replaced by
      another device) gets the restore screen: restore merges and
      remembers the key; "Skip for now" lasts the session; "I lost my key"
      starts a new backup after a warning. Upload policy: always before
      sign-out, and about a minute after the latest new message
      (`BackupManager.scheduleUpload`, debounced; called by the chat view
      from M2). QR scanning by camera is not
      built; the `OVRK1:` text can be pasted. client-web imports
      client-core as source (`@core/*` in tsconfig, `resolve.tsconfigPaths`
      in Vite); the Dockerfile puts the client stage's tree beside it.
    - Text in client-web (M2; scope decided with Ryan 2026-11-01):
      Discord-like layout (channel sidebar with text and voice channels,
      voice inert until M3; message pane; composer; user panel with
      backup status and Log out). M2 is core text (send/receive in plain
      and encrypted channels, history paging, archive plus
      `scheduleUpload` per archived message) plus editing and deleting
      your own messages and unread markers. Attachments, GIFs, unfurls
      and join/leave notices stay M4 (a message with attachments says so
      and points at the debug page).
    - client-web owns the device from M2: it runs `startSession`, so the
      debug page in another tab of the same account gets the "already
      open in another tab" refusal (Web Lock). Sign-out originally
      revoked the device and wiped the local database, so every sign-in
      after it needed the recovery key. Replaced 2026-11-03: sign-out
      keeps the device (Encryption, "Local storage is encrypted under
      the password", sign-out bullet).
    - Chat logic lives in client-core `chat.ts` (`Chat` per account:
      event socket, channel list, unread; `ChannelView` per open channel:
      socket, decrypt/archive queue, paging, send/edit/delete), so the
      desktop client reuses it. client-web only draws snapshots.
    - History paging: the websocket still sends the newest 50 on connect,
      now with `has_more`; older pages come from `GET
      /channels/{id}/messages?before=<message id>&limit=` (max 100),
      walking (created_at, id) backwards (index from migration 0016).
    - Edits: `PATCH /messages/{id}` `{body}`, author only, while they may
      still post, never a deleted message; the body is replaced in place
      (no server-side edit history) and `edited_at` set; event
      `message_edited` carries the new body. In an encrypted channel the
      new body is a fresh MLS ciphertext of an envelope that keeps the
      old file keys (or the attachments would become unreadable).
      Moderators delete; they do not edit others' words.
    - Unread: `GET /channels` gives `last_message_at`; a new message
      sends `channel_activity` (channel, message id, author, time, no
      content) to the connected accounts that may view the channel and to
      nobody else, since that a hidden channel is busy is itself a leak.
      The client keeps the last-read time per channel in localStorage; a
      channel seen for the first time counts as read.
    - Channel management in client-web (moved forward from M5 at Ryan's
      request 2026-11-01): accounts with manage_channels get a "+" beside
      the Text and Voice headings (create dialog: type, name, encryption
      for text, allow-list pre-filled with the server default) and a gear
      on each channel (allow-list, retention, history sharing for
      encrypted text, delete with a second confirmation). force_ptt
      holders get the gear on voice channels for "Require push-to-talk".
      Name and encryption stay fixed after creation (no rename on the
      server; flipping encryption would strand history or break the
      promise to people who wrote it). Voice is always encrypted, so the
      dialog offers no switch for it. Permissions refresh on
      perms_changed.
    - Voice and screen share in client-web (M3; decided with Ryan
      2026-11-01): Discord-like. Clicking a voice channel joins its call;
      the people in each call are listed under the channel (live for
      your own call: speaking ring, mic off, LIVE when sharing; the
      server's list for the others). A voice bar above the user panel has
      mute, deafen, share screen, voice settings and leave. Screen shares
      open in a stage in the main pane (grid, click to focus, fullscreen,
      optional stats), "Back to chat" returns. Also in M3: mic and
      speaker pickers, per-person volume and "mute for me" (right-click a
      person; this device only), deafen, a push-to-talk key binding
      (default the backquote key; a page only sees keys while focused, so
      character keys are ignored while typing; the desktop app adds a
      global key later). Share options: the debug page's presets,
      detail/motion, audio, and under Advanced codec and simulcast; "pin
      max quality" is a voice setting.
    - Voice logic is client-core `voice.ts` (`VoiceClient`), the debug
      page's code moved over (media key ring, `overwriteSlot`, PTT,
      share encodings). It imports LiveKit, so it is not in client-core's
      index: client-web loads it on first join (LiveKit is ~500 KB). The
      E2EE worker is built by Vite from client-core's own livekit-client
      copy (`voiceWorker.ts` imports it by relative path) so it is always
      the library's exact build; nothing points at `/debug/`, which is off
      in production.
    - Who is in each call: `GET /voice/participants` asks LiveKit
      (`ListParticipants`) for the voice channels the caller may view,
      cached 2 s, names from our database. There are no LiveKit webhooks:
      a client that joins or leaves posts `POST /channels/{id}/voice/
      changed`, and the server sends `voice_changed` to the channel's
      viewers only (as `channel_activity`), who ask again; kicks send it
      too. Clients also poll every 20 s for people who vanish silently.
    - Chat extras in client-web (M4 session A, 2026-11-01): Markdown
      (`markdown.tsx`: bold, italic, strike, inline and fenced code,
      "> " quotes, links; built as React elements, never HTML strings,
      same subset as the debug page). Link previews (`previews.tsx`) for
      the first link in a message, via `POST /unfurl`, one request per
      link per page load; YouTube is click-to-load (youtube-nocookie).
      The server asks YouTube's oEmbed endpoint for YouTube links
      (`unfurl.fetchYouTube`): scraping watch pages failed on Docker
      (huge pages, consent redirects). A YouTube link always gets its
      click-to-play box, even when no card could be fetched or previews
      are off (it contacts nobody until clicked). The player iframe sends
      `Referer` as our origin only (`strict-origin`): with no referrer at
      all YouTube shows "Error 153" and won't play.
      In encrypted channels previews are off unless the user opts in
      (Settings, "Link previews in encrypted channels", per browser):
      Ryan chose opt-in over never or always, since the server learns
      the link and preview images load from the linked site; the setting
      says so. GIF picker (`gifs.tsx`): the GIF button appears when
      `GET /gifs/config` says enabled; trending on open, search as you
      type (400 ms pause), picking one sends it at once as its own
      message (`ChannelView.send(text, attachments)`, text may be empty
      with an attachment). Plain attachments (any in plain channels,
      GIFs in any) show inline from their signed URL; sender-encrypted
      files were a placeholder until session B (below). Join/leave notices: Chat
      forwards `groups.onMembership` people changes for the open
      encrypted channel; `ChannelSnapshot.notices` are now
      `{id, at, text, kind}` and sit among messages by time. Voice
      join/leave tones (`tones.ts`): two WebAudio notes, rising for a
      join and falling for a leave, for you connecting/leaving and others
      in your call; people already there when you connect are not
      announced (2 s settle). On by default, "Join and leave sounds" in
      Settings. The user-panel gear and the voice-bar cog open one
      Settings dialog (Voice and Chat sections). Mic button is
      highlighted when deafened too.
    - Attachment upload in client-web (M4 session B, built and verified
      on Docker 2026-11-03): "+" button (file picker, several at
      once), pasting files or screenshots into the message box, and
      dropping files anywhere on the channel. Each file uploads the moment
      it's added (`ChannelView.upload`, which encrypts first in an
      encrypted channel) into a tray above the composer with thumbnails
      and a remove button; Send waits for uploads to finish and leaves
      failed ones out. At most 10 per message (the server's cap); each
      encrypted file's key and name (cut to 120 characters) ride in the
      message and count toward its 4,000-character limit, so the error
      says to send fewer files. `ChannelView.send` takes `Upload`s
      alongside plain `AttachmentInfo` and puts their keys in the
      envelope. Showing (`attachments.tsx`): encrypted images decrypt on
      sight; encrypted video/audio up to 10 MB too, bigger ones behind a
      "Load" button, because GCM can't stream into a player; other files
      decrypt on click and save through `download=`, never opening. The
      blob's type comes from the inline allowlist, never the sender
      (stored-XSS on our origin otherwise). Decrypted copies are shared
      per attachment and freed a minute after nothing shows them.
      Switching channel drops the tray; the server sweeps unclaimed
      uploads after an hour. The upload `ApiCall` must leave
      Content-Type alone for FormData (client-web `core.ts` does).
      Clicking an image opens an in-page viewer (name, "Open in new tab",
      "Download", Esc or a click outside closes); Settings, "Open images
      in a new tab", switches to tabs (per browser, off by default; Ryan
      asked for the choice after A1). Ctrl/middle-click always opens a tab.
    - Account settings in client-web (M5 session A, 2026-11-03; M5 split
      into A account, B groups and members, C moderation, at Ryan's pick).
      Settings is one dialog with Account, Voice and Chat tabs
      (`SettingsDialog.tsx`); the user-panel gear opens Account without
      loading LiveKit, the voice-bar cog opens Voice. Account: username and
      groups; change password (current + new with the signup checklist;
      the server signs out every other session and says how many); the
      recovery key (status, Back up now, Set up / Enter key, and "Make a
      new key" for a working key, which re-uploads this browser's history
      under the new key, so nothing is lost: `RecoverySetup rotating`);
      devices (`GET /devices`, this browser first and not removable here,
      since Log out does that with a backup first; removing another one
      revokes it and members take it out of encrypted channels); delete
      account (type the username and the password, `DELETE /me`; the
      server deletes first, then this browser's keys are wiped, so a
      refusal such as the two-admin floor leaves everything intact).
      Calls that check a password use api.ts `call`, not the ApiCall
      that signs out on any 401, because a 401 there means a wrong
      password.
    - Groups and members in client-web (M5 session B, 2026-11-03).
      A separate Server settings dialog (`ServerSettings.tsx`), not more
      tabs in Settings, so personal and server settings stay apart and
      session C adds its moderation tabs there. The gear beside the server
      name shows for staff (any switch); changing anything needs
      manage_groups. Rank is edited as a number (Ryan's pick over up/down
      arrows: it matches the server, allows ties, one save per change),
      with a hint naming the groups either side. The dialog mirrors the
      server's rules (rank strictly below yours, only switches you hold,
      not your own groups) as disabled controls with a reason; PATCH
      sends only changed fields, since an untouched switch list on a
      group holding a switch you lack would be refused. Membership
      changes save on each tick. Lists reload on perms_changed.
    - Moderation in client-web (M5 session C, 2026-11-03). Report on
      other people's messages (`ChannelPane.tsx` ReportDialog; sends the
      text as shown, and in an encrypted channel says so, since that
      reveals it to the server and it stays unchecked). Server settings
      gains Reports (needs view_reports: Open/Actioned/Dismissed/Rejected,
      Checked/Didn't match/Unchecked tag, Delete message, Ban author,
      Dismiss, Mark actioned; deleting and banning stay separate calls
      from closing a report), Bans (needs ban; Unban), and Log (Ban, View
      reports or Delete messages). Members rows get Ban/Unban and, for
      administrators, Delete (type the username). Ban durations are
      presets (1 hour, 1/7/30 days, permanent; Ryan's pick); purge is
      administrator only. Server: `GET /users` adds `banned` and
      `banned_until`, reports add channel name and `message_gone`, admin
      deletions now write `delete_user` to `moderation_log` (the username
      in detail, since the row is gone), `GET /moderation-log`
      (`modlog.go`, `?before=` paging, `?archived=1`).
      Pending reports: a red dot on the Server settings gear for holders
      of view_reports (Ryan asked for one). `reports_changed` goes only to
      them (emitUsers) when a report is filed or resolved; the client
      refetches the open list, also every 2 minutes and on focus as a
      fallback; the dialog opens on Reports while any are open.
      Log archive: entries older than `server_settings.modlog_archive_days`
      (migration 0017, one-row typed table for server-wide settings,
      default 30, 1 to 3650, administrator sets it in the Log tab) show
      under Archived. A view only; nothing is deleted.
    - @mentions (2026-11-03, after M5; see Feature decisions, "Mentions
      are metadata the server sees"). Server: migration 0018
      `message_mentions`, `mentions.go` (filter by viewer rule, `mention`
      event via emitUsers to the mentioned only, `GET /channels/{id}/
      members` for autocomplete), `mentions` on message frames and
      history, `last_mention_at` per channel in the list. An edit
      replaces the set and notifies only the newly added. Core:
      `findMentions` (code skipped, exact username match first, then a
      unique case-insensitive one), `ChatMessage.mentions`/`mentionsMe`,
      `Chat.mentions` (channels with an unread mention, compared with the
      read mark like unread) and a `mentioned` event. Web: `@` list in the
      composer and the edit box, pills (stronger for you), highlighted
      rows, a red `@` badge in the sidebar, a mention tone and opt-in
      desktop notifications (who and where only, never the text) in
      Settings > Chat. Not built: `@everyone`/`@group`, mention counts,
      notifications while the app is closed.
    - Device linking by QR (after M1): a logged-in device shows a QR of
      `https://server/link#<one-time secret>` (about 2 min, single use);
      the phone's camera opens it; the server only relays encrypted
      messages; the old device approves the login and hands over the
      backup key. The typed recovery key is the fallback.
    - 2FA: TOTP only (authenticator apps, RFC 6238) plus one-time backup
      codes. No SMS, email or third-party service. After device linking.

14. **Crypto-shredding** (design agreed with Ryan 2026-11-03; see
    Encryption, "Account deletion is crypto-shredding"). One commit per
    step, each tested on Docker:
    - [x] S1 Key folder (`OPENVOXA_KEY_DIR`, own volume, created by the
          server) and sealing of new plaintext message bodies and edits;
          readers unseal. Migration adds `messages.sealed`. Done
          2026-11-03: `internal/keystore` (file per account, created on
          first seal via temp file + link, cached; unit tests),
          `httpapi/sealing.go` (AES-256-GCM, format byte 0x01, channel and
          author as associated data; an unopenable body is delivered
          empty), migration 0020, compose volume `key-data`. Verified on
          Docker: send, file-only send, edit, reload.
    - [x] S2 Seal existing plaintext bodies and report copies during the
          upgrade; seal new report copies. Done 2026-11-03: migration 0021
          (`reports.claimed_body` to BYTEA, `claimed_sealed`; blanks report
          copies and message bodies whose author is already deleted, which
          account deletion had left behind in reports), `SealExisting` in
          `sealing.go` runs in the background at startup (batches of 500,
          guarded UPDATEs so a concurrent edit or delete wins). Report
          copies are sealed under the accused's key in every channel kind.
          Verified on Docker: 17 messages and 4 reports sealed, old
          history, old reports and a new Checked report all read.
    - [x] S3 Plaintext-channel attachments sealed under the uploader's
          key (bytes and filename), no more dedup there; existing blobs
          converted. Done 2026-11-03: `internal/sealedfile` (random key
          per file, 64 KiB AES-GCM chunks, nonce = chunk index + last
          flag, so range requests and video seeking work; tests cover
          truncation and tampering), `httpapi/attachseal.go` (file key and
          name sealed under the uploader's key, bound to channel, uploader
          and blob hash; `storeAttachment` shared by uploads and GIFs;
          download decrypts on the fly, 410 once the key is gone),
          migration 0022 (`file_key`, `sealed_name`; drops leftover files
          of already-deleted accounts). GIFs in plaintext channels are
          sealed too (one rule; old ones cannot be told from uploaded
          .gif files). Verified on Docker: 4 existing files converted,
          old and new files, video seeking, GIF, size limit.
    - [x] S4 Deletion destroys the key file and removes the account's
          attachments; reports show "content deleted". Done 2026-11-03:
          `keystore.Destroy` (unlink + folder fsync, drops the cached
          key, and refuses to re-create a key for that account in the
          same process, so a send racing the deletion cannot revive it).
          Called only after the purge commits, in `purgeUser` and the
          `delete-user` host command (which opens the key store itself);
          a failure is logged / printed with the file to remove by hand,
          not rolled back. `PurgeUserTx` now also deletes the account's
          attachments (on its messages, and unsent uploads) and blanks
          report copies of its words; the report list has
          `content_deleted`. Rejected: a startup sweep of key files with
          no account, since a server pointed at the wrong database would
          destroy every key. Verified on Docker: two accounts deleted,
          files and report text gone, no leftover key files.
    - [x] S5 Delete-account dialog with the new wording (password and
          typed username); other clients delete stored copies of a
          deleted account's messages on `user_purged`. Done 2026-11-03:
          the typed username and password already existed (M5 A); the
          paragraph is now the agreed one. The archive is keyed by
          message id alone and an offline device never sees
          `user_purged`, so the client asks instead:
          `POST /messages/archive-check` (up to 500 ids, answers which
          are deleted or no longer exist; `archivecheck.go`).
          `Chat.pruneArchive` runs at every start (which also covers a
          backup restore, since the chat restarts after one) and 2 s
          after `user_purged`, deletes the gone copies, then schedules a
          backup upload so the server-held backup drops them too. It
          also catches single deletes, retention and deleted channels.
          Verified on Docker: check at start and 2 s after a deletion,
          each followed by a backup re-upload.
    - [ ] S6 `deploy/README.md`: key folder, separate short-lived
          backups, what losing it means.

## Open items

- [ ] Emoji (Ryan, 2026-11-03). A picker in the composer, plus `:name:`
      shortcodes. Unicode emoji are just text, so they work in encrypted
      channels unchanged. To settle before building: bundle the emoji
      data and images ourselves (no CDN, same reason as LiveKit) or use
      the system font; whether reactions on messages come with it.
- [ ] Custom stickers (Ryan, 2026-11-03): images uploaded to the server
      and sent like a GIF. Decided with Ryan:
      - Server-wide: one set for the whole server, not per channel.
      - Moderators and administrators only. Done as a new permission
        (`manage_stickers`) given to the Moderator and Administrator
        groups by default, not a check on group names, so it follows the
        permission-group system like everything else.
      - Stickers stay when their uploader deletes their account. They
        are a contribution to the server, not the uploader's own
        content, so they are not sealed under the uploader's key and
        are not crypto-shredded; the uploader reference just becomes
        NULL. The upload dialog says so before the first upload.
      Proposed, not yet agreed (Ryan wants recommendations):
      - Types: PNG, APNG, GIF, WebP (static or animated). Not SVG: it can
        carry script. The server checks the file's real type from its
        bytes, not the name or what the browser claims.
      - At most 512 KB per file and 320 x 320 pixels; shown at about
        160 px. Small enough that a message full of stickers loads fast.
      - At most 100 stickers per server, both limits in server settings
        so an operator can raise them.
      - Name per sticker (for search and `:name:` style picking) and
        alt text for screen readers.
      Rejected (Ryan, 2026-11-03): personal stickers that travel with
      the user across servers. Without federation they could only be
      client-side images re-uploaded per server, and anyone could post
      anything as a "sticker" with no approval step: a moderation
      burden. Server stickers, chosen by staff, only.
      In encrypted channels the message carries only the sticker's id,
      inside the ciphertext; fetching the image still tells the server
      who viewed which sticker, as with GIFs.
- [ ] Server browser (Ryan, 2026-11-03, "if this takes off"): a column
      on the left of the window to switch between OpenVoxa servers. Fits
      "no federation in v1": each server is still an island with its own
      account and device keys, and the client just keeps several sign-ins
      side by side. Worth keeping in mind now so per-server state in
      client-core (storage, keys, settings) is keyed by server, not
      global.

- [ ] Password strength estimation with zxcvbn (server and client), on top
      of the rules. Ryan asked to discuss later (2026-11-01).

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
- [x] Role demotion does not reach a live websocket. Fixed 2026-10-31:
      sockets to channels the account can no longer view are closed.
      A promotion still leaves an open read-only socket read-only until
      it reconnects (`can_post` is fixed at upgrade).
- [x] Nothing reads `moderation_log` yet. Done 2026-11-03 (M5 session
      C): `GET /moderation-log` and the Log tab in Server settings. Group
      changes still go to `perm_group_changes`, which nothing reads.
- [ ] Reports in encrypted channels will need MLS signature verification
      before `verified` can be anything but NULL there.
- [x] Group state persists to IndexedDB as bytes, but UNENCRYPTED. The
      protection today is browser origin isolation; anyone able to read
      browser profile data on the device can read the keys. The fix needs
      recovery keys to exist first, since encrypting with a key also
      stored in IndexedDB would look like protection while providing
      none. Done 2026-11-03: Encryption, "Local storage is encrypted
      under the password, with a server-held half for refreshes".
- [ ] The `ratchet_tree` column in migration 0010 assumes the tree
      travels separately from the welcome. If the extension route is ever
      made to work, both that column and the custom serialiser go away.
- [x] Recovery keys do not exist. Without one, a forgotten password means
      permanently unreadable history, because the server holds only
      ciphertext. The key has to be generated at signup and shown once.
      Done in step 13 M1 (`client-core/src/recovery.ts`).
- [x] Removing a revoked device from the groups it belongs to is
      client-side work. Done: reconciliation removes it (step 11).
- [x] Inactive devices expire after 30 days. Decided by Ryan, 2026-10-31.
      Done 2026-10-31: `touchDevice` updates `last_seen_at` (at most once a
      minute) on the key package count/publish and every MLS call that
      checks `ownDevice`; `db.StartDeviceExpirySweep` revokes idle devices
      hourly and at startup, deletes their unclaimed packages and sends
      `access_changed`; migration 0013 restarts every active device's
      clock, since nothing had maintained it. The count check returns 410
      for a revoked device, and `Identity.start` then wipes local storage
      (the device's keys and its local plaintext archive) and registers a
      new one. Original plan, kept for the record: A device whose keys are gone
      (a closed private window, a wiped browser) stays active forever, and
      members keep adding it and spending its key packages, last resort
      included. Plan: update `devices.last_seen_at` on group activity and
      key package publishing (nothing updates it today), revoke devices
      idle 30 days in the existing sweep (revoking already makes members
      remove them), and have a client that finds itself revoked register
      a new device and rejoin. Same idea as Signal unlinking idle devices.
      Until then: use "Forget this device" before closing a private
      window.
- [x] Attachments in PLAINTEXT channels are still content-addressed and
      deduplicated across users, which reveals that someone else uploaded
      an identical file. Accepted there; encrypted channels no longer
      dedup.
      Closed 2026-11-03 by crypto-shredding S3: every plaintext-channel
      file has its own key, so nothing is shared.
- [ ] Encrypted attachment sizes are visible to the server. Padding to
      size buckets would blur them at some storage cost.
- [ ] The local plaintext archive is deleted per message on deletion
      events, but a message removed by retention while not on screen
      stays in IndexedDB. Needs timestamps stored with entries and a
      sweep against the channel's retention.
- [ ] Link previews in encrypted channels: would need to be generated by
      the sender's client and carried inside the message, as Signal does.
- [x] Opt-in history sharing for encrypted channels: built 2026-11-01, see
      Encryption, "History sharing is opt-in per channel". Original note: An
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
- [x] The commit endpoint checks that each welcome's recipient device
      belongs to an account with access to the channel (step 11, server
      side). The whole commit is refused if one does not.
- [x] A new device can only join a call while someone already in that
      voice group is in the call, and can only join an encrypted text
      channel once a member comes online. External join (step 11, last
      part) closes both.
      Done: built and verified on Docker 2026-10-31.
- [ ] LiveKit's `encryption` option also turns on data channel
      encryption. Nothing uses data channels yet; anything that does
      later gets it for free, but must not assume the SFU can read them.
- [ ] Unfurl endpoint is a deliberate SSRF surface. Worth naming in
      SECURITY.md so reviewers look at it first.
