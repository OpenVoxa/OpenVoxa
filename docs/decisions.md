# OpenVoxa — Design Decisions

Why things are the way they are, including the tradeoffs taken on purpose.
Read this before proposing architectural changes; most of the obvious
questions already have recorded answers.

How it is laid out: **Goals**, **Threat model**, **Blocking decisions**
and **Architecture** are the fixed frame. **Feature decisions** has one
subsection per feature, grouped (text and chat, voice and screen share,
accounts and administration, desktop app, planned). **Permission
groups** and **Encryption** are the two designs everything else leans
on. **Known tensions** are tradeoffs without a clean answer.
**Implementation notes** are hard-won gotchas, grouped by area (MLS,
LiveKit, Electron, server, web client, builds): read the relevant group
before touching that code. **Build order** says what was built when,
with test IDs. **Open items** is the backlog.

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

The README carries the long version. Stating the limits is the point.

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

## Architecture

Five components, three of them off the shelf:

```
Desktop (Electron) ─┐                      ┌─ LiveKit SFU
                    ├─ WebSocket + REST ──▶├─ (relays encrypted media)
Web (React) ────────┘                      │
                              │            │
                    OpenVoxa server (Go) ──┘ mints JWTs, calls admin API
                              │
              Postgres + blob directory + account key folder
```

The server does auth, channel and permission state, message relay and
storage, MLS message routing (forwarding opaque blobs it cannot read),
retention enforcement, LiveKit token minting and room administration
(kicks, permission changes), link unfurling and file metadata. It never
decrypts anything in an encrypted channel and never sits in the media
path.

The server acts as an MLS delivery service: it forwards handshake and
application messages without understanding them, since all group key
agreement happens on clients. It therefore needs no MLS implementation.

| Layer | Choice |
| --- | --- |
| Server | Go, one binary with the web client embedded |
| Database | PostgreSQL |
| Client core | TypeScript (`client-core`), protocol and crypto, no UI |
| Web client | Vite + React + TypeScript, plain hand-written CSS |
| Desktop shell | Electron; each server's own web client in its own view |
| Media | LiveKit, self-hosted, pinned exactly |
| Reverse proxy | Caddy, optional |
| Group encryption | MLS (RFC 9420) via ts-mls, behind an `MlsProvider` interface |

Repo layout:

```
/server          Go: HTTP + WebSocket, Postgres, LiveKit tokens and admin calls,
                 embedded web client (webui/), host commands (cli.go)
/client-core     TypeScript: protocol, MLS glue, chat and voice logic, storage
/client-web      React web client, served by the server at /
/client-desktop  Electron shell, server pane, Windows audio helper (Rust)
/deploy          docker-compose, Caddy configs, LiveKit config, scripts
/docs            this file
```

The `client-core` split is non-negotiable: protocol, crypto, chat and
voice logic live there, and client-web only draws snapshots of it.

**How the web client is served** (decided with Ryan 2026-10-31, step
13). The Go binary embeds the client-web build (`webui/`, `webui.go`)
and serves it at `/` as a single-page app. Same origin keeps the LiveKit
E2EE worker working (browsers refuse cross-origin workers). client-web
imports client-core as source (`@core/*` in tsconfig,
`resolve.tsconfigPaths` in Vite); the Dockerfile builds client-core,
then client-web, then Go. The desktop app does not bundle the client: it
loads each server's own (see "Server browser and desktop shell").

## Feature decisions

| Area | Decision |
| --- | --- |
| Defaults | Least friction for end users: visual pop-ups off, in-page sounds on. |
| Guest access | Planned: off by default, admin-toggleable per instance. The built-in Everyone group replaced the guest role; there is no anonymous or invite sign-up yet (Open items). |
| File attachments | Blobs on disk named by the SHA-256 of the stored bytes. Plaintext channels seal every file under the uploader's account key and encrypted channels encrypt in the browser, so nothing is deduplicated (Encryption). Per-file size limit set by the admin. Attachments follow their message's retention. |
| Moderation | Message removal by author or moderator; reports verified server-side (against the server's copy in plaintext channels; by MLS signature in encrypted ones, not built yet); bans that revoke sessions, live connections and calls; server mute. Purging a banned user's history is administrator-only and separate from the ban itself. |
| Voice input | Push-to-talk and voice activation, user-selectable; moderators can force PTT per voice channel (advisory: the client complies) and server-mute people (enforced by LiveKit). See "Server mute". |
| Media stack | LiveKit, self-hosted. Apache-2.0, built-in E2EE, SFU relays ciphertext only. |
| GIF provider | Admin-selectable between Giphy and Tenor, or disabled entirely (the default). Every image is proxied by the server and a chosen GIF is stored locally as an attachment, so clients never contact the provider. |
| Markdown | Hand-rolled minimal renderer rather than a library: bold, italic, strikethrough, inline and fenced code, blockquote, autolinks. Small enough to audit, and avoids trusting a dependency with untrusted input. |
| TLS | Required in practice. Caddy provided but optional; three deployment paths documented. |
| Permissions | Admin-defined groups, each with its own permission switches, assigned to channels (Discord roles / TeamSpeak server groups). Replaced the fixed four roles in build-order step 12. Decided by Ryan, 2026-10-30; model settled 2026-10-31, see "Permission groups". |
| Encrypted channel membership | Follows channel access automatically. Nobody adds people to encryption groups by hand; every join is announced to the channel: per person by default, per device as a client option (Ryan, 2026-10-31). Decided by Ryan, 2026-10-30; see Encryption. |

### Text and chat

#### How reporting works under encryption

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

#### Moderation in the web client

Built 2026-11-03 (step 13, M5 session C).

- **Report** on other people's messages (`ChannelPane.tsx`
  ReportDialog). It sends the text as shown; in an encrypted channel the
  dialog says so, since that reveals it to the server and it stays
  unchecked.
- **Server settings** gains Reports (needs view_reports:
  Open/Actioned/Dismissed/Rejected; a Checked / Didn't match / Unchecked
  tag; Delete message, Ban author, Dismiss, Mark actioned; deleting and
  banning stay separate calls from closing a report), Bans (needs ban;
  Unban) and Log (Ban, View reports or Delete messages). Members rows get
  Ban/Unban and, for administrators, Delete (type the username).
- **Ban durations** are presets: 1 hour, 1/7/30 days, permanent (Ryan's
  pick). Purge is administrator only.
- **Server side:** `GET /users` adds `banned` and `banned_until`; reports
  add channel name and `message_gone`; administrator deletions write
  `delete_user` to `moderation_log` (the username in detail, since the
  row is gone); `GET /moderation-log` (`modlog.go`, `?before=` paging,
  `?archived=1`).
- **Pending reports:** a red dot on the Server settings gear for holders
  of view_reports (Ryan asked for one). `reports_changed` goes only to
  them (emitUsers) when a report is filed or resolved; the client
  refetches the open list, also every 2 minutes and on focus as a
  fallback; the dialog opens on Reports while any are open.
- **Log archive:** entries older than
  `server_settings.modlog_archive_days` (migration 0017, a one-row typed
  table for server-wide settings; default 30, 1 to 3650, set by an
  administrator in the Log tab) show under Archived. A view only;
  nothing is deleted.

#### Mentions are metadata the server sees

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
- **Built 2026-11-03** (after M5). Server: migration 0018
  `message_mentions`, `mentions.go` (filter by the viewer rule, a
  `mention` event via emitUsers to the mentioned only,
  `GET /channels/{id}/members` for autocomplete), `mentions` on message
  frames and history, `last_mention_at` per channel in the list. An edit
  replaces the set and notifies only the newly added. Core:
  `findMentions` (code skipped, exact username match first, then a
  unique case-insensitive one), `ChatMessage.mentions` / `mentionsMe`,
  `Chat.mentions` (channels with an unread mention, compared with the
  read mark like unread) and a `mentioned` event. Web: `@` list in the
  composer and the edit box, pills (stronger for you), highlighted rows,
  a red `@` badge in the sidebar, a mention sound and opt-in desktop
  notifications (who and where only, never the text) in Settings > Chat.

#### Reactions are metadata the server sees

Decided by Ryan, 2026-11-04 (option A of two). Emoji reactions on
messages (`reactions.go`, `message_reactions`, migration 0023).

- **What the server learns:** who reacted with which emoji to which
  message, in every channel, encrypted ones too. Never the message text.
  The same kind of metadata as mentions, and stored the same way: in the
  clear, not sealed under the reactor's key. The rows go when the message
  is deleted, expires, or its author is purged (ban-and-purge or account
  deletion), and when the reacting account is deleted. They can survive
  in database backups, like mentions and timestamps.
- **The rejected option (B):** each reaction as an MLS message, so the
  server sees only that someone reacted. About three times the work,
  plus the problems edits already have: devices that joined later or
  can't decrypt would show unreadable reactions, and counts could only
  be worked out on the client.
- **Rules:** anyone who may post in the channel may react; not on
  deleted, pending or (client-side) unreadable messages. Unicode emoji
  only, checked by the server (`validEmoji`: pictographs and their
  modifiers, at most 10 code points, no text). Several emoji per person
  per message; at most 20 different emoji per message (the message row
  is locked while checking). Rate limit 30 up front, then 2 a second.
  No notifications for reactions.
- **API:** `PUT` / `DELETE /messages/{id}/reactions/{emoji}`, both
  idempotent; a `reaction` event to the channel (message, emoji, user,
  added). History carries `reactions: [{emoji, users}]` per message.
- **Client:** chips under the message (count, yours outlined in the
  accent, hover lists who), click to toggle; "React" on hover and a "+"
  after the chips open the emoji picker beside the message.

#### Emoji

Ryan, 2026-11-03; built 2026-11-04 (`client-web/src/emoji.tsx`).

- A picker in the composer (categories, search, recently used, skin
  tone, all per browser) plus `:name:` shortcodes (GitHub's set): ":smi"
  opens a list, a complete ":fire:" converts on the closing colon, in the
  composer and the edit box.
- Unicode emoji are just text, so they work in encrypted channels
  unchanged.
- **Drawn with the system font** (decided with Ryan), no image set
  shipped: looks native per OS; a bare Linux box may lack a colour emoji
  font. Emoji newer than the device's font are hidden by a canvas test,
  one sample per Emoji version (no colour font at all = no filtering).
- Names and keywords from `emojibase-data` (MIT, pinned exactly), bundled
  and lazy-loaded as its own chunk (~100 KB gzipped), no CDN.
- Reactions got their own design pass ("Reactions are metadata the
  server sees").

#### Custom stickers

Ryan, 2026-11-03: images uploaded to the server and sent like a GIF.
Built 2026-11-04.

Decided with Ryan:

- **Server-wide:** one set for the whole server, not per channel.
- **Moderators and administrators only**, through a new permission
  (`manage_stickers`) given to the Moderator and Administrator groups by
  default, not a check on group names, so it follows the permission-group
  system like everything else.
- **Stickers stay when their uploader deletes their account.** They are a
  contribution to the server, not the uploader's own content, so they are
  not sealed under the uploader's key and are not crypto-shredded; the
  uploader reference just becomes NULL. The upload dialog says so before
  the first upload.
- **Limits** (2026-11-04): PNG, APNG, GIF, WebP (static or animated); not
  SVG, which can carry script. The server checks the real type from the
  file's bytes, not the name or what the browser claims. At most 1 MB and
  512 x 512 pixels per file (Ryan chose the larger option for
  longer/sharper animations), shown at about 160 px; at most 100 per
  server. All three limits live in server settings. A name per sticker
  (for search and `:name:` picking) and alt text for screen readers.
- **Rejected (2026-11-03):** personal stickers that travel with the user
  across servers. Without federation they could only be client-side
  images re-uploaded per server, and anyone could post anything as a
  "sticker" with no approval step: a moderation burden.

Built as: `httpapi/stickers.go` + `stickerimage.go` (type and size read
from the file's header bytes, no image library); migration 0024 (table,
limits in server_settings, manage_stickers added to Moderator); blob GC
keeps sticker blobs. A sticker message's text is the token
`[sticker:<uuid>]` (client-core `stickers.ts`), so plain and encrypted
channels work the same and a rename changes nothing sent; a removed
sticker shows "Sticker removed". Images are fetched with the session
token and shown from blob: URLs (no signed links to expire). Add and
remove go in the moderation log.

- **Picking** lives in a Stickers tab of the emoji picker (Ryan: no
  separate button); reactions stay emoji only.
- **`:name:` suggestions:** up to 3 matching stickers above the emoji in
  the composer's shortcode list (not when editing). A sticker can't sit
  inside text, so picking one sends it at once and removes the ":query";
  a typed-out ":name:" never sends a sticker by itself (no accidental
  sends).
- **In encrypted channels** the message carries only the sticker's id,
  inside the ciphertext; fetching the image still tells the server who
  viewed which sticker, as with GIFs.

#### Username colours

Ryan, 2026-11-04; built the same day. A name is drawn in the colour of
the account's highest group (highest `position`) that has one. Server
data, the same for everyone.

Decided with Ryan:

- **Defaults** (migration 0025, matched by name): Administrator #d96932
  (the accent, kept for now; change it if names look like buttons),
  Moderator #ff00ff, Member #00ffff, Everyone none (plain text colour).
- **Everywhere a name appears:** message authors, member list (Server
  settings > Members), @mention chips and the @ suggestion list, voice
  rosters. Coloured names are bold.
- **Minimum contrast 3:1** against the background (#333333), the WCAG
  level for bold text; checked in the picker and by the server. Measured:
  orange 3.6:1, magenta 4.0:1, cyan 10.1:1, white 12.6:1 (4.5:1 would
  refuse the default orange and magenta).
- **On by default;** each user can hide them in Settings > Appearance
  ("Show name colours", per browser).
- **Server settings > Groups:** the server-wide switch, a "Default
  colours" button, and a Colour button per group (picker, hex box, live
  preview, contrast readout, "No colour").

Built as: `perm_groups.colour` (nullable, lowercase #rrggbb) and
`server_settings.name_colours` (on by default); `httpapi/namecolours.go`:
`GET /name-colours` (every live account -> colour or null, all null when
switched off), `PUT /name-colours` (the switch) and
`POST /name-colours/defaults` (the four built-in groups back to the
defaults; other groups and the switch untouched), both manage_groups. A
group's colour is `PATCH /groups/{id}` with `colour` ("" clears); a
colour-only edit is allowed on a group at your own rank too (so an
administrator can recolour Administrator) and sends only `names_changed`,
not an access change. Clients refetch on `names_changed` and
`perms_changed`, and when a name appears that the map lacks (a new
account; at most every 30 s).

#### Text chat in the web client

Scope decided with Ryan 2026-11-01 (step 13, M2).

- **Layout:** Discord-like. Channel sidebar with text and voice channels,
  message pane, composer, user panel with backup status and Log out.
  Core text (send and receive in plain and encrypted channels, history
  paging, archive with a backup upload scheduled per archived message),
  editing and deleting your own messages, unread markers.
- **Logic lives in client-core** `chat.ts`: `Chat` per account (event
  socket, channel list, unread), `ChannelView` per open channel (socket,
  decrypt/archive queue, paging, send/edit/delete). client-web only draws
  snapshots.
- **History paging:** the websocket sends the newest 50 on connect, with
  `has_more`; older pages come from
  `GET /channels/{id}/messages?before=<message id>&limit=` (max 100),
  walking (created_at, id) backwards (index from migration 0016).
- **Edits:** `PATCH /messages/{id}` `{body}`, author only, while they may
  still post, never a deleted message. The body is replaced in place (no
  server-side edit history) and `edited_at` set; `message_edited` carries
  the new body. In an encrypted channel the new body is a fresh MLS
  ciphertext of an envelope that keeps the old file keys (or the
  attachments would become unreadable). Moderators delete; they do not
  edit others' words.
- **Unread:** `GET /channels` gives `last_message_at`; a new message sends
  `channel_activity` (channel, message id, author, time, no content) to
  the connected accounts that may view the channel and to nobody else,
  since a hidden channel being busy is itself a leak. The client keeps
  the last-read time per channel in localStorage; a channel seen for the
  first time counts as read. The "New" line, jump bar and Mark Category /
  All as Read: "Unread jump and Mark as Read" below.

#### Markdown, link previews and GIFs

Built 2026-11-01 (step 13, M4 session A).

- **Markdown** (`markdown.tsx`): bold, italic, strike, inline and fenced
  code, "> " quotes, links; built as React elements, never HTML strings.
- **Link previews** (`previews.tsx`) for the first link in a message, via
  `POST /unfurl`, one request per link per page load. The server asks
  YouTube's oEmbed endpoint for YouTube links (`unfurl.fetchYouTube`):
  scraping watch pages failed (huge pages, consent redirects). A YouTube
  link always gets its click-to-play box (youtube-nocookie), even when no
  card could be fetched or previews are off: it contacts nobody until
  clicked.
- **Previews in encrypted channels are opt-in** (Settings, "Link previews
  in encrypted channels", per browser). Ryan chose opt-in over never or
  always: the server learns the link and preview images load from the
  linked site, and the setting says so.
- **GIF picker** (`gifs.tsx`): the button appears when `GET /gifs/config`
  says enabled; trending on open, search as you type (400 ms pause);
  picking one sends it at once as its own message (text may be empty with
  an attachment).
- **Join and leave notices** in encrypted channels: Chat forwards
  `groups.onMembership` people changes for the open channel; notices sit
  among messages by time.

#### Attachments in the web client

Built 2026-11-03 (step 13, M4 session B).

- **Adding:** "+" button (several files at once), pasting files or
  screenshots into the message box, or dropping files anywhere on the
  channel. Each file uploads the moment it's added (`ChannelView.upload`,
  which encrypts first in an encrypted channel) into a tray above the
  composer with thumbnails and a remove button; Send waits for uploads
  and leaves failed ones out. `ChannelView.send` takes `Upload`s alongside
  plain `AttachmentInfo` and puts their keys in the envelope. Switching channel drops the tray; the
  server sweeps unclaimed uploads after an hour.
- **Limits:** at most 10 per message (the server's cap). Each encrypted
  file's key and name (cut to 120 characters) ride in the message and
  count toward its 4,000-character limit, so the error says to send
  fewer files.
- **Showing** (`attachments.tsx`): encrypted images decrypt on sight;
  encrypted video and audio up to 10 MB too, bigger ones behind a "Load"
  button, because GCM can't stream into a player; other files decrypt on
  click and save through `download=`, never opening. The blob's type
  comes from the inline allowlist, never the sender (stored XSS on our
  origin otherwise). Decrypted copies are shared per attachment and
  freed a minute after nothing shows them.
- **Image viewer:** clicking an image opens an in-page viewer (name,
  "Open in new tab", "Download"; Esc or a click outside closes).
  Settings, "Open images in a new tab", switches to tabs (per browser,
  off by default; Ryan asked for the choice). Ctrl/middle-click always
  opens a tab.

#### Resizable sidebar

Asked for by Ryan and built 2026-11-12 (`client-web/src/sidebarWidth.tsx`),
SB1-SB8 pass.

- **Drag the sidebar's right edge** (the line between the channel list
  and the stage, cards or chat): 200 to 480 px, default 240.
  Double-click resets. The handle is an invisible 8 px strip showing a
  thin accent line on hover; it is also a focusable separator (arrow
  keys step 16 px, Home resets).
- **Per browser, not per account:** kept in localStorage
  (`openvoxa.layout.sidebarWidth`), so each browser and each desktop app
  server view remembers its own. A layout preference doesn't need the
  server.
- The width is a CSS variable (`--sidebar-width` on `.app`), so the
  narrow-screen rule (under 640 px: 180 px, no handle) still wins.

### Voice and screen share

#### Voice and screen share in the web client

Decided with Ryan 2026-11-01 (step 13, M3). Discord-like.

- **Joining:** clicking a voice channel joins its call. The people in
  each call are listed under the channel (live for your own call:
  speaking ring, mic off, LIVE when sharing; the server's list for the
  others). A voice bar above the user panel has mute, deafen, share
  screen, voice settings and leave.
- **Controls:** mic and speaker pickers, per-person volume and "mute for
  me" (right-click a person; this device only), deafen (the mic button is
  highlighted when deafened too), a push-to-talk key binding (default the
  backquote key; a page only sees keys while focused, so character keys
  are ignored while typing; the desktop app is to add a global key).
- **Screen share options:** quality presets, sharp text or smooth motion,
  share audio. The Advanced codec and simulcast options went with the
  voice channel view (VP8 always). "Pin max quality" is a voice setting.
- **Code:** client-core `voice.ts` (`VoiceClient`: media key ring,
  `overwriteSlot`, PTT, share encodings). It imports LiveKit, so it is
  not in client-core's index: client-web loads it on first join (LiveKit
  is ~500 KB).
- **Who is in each call:** `GET /voice/participants` asks LiveKit
  (`ListParticipants`) for the voice channels the caller may view, cached
  2 s, names from our database. No LiveKit webhooks: a client that joins
  or leaves posts `POST /channels/{id}/voice/changed`, and the server
  sends `voice_changed` to the channel's viewers only (as
  `channel_activity`), who ask again; kicks send it too. Clients also poll
  every 20 s for people who vanish silently.

#### Voice activation and audio settings

Agreed with Ryan 2026-11-05 (VA tests). Four input modes, picked in
Settings, Voice: **Voice Activity** (the default; before, the mic was
either open or push-to-talk), **Push-to-Talk**, **Tap to Talk
(Experimental)** (Ryan's idea: one press opens, it stays open while you
talk and closes after a quiet stretch, slider 0.5-5 s, default 1.5 s; 3 s
if you never start; a second press closes at once; holding the key keeps
it open) and **Open Mic**. A channel that forces push-to-talk allows only
Push-to-Talk: Tap to Talk counts as an open mic there (Ryan).

- **Sensitivity:** a live level meter with a threshold marker; "Set
  Automatically" (on by default) puts the threshold 15 dB over a noise
  floor that follows quiet stretches (clamped to -65..-30 dBFS), else a
  manual slider (-80..0 dBFS). 300 ms hold after the voice stops; sent
  audio runs 40 ms behind the measurement so first syllables get through.
- **Also built:** input volume (0-200%), output volume (0-100%, on top
  of per-person volume), mic test ("Let's Check", plays the processed mic
  back, not during a call), "You're muted" when you talk while muted (in
  the voice bar, and a red banner with Unmute on your own tile in the
  call view, after VA4: the bar alone was easy to miss), push-to-talk release delay (0-1000 ms, default 200), and
  switches for the browser's noise suppression, echo cancellation and
  automatic gain (all on by default; changing one recaptures the mic).
- **How:** `client-core/src/micWorklet.ts` (AudioWorklet: the audio
  thread, so background tabs, whose timers browsers slow to 1 s, still
  gate on time) inside `micChain.ts`, attached as a LiveKit track
  processor on our own AudioContext (`webAudioMix` stays off). The
  worklet gets the mic twice: LiveKit's track, which mute silences, is
  the only thing sent; a clone is only measured (meter and muted hint).
  Voice activation gates with gain, not LiveKit mute, so others see no
  mute icon flicker; Push-to-Talk and Tap to Talk use LiveKit mute as
  before. All on the device, before encryption: the server learns
  nothing new.
- **Key field** (after VA5/VA6): the push-to-talk key is an outlined
  field right after its label; a bare "`" on a 1440p screen was invisible.
  One key, shared by Push-to-Talk and Tap to Talk.
- **On-screen talk button** (Ryan, 2026-11-06; TB1-TB8): Push-to-Talk
  and Tap to Talk were keyboard-only, so a tablet couldn't talk in those
  modes (or in a channel forcing push-to-talk). A wide button in the
  voice bar, above Mute, presses the same "key": hold to talk, or in Tap
  to Talk tap to open and tap again to close. Green "Talking" while open;
  greyed out while deafened, server-muted or listen-only. Setting under
  the key field, "On-screen button": Touch screens only (default; any
  touch pointer, so touchscreen laptops too), Always, Never. Release
  delay and silence timer apply as for the key. Pointer capture keeps a
  press held when the finger slides off; a cancelled touch lets go.
  After TB7: a press is ignored unless the mic can open, and server mute
  or deafen closes an open Tap to Talk or held push-to-talk, so the mic
  doesn't come back open on unmute (Web client notes, "Disabled buttons").
- **Ducking share sound** (Ryan, 2026-11-06; DK1-DK9): while someone
  else talks, every screen share's sound on this device fades down.
  Settings, Voice, Screen Share: "Lower screen share sound while others
  talk" (on by default) and a slider for how loud share sound stays,
  Silent to 90% (default 30%; greyed out when off). Only other people's
  voices count for now (Ryan): not your own, not people you muted
  locally or set to 0%, nothing while deafened. The trigger is LiveKit's
  speaking signal (the speaking rings; nothing new reaches the server),
  so it lags a little. Fades down in 150 ms, holds 400 ms after the
  talking stops, then comes back up over 600 ms, so gaps between words
  don't pump. All in `voice.ts` (`#updateDuck`), on the receiving
  device: a multiplier on `ScreenShareAudio` volume in `#applyVolume`.
- **Noise suppression** (Ryan, 2026-11-06; RN1-RN9): the old on/off
  switch became Off / Standard (the browser's filter, the default) /
  Strong (RNNoise 0.2, instead of the browser's filter, never stacked).
  The old "off" reads as Off. Strong filters both of micChain's paths,
  so voice activation judges the cleaned sound and typing doesn't open
  the gate. Code: `client-core/src/rnnoiseWorklet.ts`, an AudioWorklet
  in front of micWorklet, loaded only when Strong is first picked
  (`@jitsi/rnnoise-wasm` 0.2.1 pinned, Apache-2.0; its "sync" build
  inlines the wasm: a 1.9 MB file, 1.7 MB through Caddy's gzip). Measured
  in Chromium on synthetic speech: steady noise -40 dB, clicks -17 dB,
  speech unchanged, ~4% of one core, ~19 ms added (9 ms of 128-to-480
  sample buffering plus RNNoise's own frame). Needs 48 kHz: the mic's
  AudioContext asks for 48 kHz and falls back to the browser's rate if a
  mic won't connect at 48 kHz (Firefox may refuse); then Strong says so
  and the browser's filter is used, so Strong is never worse than
  Standard. Firefox passed RN9. Switching in a call recaptures the mic
  (Implementation notes, LiveKit, "Recapturing the mic").
- **Later:** per-channel audio quality (Ryan, 2026-11-06: probably
  rarely used, not now; every mic sends LiveKit's default 48 kbps mono;
  idea: presets 32/48/64/96/128 per voice channel, `manage_channels`,
  enforced by the sender only). Ducking on your own voice too, maybe.
  RNNoise's voice probability (returned per frame, unused) could drive
  voice activation.

#### Screen share quality limit

Decided with Ryan, 2026-11-04. One limit for the whole server
(`sharelimit.go`, `server_settings.share_max_*`, migration 0026), set by
an administrator in Server settings > Voice and Video. **No limit by
default** (Ryan: hosts with fast uploads shouldn't have to opt out).
Per-group limits were considered and left for later.

- **Why:** the SFU sends one copy of a share to each viewer, so the
  host's upload is about bitrate x viewers (a 20 Mbps 4K share to 5
  viewers is ~100 Mbps). The limit keeps one share from filling it.
- **The limit:** a preset's "p" (the shorter side of the picture, so
  portrait and ultrawide count fairly), frame rate and best-layer
  bitrate. All three set, or all NULL for none.
- **Client:** the share dialog asks `GET /voice/share-limit` each time
  it opens and hides presets above it. `VoiceClient.startShare` caps fps
  and bitrate and scales the capture down to the limit (LiveKit only asks
  the browser for an "ideal" size, so a bigger screen comes through
  whole otherwise).
- **Enforcement:** every 5 s, while a limit is set, the server lists
  live rooms with publishers and checks each video track's declared
  size and per-layer bitrate (5% and 8 px slack). A track over the limit
  costs its owner the screen share permission for the rest of the call
  (`UpdateParticipant`, publish sources = microphone only): LiveKit
  unpublishes the share at once and refuses new ones until they rejoin
  (fresh token). The client notices (`ParticipantPermissionsChanged`,
  `LocalTrackUnpublished`), releases the capture and says why.
- **What it can't do:** LiveKit only knows what the browser declared,
  not what it actually sends, so a modified client that under-declares
  is not caught. The backstop is traffic shaping on the host
  (deploy/README.md, "Screen share limit").
- **Upload speed test** (`uploadtest.go`, migration 0027): an
  administrator's button that measures the server's own upload, for a
  suggested limit (the highest preset whose bitrate x expected viewers
  fits in 70% of the upload). It runs on the server, since a browser on
  the server's LAN would measure the LAN. 6 parallel HTTP/1.1 uploads to
  Cloudflare's speed test (`speed.cloudflare.com/__up`) for 10 s, the
  first 2 s ignored; one test at a time; the last result is stored.
  Cloudflare was Ryan's pick: free, no account, results not published.
  M-Lab NDT7 was rejected because it publishes every test with the IP
  address; LibreSpeed's volunteer servers often can't take a gigabit
  upload. The endpoint is not a documented API, so failures are shown
  as such. A per-user test (sharer's upload) is for later.

#### Server mute

Decided with Ryan, 2026-11-04, instead of enforcing force-PTT.

- **Why force-PTT stays advisory:** only the client knows whether a
  push-to-talk key is down, and voice is end-to-end encrypted, so the
  server cannot check what a client claims. A modified client would just
  report "held" forever. Toggling the microphone source on each key
  press would also cost every press a republish (LiveKit unpublishes a
  track the moment its source is taken away), clipping the first words.
  The honest app already forces PTT on and greys the setting out.
- **What it is instead:** a holder of the new `server_mute` switch
  (Moderator by default, migration 0028) takes away someone's microphone
  and screen share audio in **every** voice channel. Screen video stays
  allowed. Same rank rule as bans (only people below you); unmute works
  on anyone, like unban. Logged as `voice_mute` (detail: the duration)
  and `voice_unmute`.
- **How long:** until unmuted (the default), or 10 minutes, 1 hour or 1
  day (Ryan wanted both). `voice_mutes` holds one row per account; a
  15 s sweep deletes expired rows and gives the microphone back live.
- **Enforcement (`voicemute.go`):** the database row is the truth. The
  join token's `canPublishSources` leaves the microphone out (camera +
  screen share, since an empty list means "any"), so rejoining is no way
  out. Mute, unmute and expiry call `applyVoiceMute`, which edits the
  live participant's sources through `UpdateParticipant`. The client's
  post-join `voice/changed` hint re-applies it for that room, closing the
  gap between minting a token and arriving. The share limit edits the
  current list too, so neither undoes the other (`editSources`; never
  an empty list).
- **Client:** muted means the allowed sources omit MICROPHONE
  (`micTakenAway`); LiveKit sends every participant's permissions to
  everyone, so rosters and the moderator's menu show it live. The muted
  person's mic is released and republished on unmute (`#syncMic`); the
  mic button gets a red outline and X (not the greyed self-mute look),
  and "Share audio too" is struck through with the reason.
- **UI:** "Server Mute" in the right-click menu on a person in a call;
  Mute / Unmute and a "Muted" tag in Server settings > Members.

#### Move and disconnect

Ryan, 2026-11-08 (urgent request). A new switch, **Move members**
(`move_members`, migration 0035: on for Moderator; Administrator implies
it), lets staff move someone **already in a call** to another voice
channel, or disconnect them from voice. Nobody is pulled into a call
they didn't join (their mic would go live without their choice).
Disconnect is not a ban: they can join again.

- **Rank:** only people below your rank, as with bans and server mute.
  The target must be allowed in the destination channel; the moderator
  must see both channels.
- **Why the client moves itself:** each voice channel has its own MLS
  group and media key, so LiveKit's MoveParticipant would land them in
  the new room unable to hear anyone. The server sends `voice_moved` to
  that account's sockets; the device in that call leaves and joins the
  new channel. A device that doesn't (a tab on an older build) is removed
  from the old call after 10 s, so leaving is enforced regardless.
  Disconnect sends the event, then removes them from LiveKit 0.3 s later.
- **What they see:** "<name> moved you to <channel>." under the voice bar,
  or "<name> disconnected you from the call." Both go to the moderation
  log (`voice_move` with the channel name, `voice_disconnect`).
- **Where:** a Move section (channel picker, Move, Disconnect) in the
  person menu of the call you're in, and a menu on names under the other
  voice channels in the sidebar (click or right-click) for holders of the
  switch. `POST /users/{id}/voice-move {from_channel_id, to_channel_id}`
  (`to` empty: disconnect).
- **Drag and drop** (same day): holders drag a name under any voice
  channel onto another voice channel's row (outlined in the accent while
  over it). A refused drop shows the server's reason at the drop point.
  The menu stays for touch screens, where HTML drag and drop is unreliable.

#### Direct messages

Designed with Ryan 2026-11-08; all three stages built the same day (below). "Whisper"
means the same thing as a DM: no separate voice whisper.

- **One-to-one only.** No group DMs; group chat stays in channels.
- **Always end-to-end encrypted, readable only by the two people.**
  Administrators get no access: they can't read DMs and aren't in their
  MLS groups.
- **Same abilities as an encrypted text channel:** attachments,
  reactions, replies, edits, deletes, stickers, GIFs, mentions, reports.
  A report sends the text as shown, as in encrypted channels.
- **Who may DM:** a new `direct_messages` switch, on for Member by
  default, so administrators can take it from new or problem accounts.
  Staff (anyone ranked above Member: Moderator, Administrator) can always
  DM. The UI calls them **Direct Messages**, and the
  name menus say **Message**.
- **Block** (per person, silent; they aren't told): they can't DM you,
  the DM leaves your list, and their messages in channels collapse to
  "Blocked message (show)". Voice is unaffected (Mute for me covers that).
  Settings lists who you've blocked, with Unblock.
- **Losing access** (switch removed, or either side blocks): the DM turns
  **read-only** for both, with the message box greyed out and a reason.
  It isn't hidden, except from the person who blocked.
- **Alerts like a mention:** a red count on the DM button and on the
  conversation, plus the mention sound. A desktop pop-up only with
  mention notifications on (default off).
- **Layout (Discord-style):** a button at the top of the sidebar switches
  the Text and Voice channel lists to a list of your DMs (newest first,
  unread counts, "+ New Message" picker). Clicking one opens it in the
  right pane, like a channel. Another button switches back. Start one
  from anyone's name anywhere: "Message".
- **Accounts:** deleting an account crypto-shreds its messages as
  anywhere else; its DMs remain with tombstones. A banned account's DMs
  turn read-only.

**Implementation plan.** A DM is a `channels` row with a new kind `dm`
(widen the `kind` CHECK; `encrypted = true`), plus a `dm_members` table
(channel, two users; the pair unique as an ordered pair). Then:

- **Access:** in `canViewSQL` / `canPostSQL` / `viewerFilter`, a DM is
  visible only to its two members. It must **not** take the
  `isAdminSQL` path: `allowed-devices` (which MLS reconciles against)
  comes from the same rule. Posting needs both members still able to
  DM and no block either way.
- **Lists:** `listChannels` and every "all channels" sweep (voice,
  retention, archives) skip `dm`. New `GET /dms` (other user, last
  activity, unread, read-only reason), `POST /dms {user_id}` (get or
  create), `PUT/DELETE /blocks/{user_id}`, `GET /blocks`.
- **Events:** activity and mention events reach exactly the two members.
- **Stages:** (1) server: migration, access, endpoints, events, Go
  tests for access (admin excluded, block, switch). (2) web client: the
  sidebar switch, DM list, New Message, "Message" in name menus,
  read-only box, alerts. (3) Block UI: menus, the Settings list, and
  collapsed blocked messages in channels.

**Stage 1 as built (2026-11-08).** Choices made while building:

- Tables `dm_channels` (one row per DM: `user_low < user_high`, unique)
  and `user_blocks`. The channel's name is `dm:<low>:<high>`, unique,
  so two people starting a DM at once get the same one (`ON CONFLICT
  (name) DO NOTHING`). `CHECK (kind <> 'dm' OR encrypted)`.
- **"Staff can always DM"** is "holds any switch" (the same line as
  requireStaff), not rank: `mayDMSQL` = not deleted, not banned, and a
  group with any switch in perm.All (`TestDMSwitchList` keeps the SQL
  list in step). `perm.Set.Staff()`, the two-factor "staff" policy and
  the web client's staff checks (`isStaffPerms`, client-web perms.ts)
  all ignore `direct_messages`: otherwise every Member became staff.
- View = membership only, so a read-only DM keeps its MLS group and
  comes back intact after an unblock. The blocker's `GET /dms` leaves it
  out; `POST /dms` still returns it (reason `you_blocked`).
- Read-only reasons, caller's side: `you_blocked`, `you_cannot`,
  `deleted`, `unavailable` (no switch, banned, or they block you: one
  reason, so a block stays silent). `POST /dms` to someone who blocks you
  answers like someone without the switch. `GET /dm-candidates` (New
  Message picker) lists accounts that may receive DMs, minus your own
  blocks; people who block you stay listed.
- The channel socket re-checks posting on every message in a DM (a block
  changes no group or channel). Once refused it stays read-only; the
  client reconnects on `dms_changed` (to both people on create, block,
  unblock; carries nothing).
- Every manage-channels endpoint (rename, delete, retention, history
  sharing, access) skips `kind = 'dm'` (404). DMs keep history sharing
  off and no retention.
- Reports from a DM show "Direct message" as the channel (reports and the
  log). A `delete_messages` holder can still delete a reported DM message
  by id, as for any message: removes it, can't read it.
- **Stage 2 must:** refetch `GET /dms` on `dms_changed`, `perms_changed`,
  `access_changed` and `user_purged`, and on a `channel_activity` for an
  unknown channel id (someone's first message); alert on
  `last_incoming_at` like a mention.

**Stage 2 as built (2026-11-08).** Web client; DM1-DM12 passed.

- **client-core:** `Chat.dms` / `refreshDMs()` / `startDM(userId)` and
  a `dms` ChatEvent. A DM opens with `Chat.open(channel_id)` as a
  ChannelInfo of kind `dm` made by `dmChannel()` (encrypted, carries
  the DMInfo as `.dm`; `last_incoming_at` stands in for
  `last_mention_at`). Refetched on everything "Stage 2 must" lists and
  on the event socket reopening; a `channel_activity` for an unknown id
  refetches, then is handled. A DM nobody has read on this browser
  starts read at its `created_at`, so a first message alerts.
- **Alerts:** every message from the other person emits `mentioned`
  with `dm: true` (before `message`, so only the mention sound plays);
  the server's `mention` event is ignored for anything not in the
  channel list, so a DM with an @ doesn't alert twice. Pop-up: "X sent
  you a message", no text. Mute Sounds on a DM silences it fully (a
  channel's mute lets mentions through; a DM is all mentions).
- **Read-only:** the box greys out with the reason (`dmText.ts`). When
  `can_post` flips, the open view reconnects: the server keeps a
  refusal for a connection's life.
- **Layout:** "Channels" / "Messages" tabs under the sidebar header
  (Ryan's pick), remembered per browser; the Messages tab's red count is
  the number of conversations with something new, and each row gets a
  red dot, no number (the server has no unread counts; Ryan's pick).
  Home lives on the Channels tab. "Message" is on message author names
  (click or right-click), the voice person menu and the roster of other
  calls (for everyone; move_members adds Move). Not on @mention chips
  yet.
- **Sound cooldowns (Ryan, anti-spam):** a DM plays at most once a
  minute per conversation (looking at it resets that); @mentions play
  at most once a minute over all channels, not reset by looking. Both
  cover the pop-up too; badges still update on every message. Fixed,
  not settings.

**Stage 3 as built (2026-11-08).** Block UI; BK1-BK8 passed.

- **client-core:** `Chat.blocks` / `blocked` (user ids), `refreshBlocks()`
  (on start, `dms_changed`, event socket reopening), `block(id, name)`,
  `unblock(id)`, a `blocks` ChatEvent.
- **Where:** Block (red) / Unblock under Message in the name menu, and
  after a divider in the DM row menu. No confirmation (undo is one
  click). Not in the voice person menu: voice is unaffected.
- **Open blocked DM:** when `GET /dms` drops the open DM, `#loadDMs`
  fetches it from `POST /dms` and keeps it in the list while it's open
  (reason `you_blocked`); opening anything else drops it. Its view shows
  a bar with Unblock above the greyed-out box.
- **Settings > Chat > Blocked People:** the list with Unblock.
- **Channels (not DMs):** a blocked person's message collapses to
  "Blocked message (show)", name hidden too; "show" reveals that one
  message until the channel is left. A reply quoting them shows
  "Blocked message". No mention alert (sound, @ badge, pop-up) and no
  message sound from them; the unread dot stays. Server side,
  `listChannels`' `last_mention_at` skips authors you block, so the @
  badge stays off after a reload.

#### Receiving shares on demand

Ryan, 2026-11-04: a share's sound played for everyone in the call the
moment it started, wanted or not. Quick fix agreed before the voice
channel view (next section):

- **Nothing of a share is received until asked for.** The room joins
  with `autoSubscribe: false`; microphones are subscribed explicitly
  (`#subscribeWanted`, at join and on every TrackPublished). A share's
  picture is received only while a tile shows it (`attachScreen` /
  `detachScreen` count the elements), so viewers no longer download
  shares they don't watch.
- **Sound only after Listen**, per share, off for every new share.
  Listen is in the share tile and as "Listen to Share" in the person
  menu; it keeps playing after Back to Chat. The person's volume
  slider applies to it as before. LS1-LS7 passed.

#### Voice channel view

Ryan, 2026-11-04. The main area shows the voice channel you are in as
tiles, one per person; a sharer's tile shows the share preview instead,
with Hide (stop showing it), Listen and Fullscreen. Decided the same day:

- **Previews from a small copy.** The sharer also sends a half-size
  simulcast layer; tiles take that, Watch and Fullscreen the full one.
  Cheap for viewers, a little more upload and CPU for the sharer. H.264
  simulcast is poorly supported, so this means VP8 (see Implementation
  notes on simulcast).
  **Changed 2026-11-08 (Ryan):** the small copy runs at the share's
  chosen frame rate, not capped at 30. With every viewer on a tile the
  full copy is paused, so a 60 fps game share went out as 30 (found on
  the live server with WoW). Gaming is the point of the project: smooth for every
  viewer beats saving upload. Own share's Stats line also shows the
  capture (asked / agreed / got fps).
- **Letter circles for now**, as in the sidebar; uploaded avatars
  replace them later (Open items, "User avatars").
- **Only while you are in the call.** No looking into a channel before
  joining.
- **Layout (agreed 2026-11-05):** joining shows the tiles; a text
  channel shows its chat with the call going on; clicking the voice
  channel you are in shows the tiles again. A tile: letter circle,
  name, speaking ring, mic and "muted for me" icons. A sharer's tile:
  the preview, with Watch (today's share view), Listen, Fullscreen and
  Hide on hover or tap; Hide shows the circle and stops the download
  until they share again (Show Share undoes it).
- **VP8 always, with the small copy:** the share dialog's Advanced
  codec and simulcast options go. Watching costs a little more CPU on
  devices without VP8 hardware decoding (older iPhones mostly).
  Exception: Safari and other WebKit sharers send one full H.264 copy
  (Implementation notes, "Safari screen share layers").
  **Changed 2026-11-09 (Ryan): Hardware (H.264) is the default.** The
  share dialog has an Encoder choice: Hardware (H.264, one full copy,
  encoded by the graphics card where the browser can) or Software (VP8,
  full copy plus the small one for tiles, encoded on the CPU). The point
  is a gaming PC's CPU: VP8 at 1080p60 competes with the game, the
  graphics card's H.264 encoder doesn't. The cost: tiles download the
  full copy, and a viewer on a weak connection has no smaller copy to
  fall back to. Fixed for the length of a share (greyed out while
  sharing), remembered per device; greyed out where the browser can't
  send it (Hardware without H.264; Standard on WebKit). If the graphics
  card can't, Chromium encodes H.264 in software (OpenH264): Stats says
  which. HW1-HW9 below.
  **Reversed the same day (Ryan): VP8 is the default again**, and the
  options are just "VP8" / "H.264" (hover: what each sends). In Chromium
  "Hardware (H.264)" never reached the graphics card (Implementation
  notes, LiveKit, "Why Hardware (H.264) still encodes in software"), so
  it only cost viewers the small copy. Later, each its own design talk:
  enabling H.264 Baseline/Main in LiveKit's `enabled_codecs` on DEV
  (would iPads still watch?), then a native share helper for the
  desktop app (LiveKit's Rust SDK, NVENC directly, E2EE kept).
  **Share dialog reworked (same day, Ryan):** Quality preset is a template
  list (the five presets plus Custom) that only fills in the fields
  below it: Resolution (720p, 1080p, 1440p, 4K; always 16:9), Frame
  rate (15, 30, 60), Bitrate (a box in Mbps, 0.5 to the server's
  limit, 0.1 steps; counts on Enter or leaving the box), Optimise for
  and Encoder. Editing a field shows Custom unless the values match a
  template again. Templates leave Optimise for and Encoder alone. The
  encoder options are just "Hardware (H.264)" / "Software (VP8)", with
  the explanation on hover (no hint line under it). Choices above the
  server's limit are greyed out, no longer hidden. While sharing, every
  field but Encoder applies at once. The device remembers the fields
  (older saved template numbers still load).
  **Stats trimmed (same day, Ryan):** your own share shows sent / max
  fps, current / max kbps (max: every copy's cap added up), the
  encoder (codec, hardware or software; its name on hover) and frames
  dropped since Stats was turned on (captured but not encoded). Someone
  else's: received fps and kbps, your decoder, frames dropped by the
  decoder or the screen.
- **Clicks (Ryan, 2026-11-05):** one click on a tile opens the big view
  (Watch); one click on a lone share there, or Esc, goes back (to the
  tiles or to chat, wherever you came from). A double click anywhere
  goes fullscreen; the single click waits 250 ms to tell them apart.
- **Hide stops the sound too**; Show Share brings back the picture
  only.
- **Built 2026-11-05:** `CallView` / `PersonTile` in VoiceUI.tsx.
  CV1-CV11, CK1-CK5 passed. CV8 (an Edge sharer at 1080p, desktop
  viewer, `openvoxaVoice.screenStats`): tile 911 kbps at 14 fps, Watch
  3974 kbps at 27 fps, so tiles take the small copy. Its width reads 0
  without the video element passed in.

#### Switch stream

Ryan, 2026-11-06. Change what you share, or its quality, without ending
the share. Before this you stopped and shared again, and viewers' Watch
closed and their Listen reset.

- **In place, not a new share.** The new capture replaces the old one
  inside the published track (LiveKit `replaceTrack`), so viewers keep
  watching: same track, same Watch, same Listen. The old capture is let
  go only once the new one is running, so cancelling the picker changes
  nothing. Checked by experiment first (Implementation notes, "Switching
  a share in place").
- **Where (Ryan: both):** while sharing, the voice bar's share button
  opens the share dialog as "You're sharing your screen": Quality,
  Optimise for, and Close / Stop Sharing / Switch What You Share
  (stopping takes one more click than before). Your own share's tile,
  in the call view and in Watch, has a Switch button that opens the
  picker straight away and keeps the quality.
- **Quality live too (Ryan: include it).** In that dialog, Quality and
  Optimise for apply as soon as they change: the capture is asked for
  the new size, the encoder for the new bitrate and frame rate (both
  layers), and Detail or Motion swaps the content hint and degradation
  preference. Held to the server's limit like a new share.
- **Sound follows the new pick:** swapped in place when both have it,
  taken down or published when only one does. Viewers who were
  listening keep listening (Listen lasts while the person shares). In
  the desktop app a window's sound helper is started for the new window
  before the old one is let go. Server-muted: the new pick is captured
  without sound, and the old source's held sound is dropped.
- **Limit check:** see Implementation notes. LiveKit keeps the size
  declared when the share started, so the server's check doesn't see a
  switch or a quality change. The honest client holds both to the limit;
  a modified client could already under-declare.
- **Code:** `VoiceClient.switchShare`, `setShareQuality`, `#capture`
  (the picker and sound, shared with `startShare`), `shareOptions`;
  `ShareDialog` and `switchFromTile` in VoiceUI.tsx.

#### Speaking indicator

Ryan, 2026-11-04 (ED7): the green ring lagged about a second both ways.
LiveKit's speaker updates (`ActiveSpeakersChanged`) default to every
400 ms, smoothed over 2 updates; `deploy/livekit.yaml` now sets
`audio.update_interval: 200` and `smooth_intervals: 1`. If that is not
enough, the fallback is measuring levels in each client (WebAudio on
every incoming track): near-instant, but CPU per participant.

#### Custom sounds

Discussed with Ryan, 2026-11-04. Stage 1 built and verified the same day
(CS1-CS10); stage 2 (message sound, per-channel mute, cooldown) too
(MS1-MS9, MC1-MC9).

- **Six sounds:** join (you or someone joins your call); leave (leaves or
  drops out, one sound); stream start and stream end (anyone in your
  call, you included, starts or stops screen sharing; leaving mid-share
  plays only leave); mention (unless you're looking at that channel);
  message (a channel you're not viewing gets a new message; stage 2).
- **Where sounds come from:** Kenney's Interface Sounds pack (100 OGG
  files, CC0, unchanged in `client-web/public/sounds/kenney/`, served at
  `/sounds/kenney/` from the embedded bundle; licence note in
  `sounds/README.md`), plus the old WebAudio beeps as "Classic tone".
  Rejected: Ryan's own Pixabay downloads. The Pixabay licence forbids
  distributing files "on a Standalone basis", and a public repository
  hands out the raw files, so it was a grey area; CC0 has none. Also
  dropped: an administrator-uploaded server sound set (Ryan: the server
  ships its defaults, users swap in their own).
- **Defaults** (Ryan's picks by ear): Join Confirmation 1, Leave
  Question 4, Stream Start Maximize 6, Stream End Minimize 6, Mention
  Confirmation 4, Message Classic tone. Volume 60%.
- **Per event, per browser** (Settings > Sounds, `SoundSettings.tsx`,
  `sounds.ts`): on / off, a picker (Kenney grouped by name, Classic, your
  file), Play, Choose file, Reset, volume. Picking or releasing the
  slider plays it. The old "Join and leave sounds" and "Sound when
  someone mentions you" toggles folded in (their old values still
  apply). Nothing syncs across devices (Ryan: browser only).
- **Your own files:** MP3, OGG or WAV, up to 1 MB and 5 seconds, checked
  in the browser (there's no upload). Kept in their own unencrypted
  IndexedDB database, `openvoxa-sounds`, not the account database: a
  sound is a preference like the theme, so "Sign out and erase" leaves
  it, as it leaves the theme.
- **Never silent by accident:** a sound that won't load or decode (a
  browser without Ogg Vorbis, a missing file, which gets index.html)
  falls back to the event's default, then to the Classic tone.
- **Message sound (stage 2):** plays when someone else posts in a text
  channel you aren't looking at. "Looking" means open *and* the tab
  visible and the window focused: a background tab doesn't count
  (Ryan). Client-core emits a `message` ChatEvent for every message
  from someone else (`open` flag); client-web (`ChatApp.tsx`) decides.
- **Cooldown:** first built as "once, then quiet until read"; Ryan
  pointed out that if you're away when the first one lands you never
  hear the rest. Now each channel waits a cooldown after it plays the
  message or mention sound (mentions and DMs have their own fixed
  one-minute limits too: "Direct messages", "Stage 2 as built"):
  Settings > Sounds > Message, "Message
  notification cooldown", None / 1 / 2 (default) / 5 / 10 / 30 minutes /
  until you've read the channel (`sound.message.cooldown`, seconds, -1 =
  until read). Per channel; looking at the channel (opening it, or
  coming back to the window while it's open) ends the wait.
- **No double sound:** a message that mentions you plays only the
  mention sound. The server sends `mention` straight away and
  `channel_activity` from a goroutine, so the order isn't fixed: the
  message sound waits 400 ms and is skipped if a mention for the same
  message id arrived.
- **Away means unread:** `Chat.setLooking` (fed by focus, blur and
  visibilitychange). While not looking, the open channel's new messages
  leave it unread and mentions there get the @ badge, as for any other
  channel; coming back marks it read up to the newest one.
- **Mute Sounds:** bell button in every text channel's header, for every
  account, this browser only (`sound.mutedChannels`, a list of channel
  ids). Muted channels show a crossed-out bell in the sidebar. Muting
  stops only the message sound: mentions still play (agreed, as
  Discord), and the unread dot still shows.
- **Speaker (2026-11-04, SO1-SO7):** sounds follow the Speaker picked in
  Settings > Voice (`voice.output`, read by `sounds.ts` before each
  sound, so no voice code loads). Chromium: `AudioContext.setSinkId`.
  Firefox has `setSinkId` only on media elements, so sounds go through a
  hidden `<audio>` fed by a MediaStreamDestination. A missing speaker
  falls back to the default and is retried on the next sound.
- **Device names (SO0a-SO0c):** browsers hide device names, listing one
  unnamed placeholder per kind, until the page may use the microphone.
  Settings > Voice then shows "Show My Devices", which asks for the mic
  (released straight away) and lists the real devices
  (`VoiceClient.listDevices(true)`); placeholders are filtered out.

### Accounts and administration

#### Stay signed in

Decided by Ryan, 2026-11-04, after ED5 (the desktop app signed him out
on every restart, since closing it is closing the tab).

- **"Stay signed in"** on the login and sign-up page, ticked by default,
  remembered per browser. Ticked: the session and the unlock copy of the
  local data key go in localStorage and survive closing the tab, the
  browser or the desktop app, until the 30-day expiry or sign-out.
  Unticked: sessionStorage, as before (gone when the tab closes).
- **Still locked by the server:** the unlock copy is encrypted under the
  per-session secret the server holds, so signing the session out (here,
  "end other sessions", or from another device) still locks a lost
  laptop's keys.
- **Tabs:** a second tab picks up the stored session but is refused by
  the one-tab-per-account Web Lock, as before; it never signs anyone out.

#### Settings and Server settings

Built 2026-11-03 (step 13, M5 sessions A and B; M5 was split into A
account, B groups and members, C moderation, at Ryan's pick).

- **Settings** is one dialog (`SettingsDialog.tsx`; tabs Account, Voice,
  Chat, Appearance, Sounds). The user-panel gear opens Account without
  loading LiveKit; the voice-bar cog opens Voice.
- **Account:** username and groups; change password (current + new with
  the sign-up checklist; the server signs out every other session and
  says how many); the recovery key (status, Back up now, Set up / Enter
  key, and "Make a new key", which re-uploads this browser's history
  under the new key, so nothing is lost: `RecoverySetup rotating`);
  devices (`GET /devices`, this browser first, with "Sign out and erase";
  removing another one revokes it and members take it out of encrypted
  channels); delete account (type the username and the password,
  `DELETE /me`; the server deletes first, then this browser's keys are
  wiped, so a refusal such as the two-admin floor leaves everything
  intact). Calls that check a password use api.ts `call`, not the
  ApiCall that signs out on any 401, because a 401 there means a wrong
  password.
- **Server settings** is a separate dialog (`ServerSettings.tsx`), so
  personal and server settings stay apart. The gear beside the server
  name shows for staff (any switch); changing groups needs manage_groups.
- **Rank** is edited as a number (Ryan's pick over up/down arrows: it
  matches the server, allows ties, one save per change), with a hint
  naming the groups either side. The dialog mirrors the server's rules
  (rank strictly below yours, only switches you hold, not your own
  groups) as disabled controls with a reason. PATCH sends only changed
  fields, since an untouched switch list on a group holding a switch you
  lack would be refused. Membership changes save on each tick. Lists
  reload on perms_changed.

#### Channel management

Moved forward from M5 at Ryan's request, 2026-11-01.

- Accounts with manage_channels get a "+" beside the Text and Voice
  headings (create dialog: type, name, encryption for text, allow-list
  pre-filled with the server default) and a gear on each channel
  (allow-list, retention, history sharing for encrypted text, delete with
  a second confirmation). force_ptt holders get the gear on voice
  channels for "Require push-to-talk".
- **Encryption is fixed after creation** (renaming came later: "Channel
  menus"): flipping it would strand history or break the promise to
  people who wrote it. Voice is always encrypted, so the
  dialog offers no switch for it.
- Permissions refresh on perms_changed.

#### Channel ordering and categories

Asked for by Ryan and built 2026-11-12 (server `categories.go`, migrations
0040-0041; web client `channelCategories.tsx`). CG1-CG14 and CC1-CC10
pass.

Ryan's calls: Discord-style categories (named folders you can't open or
join), not TeamSpeak-style channels inside channels; one level deep;
**separate Text and Voice sections**, each with its own categories (no
mixed categories); categories are **labels only**, with no permissions of
their own (changed the same day: see "Category permissions" below);
collapsing is **per person**; a category can have a header colour.

- **Order is shared** and changed by dragging (manage_channels): a
  channel above or below another (orange line), onto a category header to
  put it inside (orange box), or onto the section heading to take it back
  to the top level; categories above or below each other. A section shows
  its top-level channels, then its categories. New channels go to the end
  of their place.
- **Moves name a place, not the whole order:** `POST
  /channels/{id}/move` `{category_id, before_id}` and `POST
  /channel-categories/{id}/move` `{before_id}` (null: the end). The server
  renumbers that one scope under an advisory lock (4244), so staff who
  can't see every channel can still reorder: hidden channels keep their
  places. Every change sends `channel_layout_changed` to every socket;
  clients refetch `GET /channels` (now with `category_id`, `position`)
  and `GET /channel-categories`.
- **Schema:** `channel_categories` (kind, name unique per kind ignoring
  case, position, colour); `channels.category_id` + `position`, with a
  composite foreign key on (category_id, kind) so a text channel can't sit
  in a voice category, `ON DELETE SET NULL (category_id)`. The migration
  started everyone at today's alphabetical order.
- **Visibility:** without manage_channels you only get categories holding
  a channel you can see (a staff-only category's name doesn't leak).
  Managers get them all, so they can drop channels into empty ones
  ("Drag channels here.").
- **Categories:** created from the section's + (now a menu: Create
  Channel / Create Category); a hover + on the header creates a channel
  inside (Create Channel also has a Category picker). Right-click: Collapse
  / Expand, Create Channel, Edit Category, Delete Category (greyed without
  manage_channels). Names: 1-32 characters, any case (shown in capitals),
  one line. Delete moves its channels to the end of the top level;
  nothing else is deleted. Create, rename and delete are in the
  moderation log; moves and colour changes aren't (noise, cosmetic).
- **Colour:** header text only, the same for everyone, picked like group
  colours (picker, hex, preview, No Colour) with the same 3:1 contrast
  rule (`checkNameColour`), checked by the dialog and the server.
- **Collapse** is kept per browser (`openvoxa.layout.collapsedCategories`).
  A collapsed category still shows the channel you have open or the call
  you're in, and its header shows the unread dot or @ of what's inside.
- **Drag details:** the row is draggable, not the button (Firefox won't
  drag a button); drags that start inside a row (people in a voice
  roster) are ignored, and voice rows take both kinds of drop, each
  handler ignoring the other's drag type. Mouse and finger drags share one
  set of drop rules (`whereOn`, `land` in `channelCategories.tsx`).
- **Touchscreens** (Ryan, 2026-11-12; TR1-TR9, TT1-TT11 pass). HTML drag
  and drop doesn't work with a finger, so the sidebar's rows (channels,
  category headers, DMs) handle touches themselves (`useMenuTrigger` in
  `ChannelMenu.tsx`): a **tap** acts at once without waiting for the
  browser's click (on a draggable row some touch browsers never sent it:
  the row lit up but didn't open); a **long press** (500 ms) opens the
  menu, which stays open on lifting; a **long press, then moving** the
  finger closes the menu and drags the row (manage_channels): it fades,
  its name follows above the finger, the same orange hints show (target
  found with `elementFromPoint` on `data-drop-key`), and the list scrolls
  near its edges. Moving before the long press is a scroll. The browser's
  own dragging is switched off for touches on pointerdown; the window
  touchmove listener is non-passive only during a press (React's is
  passive, so it can't stop the page scrolling under a held finger).
  The menus also have **Move Up / Move Down** (within the channel's place;
  they keep the menu open, and wait for the refetched layout so a quick
  second tap moves from the new place) and **Move to Category…** (a second
  menu: No Category, then the section's categories; the channel goes to
  the end). Category headers open their menu on a long press too (iPhone
  Safari never turned one into a right-click), with Move Up / Move Down.
- **Category permissions** (Ryan, 2026-11-12; migration 0042,
  `setCategoryAccess` in `categories.go`; CP1-CP7 run 2026-11-12,
  MV1-MV7 and CP11-CP14 pass 2026-11-13, run in headless Chrome with
  DEV test accounts as administrator, moderator and member).
  Ryan: a default permission set for channels, made more specific per
  channel when one needs it. Three levels: the server default (what new
  channels start with), the **category's permissions** (same table as a
  channel's: View/Post or Join/Speak per group), and the channel's, which
  are either **Same as category** or **Custom** (its own; switching to
  Custom starts from a copy of the category's). No mixing per group: no
  deny rules means no precedence question.
  - **Copied, not looked up:** a following channel's permissions are
    copied into its own `channel_access` whenever the category's change or
    it moves (`channels.follows_category`, `category_access`). Every access
    check, voice kick and encryption sweep still reads `channel_access`
    alone and didn't change.
  - **Existing channels started Custom** (nothing changed on upgrade);
    existing and new categories start with the server default. Edit
    Category has a Permissions table and "Make all channels in this
    category use these" (switches the Custom ones). A new channel created
    in a category defaults to Same as category. Category permissions are
    sent to manage_channels only.
  - **Every move to another place asks** (Ryan: permissions are
    important; make the move and its effect clear, even when nothing
    changes): a Move Channel dialog, for drags and Move to Category…, says
    "Move #x from A to B" and offers Use B's permissions (Same as
    category) or Keep its own (Custom), each listing what changes per
    group or "No changes". It starts on what the channel does now.
    Moving to No Category: it keeps its permissions and becomes Custom.
    Reordering within one place doesn't ask. API: `POST
    /channels/{id}/move` takes `keep_access` / `follow_category`; `PUT
    /channels/{id}/access` takes `follow_category`; `PUT
    /channel-categories/{id}/access` `{access, apply_to_all}`.
  - **Deleting a category** leaves its channels Custom with the
    permissions they had: nobody gains or loses access.

#### Server password

Agreed with Ryan 2026-11-05 (SP tests); `httpapi/signup.go`, migration
0029, Server settings, **Sign-Up** tab (administrators). Ryan: stop
anyone who reaches the login page from creating a billion accounts.

- **Modes:** Open (anyone; the default, so existing servers change
  nothing), Server Password (sign-up asks for it; logging in never does,
  so changing it locks nobody out), Closed (no new accounts). The first
  account on an empty server still uses the setup code, whatever the mode.
- **The password** is stored readable (Ryan: admins view, copy and share
  it; it only lets someone create an account), changeable at any time:
  typed (account-password strength rules) or generated, `XXXX-XXXX-XXXX`
  from an alphabet without look-alikes (about 58 bits; accepted in
  lowercase or without dashes). Switching to Server Password with none
  set generates one.
- **Rotation** (Ryan: a leaked password must be lockable): Never, 24 h,
  7 days, 30 days or custom hours. A sweep each minute rotates when due;
  the previous one works for an hour more. Rotate Now and a manual change
  end the old one at once (the leak case). Changing the mode or period
  restarts the clock.
- **Guessing:** checked before the account password is hashed (no argon2
  time spent on wrong guesses); per address, 5 free wrong guesses, then
  locked 1, 5, 15, 60 minutes, each wrong guess after a wait one step up;
  a right guess or a quiet day clears it; wrong guesses are in the server
  log. No server-wide lock: an attacker could lock real people out.
  Rotation plus the per-address lockout make guessing pointless.
- **New-account cap:** 3 per address an hour in every mode, counted only
  when an account is actually made.
- **Moderation log:** mode, period, manual change and Rotate Now.
  Scheduled rotations are not logged (they would fill it).

#### Password rules

Decided with Ryan 2026-11-01, reworked 2026-11-04. Checked when a
password is set (registration, `PUT /api/v1/me/password`), never at
login, so older accounts still sign in. Rules, in order:

1. 12 to 256 characters.
2. Not containing the username.
3. Not a common password, dressed up or not: lower-cased, look-alikes
   like @/0/$ undone, digits and symbols stripped off both ends, so
   `Password12345`, `P@ssw0rd!2024` and `Sunshine2025!` all match. The
   list is the UK NCSC top 100,000 (from HIBP breach data, via SecLists,
   MIT; `common-passwords.LICENSE`), gzipped and embedded (~430 KB),
   loaded on first use (~0.2 s): nothing is sent to a third party.
4. zxcvbn score >= 3 (an estimated 10^8 guesses or more; 4 refused too
   many reasonable passwords, 2 added little).

- **History:** the first rules (2026-11-01) were 3 of the 4 character
  kinds (first all four) plus a rule against passwords mostly made of
  runs like aaa, abc, 321, qwerty. Ryan's reasoning for composition
  rules, from years in IT: without them users pick `password1234` and,
  after a breach, reset to `password2345`. Not what NIST SP 800-63B
  recommends (length plus a breached-password list). On 2026-11-04 zxcvbn
  replaced both: it catches what they were for (keyboard rows, sequences,
  repeats, names, dates, dictionary words with a capital and a digit),
  a long lower-case passphrase like `orange piano kettle sunrise` is now
  allowed, and the `password2345` worry is still covered by the NCSC
  list.
- **zxcvbn runs on the server only** (Ryan chose this over also running
  it in the browser: one implementation, no ~1 MB of word lists for the
  browser, no "page said Strong, server refused"). Go port
  `github.com/trustelem/zxcvbn` v1.0.1 (MIT, faithful port of zxcvbn
  4.4.2, unmaintained since 2019 but the algorithm is fixed). It has no
  hint text, so `strength.go` ports zxcvbn's feedback.coffee (British
  spelling). Only the first 100 characters are scored: 256 characters of
  `aB3$` took ~180 ms, 100 take ~14 ms. Code: `server/internal/password`
  (`Problem`).
- **`POST /api/v1/auth/password-check`** `{password, username}` ->
  `{problem, score, min_score, common, warning, suggestions}`. No session
  (sign-up has none), own per-IP limit (30, then 2/s), nothing stored or
  logged. A common-list hit caps the score at 1 so the meter agrees.
- **Client** (`password.ts` `usePasswordCheck`): length and username
  checked at once; the server asked 300 ms after typing stops; the last
  answer stays on screen meanwhile. Off on the sign-in form, so a
  password being signed in with is never sent to be checked. Only a
  known refusal of the exact password blocks submit; while waiting or if
  the check failed, the server decides on submit.
- **UI** (`PasswordRules.tsx`): checklist "12+ characters / not your
  username / hard to guess", a 4-segment bar (danger colour for Very
  weak/Weak, accent for Fair, save green for Good/Strong) with the label,
  and below it the warning and suggestions while it is not yet hard to
  guess. "Passwords don't match." shows under the confirm field once the
  password itself passes.
- **Changing the password** needs the current one, uses the login rate
  limit, signs out every other session and closes all sockets. There is
  no forgotten-password reset (no email by design); a host command would
  be the natural path if wanted.

#### Palette

client-web default (Ryan, 2026-11-01): background #333333, buttons
#D96932, text #FFFFFF; derived shades are `styles.css` variables. Every
colour stays a variable: users override them per browser in Settings >
Appearance (`appearance.ts`). Light mode later: same orange, black text
instead of white.

### Desktop app

#### Server browser and desktop shell

Ryan's idea, 2026-11-03; design agreed 2026-11-04. A pane of server
icons down the left of the window, like Discord. Each icon is a bookmark
to one OpenVoxa server (`openvoxa.example.com`,
`anotherserver.domain.com`, ...), so people can use any number of
independent hosts without a central platform or having to remember every
address. Each server stays a separate island: accounts, messages and
keys never carry over between servers. No federation; the servers never
talk to each other.

- **Why decided before Electron:** the shell and the server browser are
  one question (where the desktop app gets the web app from), and
  choosing wrongly first would mean redoing logins and storage later.
- **Each server in its own view, loaded from that server.** The desktop
  app draws the icon pane itself; clicking an icon shows that server's
  own web app, from that server's address, in its own isolated view
  (like a browser tab built into the app). Same origin as in a browser,
  so no CORS or login changes; each server's storage (session, device
  keys, archive) is separated by the browser engine; each server serves
  the client version that matches it, so no version skew. Features
  arrive in the desktop app for free. Rejected: one client bundled into
  the app talking to every server's API (CORS, auth rework, one client
  compatible with every server version).
- **Security (built in from day one):** bookmarking a server means
  running its code inside the desktop app, and unlike a browser tab an
  Electron page can be given access to the computer. Each server's view
  gets its own storage partition, the sandbox, `contextIsolation` on and
  `nodeIntegration` off, so it can't touch files, the computer or other
  servers' views. The only bridges are tiny preload APIs whose messages
  the shell checks by sender.
- **Background servers stay connected** (decided): messages arrive live,
  badges and in-page sounds keep working, switching is instant, like
  Discord. An unload after a long idle (say a day) can come later if
  memory demands it. When the app is closed nothing runs.
- **The pane is desktop-only:** browser users keep one server per tab.
- **Voice across servers (planned):** in a call on one server at a time;
  joining voice on server B makes the shell tell server A to leave. The
  global push-to-talk key goes to the server with the call, and that
  server always stays loaded.
- **Also needed (planned):** a server name and icon set by the
  administrator (the bookmark falls back to the address); badges need the
  web client to report counts to the shell (doing nothing in a plain
  browser); adding a server by pasting an HTTPS address, later an
  `openvoxa://` invite link; bookmarks stored only on the device, with
  export / import.
- **Order:** step 1 the shell with the server pane and the security
  setup; step 2 our own screen share picker (Electron shows none); step 3
  per-app share sound. Tray, notifications, auto-update and installers
  later.

#### Desktop screen share picker

Decided with Ryan, 2026-11-04 (desktop step 2).

- **Where:** the pane covers the window while the picker is open, like
  the Add a Server form. The server's page only asks
  (`getDisplayMedia`); what is shared is chosen in the app's own UI,
  never by the page. Only the server on screen may open it, one at a
  time.
- **What:** Screens and Windows tabs, thumbnails refreshed every 2 s,
  app icons on windows. Click to choose, then Share; double-click
  shares at once. A lone screen is chosen for you. Cancel, Escape, a
  click outside the card, or any pane button closes it without
  sharing (like the web client's dialogs).
- **Sound:** Electron offers only "all system sound" (`loopback`), and
  only on Windows. So Share Sound appears when the page asked for
  sound, works for whole screens on Windows, and is greyed out and
  unticked (with the reason) for windows and on other systems. All
  system sound includes the call's own voices, so the others could
  hear themselves back (SD2). Fixed in step 3 with `restrictOwnAudio`
  (RS2, "Per-app share sound"). Minimized windows are left out of
  Edge's picker (RS3); ours very likely too (unchecked). To look at
  with window sound.

#### Per-app share sound (desktop step 3)

Raised by Ryan, 2026-11-04, after SP2; design agreed the same day
(options A-D). Windows 10 2004 or later; older Windows, Mac and Linux
unchanged.

- **The limit is Electron's, not Windows'.** Since Windows 10 2004
  (build 19041) Windows can record one process tree's sound
  (`ActivateAudioInterfaceAsync` with
  `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`), or everything except
  one process tree. Discord's per-app sound works this way.
- **What is sent.** A window share: the sound of the program owning the
  window and everything it starts. A whole-screen share: all sound
  except OpenVoxa's own, so the call never hears itself (the SD2 risk).
- **A. Separate helper program, not an addon.** `openvoxa-audio.exe`
  (Rust, `client-desktop/audio-helper/`, `build-windows.sh` cross-builds
  in Docker; system DLLs only) ships in the app folder. The main process
  starts it when Share is clicked and reads raw PCM from its stdout. A
  crash costs only the share's sound, no rebuild per Electron version.
  About 5-20 ms extra latency, fine for share sound. The helper finds the
  window's process itself (`GetWindowThreadProcessId` on the HWND in the
  source ID).
- **B. Process tree, not the exact process.** Covers nearly every app.
  Apps whose sound comes from an unrelated process (some Store apps,
  games run through a separate launcher): share the screen instead.
- **C. Chromium for screens, so the helper is for windows only.**
  Chromium's `restrictOwnAudio` constraint leaves the app's own sound out
  of a system-sound share. Checked by experiment first (RO1, a throwaway
  Electron 45 app on Ryan's PC recorded its own 1 kHz beep through
  `loopback` without the constraint and not with it). The web client
  always asks for share sound with `restrictOwnAudio: true` (ignored
  where unknown); RS1-RS3: screen share still carries other apps' sound,
  no echo of the call, Edge tab sharing unchanged.
- **D. Share Sound tickbox.** Enabled for windows too where supported
  (build 19041+ and the helper present), ticked by default as for
  screens; greyed out with the reason elsewhere.
- **The page's side.** `viewPreload.ts`, the first preload in server
  views, exposes only `openvoxaDesktop.startShareSound` /
  `stopShareSound`. The main process answers only the server's own main
  frame, once, within 15 s of a window pick with Share Sound ticked: the
  page cannot start a recording, only the user's click in the picker
  can. The PCM goes to the page over IPC (`share-sound:data`);
  `client-web/src/desktopShareSound.ts` turns it into a track through an
  AudioWorklet (40 ms start buffer, drift trimmed above 200 ms) and
  VoiceClient publishes it as ScreenShareAudio (E2EE as usual). The
  helper stops with the share, on leaving, page reload or crash, and when
  the app quits (stdin closes).
- **Tests:** the helper alone through a throwaway Electron app, WH1 (an
  Edge window: `msedge.exe` found from `window:<HWND>:0`, 7.98 s of 8
  received, first sound after about 40 ms, exits when stdin closes), WH2
  (another app's sound stays out), WH3 (a silent window: silence, no
  error); the whole feature WS1-WS7.

#### Desktop updates

Ryan, 2026-11-04 (the user chooses when; one click; a note that features
may not work until they update); design agreed 2026-11-05. The app is in
development and patches will be frequent. Only the shell needs this:
each server serves its own web client, so a refresh already updates
that.

- **Installer:** NSIS from electron-builder, per user and one click
  (like Discord): no administrator prompt, installed in
  `%LOCALAPPDATA%\Programs\OpenVoxa`. App data (bookmarks, server
  sessions and keys) stays in `%APPDATA%\OpenVoxa`, as with the zip, so
  moving from the zip keeps everything. Replaces the zip for Windows.
- **Updater:** electron-updater (`src/updater.ts`). Checks 10 s after
  start and every 4 hours, downloads in the background. Updates are
  differential: the blockmap lets the app fetch only the changed parts
  of the 120 MB installer.
- **Where it looks: a folder on Ryan's server for now** (Ryan's pick over
  GitHub Releases): Caddy serves `deploy/desktop-updates` at
  `/desktop-updates/`. Fast for frequent patches, no GitHub token, and
  update checks reach only a host we run, never a third party (GitHub
  would see every installed app's IP). The address is a build setting,
  so it can move: `client-desktop/update-url.local` (gitignored) or
  `OPENVOXA_UPDATE_URL`, read by `scripts/updateUrl.mjs`; it was in
  package.json until 2026-11-07, moved out so the repo names no server.
- **Installing (Ryan's pick):** a green arrow at the bottom of the pane
  opens "Update Ready" (the new and current version, "Some features may
  not work properly, or at all, until you update.") with **Restart to
  Update** (silent install, the app starts again) and Later. Closing the
  app also installs it (`autoInstallOnAppQuit`). Nothing restarts by
  surprise. Checks continue after a download, so a newer patch replaces
  one still waiting. Errors (offline, server down) go only to
  `%APPDATA%\OpenVoxa\updater.log`.
- **Unsigned for now** (Ryan's pick): the first install shows Windows'
  "Windows protected your PC" (More info > Run anyway); updates
  downloaded by the app normally don't. **Signing will be SignPath
  Foundation** (Ryan, 2026-11-08; free for open-source projects, signed
  under their name), parked for now. It needs the installer built in
  public CI (GitHub Actions) instead of on a maintainer's machine, and SignPath may want
  a more established project first. SmartScreen reputation then
  accumulates on the certificate across versions instead of starting
  from zero per file; EV certificates no longer skip that (2024). Until
  then the login page download link carries a "More info > Run anyway"
  hint.
- **Releasing:** `npm run release:win` in client-desktop bumps the patch
  version, packages, builds the installer, `latest.yml` and blockmap with
  electron-builder in a throwaway container with Wine
  (`scripts/builder.Dockerfile`), and copies them into the update folder,
  `latest.yml` last. The newest 5 versions stay, since an updating app
  fetches its own version's blockmap.
- **Later:** a server saying "this server needs app version X or later"
  (for features that need a newer shell, such as new preload calls).

#### Login page download link

Built 2026-11-08 (`client-web/src/appDownload.tsx`; Ryan's picks).

- **A quiet text link under the login card**, "Get the desktop app for
  Windows", on the main login/register screen only. Clicking it saves
  the installer and shows, under the link: "Downloading <file>. If
  Windows says "Windows protected your PC", choose More info, then Run
  anyway." (the installer is unsigned, see Desktop updates).
- **Only where an app exists for the browser's platform**: Windows
  browsers today, never inside the desktop app (its preload adds
  `window.openvoxaDesktop`). Built as a per-platform table (`APPS`) so
  Android and iOS store links slot in later with their own label and hint.
- **The link follows the newest release by itself**: it reads the
  top-level `path:` line of `/desktop-updates/latest.yml` (the file the
  installed apps check), so nothing in Caddy or the server changes per
  release. A server without an update folder shows no link.
- Tested: DL1-DL6 on the test server; DL7 (the link on the live server after beta.2.1) passed.

#### New version notice

Built 2026-11-09 (`client-web/src/newVersion.ts`; Ryan's picks).

- **Why:** the web client is embedded in the server, so a server update
  brings a new one, but open pages (browser tabs and the desktop app's
  server views alike) keep running the old one until they reload. The
  desktop app's green arrow is only for the shell itself.
- **Detection, no server change:** a server restart drops the event
  socket; on `events_reconnected` the page fetches `/` (no-store) and
  compares the hashed app script it names (`/assets/index-<hash>.js`)
  with its own. Different: a newer client is there. A plain restart
  (same build) shows nothing; a development server (no hashed script)
  never does. The front page is public, so nothing new is exposed.
- **The notice (Ryan's pick over instructions to right-click the server
  icon):** a bar at the top of the main pane, "New features are
  available." with **Reload** (reloads the page, in browsers and the
  desktop app alike) and × (hidden until the next new build).
- **Never during a call** (Ryan's pick): reloading drops voice and screen
  share, so the bar waits until the call ends (gaming first).
- Tested: NV1-NV6 on the test server.

#### Public DNS record follows the IP

Built 2026-11-08 (`deploy/scripts/update-node-ip.sh`).

- **Part of the existing IP cron, not a second job.** After its LiveKit
  check, the script compares the domain's A record on Cloudflare with
  the public IP and fixes the address when they differ. One IP lookup,
  one log (`~/openvoxa-node-ip.log`), one cron line from `setup.sh`.
- **Reuses Caddy's Cloudflare token** (DNS: Edit and Zone: Read already
  cover it): no new secret. The token goes to curl on stdin, never on
  the command line (other users can read the process list).
- **Only an existing A record, only its address.** Never creates a
  record (a LAN server must never get a public one; see deploy/README.md
  "Private IPs need local DNS"), leaves the proxy and TTL alone, and
  leaves names with several A records alone. Runs only while
  `LIVEKIT_NODE_IP` is public, like the LiveKit part.
- **The record is checked every run** (two or three API reads per 5
  minutes, well under Cloudflare's limits) instead of only when the IP
  changes, so a failed update is retried and a hand edit gets corrected.
- No `jq` on Debian by default, so the JSON is read with `grep`/`sed`
  (shapes checked against the live API).
- Tested 2026-11-08 against the live zone with the test server's token: correct
  record, missing record, unknown zone and LAN-only change nothing;
  DD1, a temporary `ddns-test` A record at 192.0.2.1, moved to the
  public IP with proxy and TTL kept, a second run silent, then deleted.

#### Server name and icon

Decided with Ryan, 2026-11-07; built the same day (desktop 0.1.9).

- **Where set:** Server settings, General (first tab, administrators
  only): Server Name (up to 40 characters, empty = none) and Server
  Icon (Upload/Change Icon, Remove Icon), both saved with Save. Each
  change goes in the moderation log (`set_server_name`,
  `set_server_icon`, `remove_server_icon`).
- **Where shown:** the desktop pane (icon in the 48 px circle, else the
  first letter of the name, else of the address; hover shows "name
  (address)"), the browser tab title and favicon, and the sign-in pages.
  **Sign-in branding (Ryan):** the icon (96 px circle) and the server
  name as the largest text, with "OpenVoxa" small under it; without a
  name, "OpenVoxa" as before. A wide banner on the sign-in page comes
  with the Home page stage (same upload).
- **Missed events:** the saving page updates itself and nudges its
  desktop shell directly, not only through `server_info_changed`; and
  when the event socket reconnects, `events_reconnected` refetches what
  server-wide events would have changed (server info, stickers, name
  colours, own permissions). Found by SI9: an icon removed while the
  desktop page's socket was reconnecting stuck until a reload.
- **Crop tool (Ryan's pick over an automatic centre crop):** drag, zoom
  (slider, wheel, +/-) and arrow keys, under a circle showing what the
  pane keeps; the picture always covers the square. The browser draws
  the square to a 256 x 256 canvas and uploads WebP (PNG where it can't
  write WebP). Accepts PNG, JPEG, WebP or GIF (first frame) as input.
- **Server:** `server_settings` columns (migration 0033): the icon is
  small, so its bytes live in the row, not the blob store. Public
  `GET /api/v1/server-info` (`{name, icon}`, icon a path with
  `?v=<icon_version>`) and `GET /api/v1/server-icon` (nosniff, sandbox
  CSP, immutable only for the current version). Admin: `PUT
  /api/v1/server-info/name`, `PUT`/`DELETE /api/v1/server-icon` (raw
  body, PNG or WebP by magic bytes, square, at most 1024 px and 512 KB).
  Changes send `server_info_changed` to every socket.
- **Desktop security:** the shell fetches the info itself (on each view
  load, and when the page nudges it via `serverInfoChanged()` in
  `viewPreload.ts`, which carries no data), accepts only an icon path on
  that server, checks PNG/WebP by magic bytes and size, and gives the
  pane a `data:` URL; name, icon and `iconSrc` are kept in
  `servers.json` so offline servers keep their icon.

#### Home page and community rules

Decided with Ryan, 2026-11-07 (two design talks); built the same day
(HP1-HP18 passed).

- **What:** a Home item at the top of the channel list (server icon and
  name) opens a page with an optional wide **banner**, a **Welcome**
  text and a separate **Rules** section (its own heading). Both texts
  use the same markdown as messages (#channel links work). Not
  encrypted. Edited in Server settings, General (administrators).
- **Landing:** you land on Home on first visit and whenever an
  administrator has changed it since you last saw it (a dot on Home
  until seen; seen is per account, on the server, so it follows you
  across devices); otherwise where you left off. A change made while
  you're signed in shows the dot, it doesn't pull you away.
- **News** goes in a read-only #announcements channel (channel access
  already allows view without post), not on Home.
- **Members only**, except the banner: the banner also shows at the top
  of the sign-in page (always, when set; Ryan wants branding there).
- **Banner shape (Ryan: not one fixed ratio):** the crop tool offers
  16:9, 2:1, 3:1, 4:1 and the whole picture; the banner shows at the
  chosen shape. The server accepts anything from 16:9 (tallest) to 4:1
  (thinnest), so a tall photo can't push Home or the sign-in card off
  the screen. Uploaded as WebP (PNG fallback), 1600 px wide.
- **Community rules** (server option "Require everyone to accept the
  rules", needs rules text): an account that hasn't accepted the
  current rules can do **nothing** until it does. After signing in it
  sees only the banner, the rules, and Accept / Sign out; the server
  refuses everything else (the two-factor setup hold's pattern: a
  short allowlist, error code `rules_acceptance_required`). New
  accounts meet it right after creating the account. The order at
  sign-in is two-factor setup, then rules, then recovery screens.
- **Changed rules:** the administrator chooses per save. When the rules
  text changed and enforcement is on, a checkbox (off by default) "Ask
  everyone to accept the changed rules". Typo fixes bother nobody. The
  administrator who saves counts as having accepted.
- **Mid-session:** turning enforcement on, or saving with "ask everyone
  again", takes effect at once: affected accounts' sockets are closed
  and they're removed from voice calls; their app then shows the rules
  screen. One click puts them back. The "ask everyone" checkbox carries
  a bold red warning saying so (Ryan, HP14), and so does "Require
  everyone to accept the rules" while it is off (HP15). Emptying the
  rules unticks and greys out the enforcement box (saving then turns
  enforcement off); typing rules back restores the tick (HP16-HP18).
- **Server:** `home.go`, migration 0034 (`server_settings` home_* /
  rules_* / banner* columns; `users.home_seen_version`,
  `users.rules_accepted_version`). `GET /api/v1/home`, `POST
  /home/seen`, `POST /home/accept-rules` (a stale version gets 409),
  admin `PUT /home`; public `GET /server-banner` (bytes in the row,
  like the icon), admin `PUT`/`DELETE`; server info gains `banner`.
  Event `home_changed`. The hold sits in `requireAuth` after the
  two-factor hold (`rulesHoldAllowed`); the client's `accountGate`
  reloads into either screen. Log actions `set_home`, `enforce_rules`,
  `ask_rules_again`, `set_server_banner`, `remove_server_banner`.

### Planned: server icons, updates, bug reports, channel menus, avatars

Ryan's list, 2026-11-04. Recorded, not designed in detail yet: each gets
a design talk before it is built. Recommendations below are Claude's.
Device linking and two-factor sign-in were planned in step 13 and are
at the end.

- **Server icon in the pane.** The administrator uploads an icon in
  Server settings (with the server name); the pane shows it in place
  of the letter, same 48 px circle, same hover and selected look; no
  icon means the letter, as now. Recommended: an unauthenticated
  `GET /api/v1/server-info` (name, icon URL) that the shell fetches,
  since the pane must show icons before anyone signs in. The shell
  accepts PNG, JPEG or WebP only (no SVG: it can carry script), checks
  the size, and hands the pane a `data:` URL, so the pane never loads
  anything from a server. Open: size limits; a square crop tool or
  centre crop.
- **Updates.** Built 2026-11-05: "Desktop updates" above. The original
  notes: two parts update separately. The web client already
  updates itself: each server serves its own, so a refresh picks it up.
  Only the desktop shell needs an updater. Ryan: the user chooses when
  to update, with a note like "Some features may not work properly, or
  at all, until you update", but updating must be easy (one click).
  Recommended: electron-updater checking GitHub Releases; the app
  downloads in the background and shows the note with "Restart to
  Update". Needs an installer (NSIS) instead of the zip, and ideally
  code signing (otherwise Windows warns on every install). Open:
  signing (cost), how often to check, whether a server can say "this
  server needs app version X or later".
- **Bug reports.** Ryan is one person and can't test everything, so
  users need an easy way to report bugs. Open: where reports go. Each
  server is an island, but client bugs belong to the OpenVoxa project,
  not the server's administrator. Options: (a) GitHub Issues (public,
  needs a GitHub account; a "Report a Bug" button opens a prefilled
  issue with app and server version), (b) in-app form sent to the
  server's administrator (like message reports, but they are not the
  developer), (c) both: admin first, who forwards. Whatever is
  chosen, a report must never include message content or keys without
  the user seeing it first.
  - **Decided with Ryan, 2026-11-06: (c), administrators first.** About's
    Report a Bug opens an in-app form (what went wrong, plus the Copy
    Debug Info rows, shown before sending) that goes to the server's
    administrators, in a Server settings tab like Reports. Each report
    there has Send to GitHub, opening a prefilled OpenVoxa issue for real
    client bugs. Friends need no GitHub account and nothing is public
    until an administrator forwards it. Built after QR login (Ryan).
  - **Changed and settled with Ryan, 2026-11-06:** bug reports stay in
    the server: holders of **View reports** (moderators and
    administrators) see and handle them (Close, Reopen, Delete), but
    **only administrators Send to GitHub**, and users have no GitHub
    path. The administrator set the server up and knows its
    infrastructure, so they decide what reaches the project.
    - Form: one box, "What went wrong?", plus the Copy Debug Info rows
      shown in full with "Include debug info" (ticked by default).
    - Send to GitHub opens a new OpenVoxa issue in the administrator's
      browser, prefilled with the text and debug info, without the
      reporter's name or the server address; they edit and submit it
      on GitHub with their own account. The report gets a "Sent to
      GitHub" tag.
    - The same people see an open-report count badge (like message
      reports); no pop-ups, no sound. Send to GitHub is greyed for
      moderators.
    - Open / Closed (Close, Reopen), deleted by hand. The reporter is
      not told anything further.
- **Channel menus** (agreed with Ryan 2026-11-05, built the same day,
  CM1-CM9; `ChannelMenu.tsx`). Right-click a channel in the sidebar,
  or long-press it (500 ms) on a touchscreen. Text: Mark as Read (greyed
  when nothing is unread), Mute Sounds / Unmute Sounds, Rename Channel,
  Channel Settings, Delete Channel. Voice: Join Call or Leave Call,
  Rename Channel, Channel Settings, Delete Channel. Rename and Delete
  need manage_channels; Settings what the gear needs; greyed out
  otherwise. Rename and Delete open Channel Settings (name field
  selected; delete confirmation showing), so there is one place for
  each. The gear stays. No Mute Sounds on voice: no message sounds
  there. Copy Channel Link added with channel links (2026-11-06).
  - **Rename** (Ryan asked; the old "fixed after creation" was only for
    want of an endpoint). `PATCH /api/v1/channels/{id}/name`,
    manage_channels, same rules as creation, 409 when taken, then
    `channel_changed` so every list and open header updates. Safe any
    time: messages, MLS groups, the LiveKit room, access and read
    markers are keyed by id.
  - **Moderation log** (Ryan, 2026-11-05, ML tests): creating, renaming
    and deleting a channel are logged (`create_channel`,
    `rename_channel`, `delete_channel`), in the same transaction as the
    change, with a readable detail ("#general (text, encrypted)",
    "#old to #new") because the row may be gone later. Who may read the
    log is unchanged: moderators (ban, view reports, delete messages or
    server mute), not Manage channels alone. Settings changes (access,
    retention, history sharing, forced push-to-talk) are not logged.
- **User avatars and profiles** (agreed with Ryan 2026-11-09; not built).
  Two stages, each with its own test IDs (AV, then PR).
  - *Stage 1, avatars.* A new Profile tab in Settings: upload, crop to
    a circle, shrunk to 256 x 256 in the browser (the server icon's
    cropper). PNG or WebP, static only (animated: skipped for now). Per
    server (islands). Visible to everyone on the server, so not end-to-end
    encrypted (like usernames), but sealed under the account key so
    account deletion shreds it in backups too. Moderators can remove one
    (moderation log). Shown wherever a letter circle is now (voice tiles,
    voice member list, DMs, the profile card) and beside messages: one
    avatar per run of consecutive messages from the same person.
  - *Stage 1 as built* (2026-11-09, AV1-AV12). Server `avatars.go`,
    migration 0037: table `user_avatars` (one row per account, deleted
    with it), the bytes sealed under the account key (context
    `openvoxa/avatar/v1`), `version` from a sequence so a removed and
    re-added picture never reuses a cached URL. Routes, all signed in:
    `GET /api/v1/avatars` (`{users: {id: version}}`), `GET
    /api/v1/avatars/{id}?v=N` (nosniff, sandbox CSP, private immutable
    cache for the current version), `PUT`/`DELETE /api/v1/me/avatar` (raw
    body; PNG or WebP by magic bytes, square, at most 1024 px and 512 KB,
    APNG and animated WebP refused). Moderators: `DELETE
    /api/v1/avatars/{id}` needs `delete_messages` and, like a ban, a rank
    above the owner's; logged as `remove_avatar`. Every change sends
    `avatars_changed {user_id, version|null}` to every socket; a
    reconnected socket refetches the list. Web client: `avatars.tsx`
    (list plus a blob: URL per version, fetched with the token like
    stickers; `<Avatar>` falls back to the letter), Settings > Profile
    (`ProfileSettings.tsx`, the server icon's `Cropper` with shape
    `avatar`; saved as soon as cropped, as Settings has no Save), Remove
    Avatar in the name menu for moderators. Messages: a 40 px circle at
    the left of each non-compact message (the run's first), clickable
    like the name; hidden under 640 px wide. Deleted accounts show a
    blank "?" circle.
  - *Stage 2, profile card.* Clicking a name opens a card in place of
    today's name menu: avatar, name in its colour, groups, bio, custom
    status, "Joined <date>" (`users.created_at`), last seen, then Message
    and Block (moderators also Remove Avatar / Clear Bio). Bio: plain
    text, about 300 characters, links and emoji, sealed like the avatar.
    Last seen is new per-account state: "Online now" while the events
    socket is open; otherwise coarse ("Today", "Yesterday", "4 days
    ago"), never an exact time. A Profile setting "Show when I was last
    online" (default on) hides it both ways when off.
  - *Stage 2a as built* (2026-11-10, PR1-PR11 pass 2026-11-11; custom
    status is stage 2b, ST). Ryan's calls: split card and status; voice
    menus keep their controls and gain a View Profile button beside
    Message; last seen follows the same rule for staff; the card is a
    pop-up at the click, not a dialog. Server `profiles.go`, migration
    0038: table `user_profiles` (one row per account, cascades): `bio`
    sealed under the account key (context `openvoxa/bio/v1`; at most 300
    characters and 8 lines; control and bidi-override characters dropped,
    runs of blank lines squashed, `normaliseBio`), `show_last_seen`,
    `last_seen_on` (a UTC **date only**, never a time, so nothing finer
    can be read out of it; written when an events socket opens and
    closes; erased and not recorded while the setting is off). "Online
    now" is `hub.Online` (any socket open). Routes: `GET
    /api/v1/users/{id}/profile` (groups without Everyone, joined date,
    bio, last seen only when both sides show theirs), `GET`/`PATCH
    /api/v1/me/profile`, `DELETE /api/v1/users/{id}/bio` (delete_messages,
    rank above the owner, logged `clear_bio`). No live event: the card is
    fetched each time it opens. Web client: `profiles.tsx` (`ProfileCard`
    replaces the name menu; your own name opens it too, with Edit
    Profile), Settings > Profile gains Bio (Save bottom left; the tab
    draws its own body and footer) and "Show when I was last online".
  - *Custom status* (stage 2). An optional emoji plus up to 60
    characters. Set in the Profile tab and from a "Set Status" item on
    your own name. Shown on the profile card and in small grey text
    under the name in the voice member list. "Clear after": Never,
    1 hour, 4 hours, Today (local midnight); the server clears it when
    it expires. Changes reach everyone live (like the server name).
    Sealed like the bio; moderators can clear it (moderation log). No
    automatic "Playing X" game detection (it would mean the desktop app
    watching running programs).
  - *Stage 2b as built* (2026-11-11, ST1-ST12 pass 2026-11-12). Ryan's
    calls: Set Status is a small dialog (emoji button, text with a
    60-character counter, Clear after; Save green bottom left, Clear
    Status, Cancel); the Profile tab has one Save for status and bio;
    your own status is a grey line in the user panel (click opens Set
    Status; nothing shown when none). Server `statuses.go`, migration
    0039: `user_profiles.status` (JSON `{emoji, text}` sealed under the
    account key, context `openvoxa/status/v1`) and `status_expires_at`.
    Text: one line, whitespace squashed, control and bidi-override
    characters dropped (shared with the bio), at most 60 characters.
    Emoji: one emoji as the picker gives it (no letters, spaces or
    plain ASCII except keycaps; 16 code points / 64 bytes). "Clear
    after" is worked out by the browser (it knows the time zone; Today =
    next local midnight) and sent as a time, at most 48 hours ahead.
    Routes: `GET /api/v1/statuses` (everyone's live ones, anyone signed
    in), status in `GET`/`PATCH /api/v1/me/profile`, `DELETE
    /api/v1/users/{id}/status` (same rule as Clear Bio, logged
    `clear_status`; `clearProfileField` serves both). Every change and
    clear goes to every socket as `status_changed`; `StartStatusSweep`
    clears expired ones every minute and sends the event. Web client
    `statuses.tsx` (store, `StatusLine`, `StatusFields`,
    `SetStatusDialog`): shown on the card, under names in voice
    channels (in and out of the call) and in the user panel.
  - *Not doing:* display names separate from usernames (usernames stay
    the only name), animated avatars, pronouns.
- **About tab in Settings** (agreed with Ryan 2026-11-05; built the
  same day, AB1-AB8). The last tab of Settings, in each server's web
  client, so it works in browsers too (`AboutSettings.tsx`). Sections:
  *OpenVoxa* (description, AGPL-3.0, GitHub link); *This Server*
  (address, your account and groups, and for staff only the version:
  commit, commit date, "+ local changes" when built from uncommitted
  source; an exact version tells an attacker which known bugs apply);
  *This App* (the web client's bundle build id, public anyway, which
  shows whether a refresh picked up a new build; in a browser its name,
  in the desktop app the app, Electron, Chromium and OS versions via a
  read-only `appInfo` call in the view preload); *Connection*
  (bandwidth, in a call or not, how long the chat connection has been
  up). Buttons: Copy Debug Info (the same rows as text, plus the user
  agent) and a greyed-out Report a Bug until bug reports exist.
  - **Bandwidth** (Ryan: "how much bandwidth is being used by OpenVoxa
    at that time, up and down"). One up and one down figure, every
    second: the call (WebRTC transport totals, all peer connections),
    both chat websockets (every frame, `client-core/src/traffic.ts`)
    and HTTP (request bodies up; resource timing `transferSize` down,
    same origin only, 0 for cached). A page sees only its own traffic,
    so it is per server; Ryan: only the server you're connected to
    matters for now. Not counted: LiveKit's signalling websocket
    (small), request headers going up.
  - **Server version:** the Docker build's `version` stage reads git
    from a second build context (`additional_contexts: gitdir: ../.git`
    in compose; `.git` stays out of the main context) and writes
    `/openvoxa-version.json`, copied into the final image. Only that
    stage reruns on a new commit. `GET /api/v1/version` (staff) serves
    it; a server built without it says "unknown".
- **Device linking by QR** (planned in step 13, after M1): a logged-in
  device shows a QR of `https://server/link#<one-time secret>` (about 2
  minutes, single use); the phone's camera opens it; the server only
  relays encrypted messages; the old device approves the login and hands
  over the backup key. The typed recovery key is the fallback.
- **Two-factor sign-in:** TOTP only (authenticator apps, RFC 6238) plus
  one-time backup codes. No SMS, email or third-party service.
- **Decided with Ryan, 2026-11-06** (both "huge, we'll want those"):
  - **Two-factor first**, then QR linking (reversing the step 13
    order), so linking knows from the start that it stands in for the
    code.
  - **Optional, and an administrator can require it:** anyone can turn
    it on in Settings; a Server settings switch requires it for staff
    or for everyone, and those people set it up at their next sign-in.
  - **Lost phone and backup codes:** an administrator removes the
    person's two-factor in Server settings > Members (logged in the
    moderation log); a host command covers an administrator locked out
    themselves.
  - **QR login skips the password and the code, after a confirm:** the
    signed-in device asks "Sign in as <name> on this device?" and the
    new one needs nothing typed (like Discord). The QR lasts about 2
    minutes and works once, and it also hands over the recovery key, so
    history comes along.
  - **Details settled with Ryan, 2026-11-06:**
    - No "remember this device": every password sign-in asks for the
      code. "Stay signed in" (30 days) already makes that rare.
    - 10 backup codes (like `4f9k-27xm`), each single use; making new
      ones cancels the old. Turning two-factor off or making new codes
      asks for a current code.
    - The "Require two-factor: Off / Staff / Everyone" switch lives in a
      new Server settings tab, Security (administrators only). Staff =
      holds any permission switch.
    - People it covers who are already signed in set it up **right
      away**: their app shows the setup screen on its next load and
      nothing else works until it's done.
    - The desktop app needs nothing of its own (the web client runs in
      its server view).
    - Setup: QR of the `otpauth://` address plus the secret as text,
      confirmed with one code before it is switched on. A code works
      once (no replay within its 30 s window).
  - **QR login settled with Ryan, 2026-11-06** (all three as
    recommended):
    - **The signed-in device shows the QR.** Settings > Account, "Sign
      In on Another Device": a QR of a one-time link
      `https://<server>/#signin=<id>.<secret>`, 2 minutes, single use.
      The phone's own camera app opens it in the browser; no camera code.
      The signed-in device then asks "Sign in as <name> on <device>?"
      (Approve / Deny). Not the Discord way round (login screen shows
      the QR): that needs a phone already signed in and is the
      well-known QR phishing route (a scammer sends you their QR).
    - **No camera: Copy Link + paste box.** Copy Link sits by the QR;
      the login page has "Sign in with a link" to paste it into. The
      desktop app needs nothing of its own (its server view is the web
      client).
    - **The new device's storage is locked by a server-held device
      secret**, since it never gets the password: a random secret per
      device keyring, released only to a signed-in session of the same
      account. Anyone with the files still has to sign in (two-factor
      included); the server holds half of the lock, as it already does
      while you're signed in. Sign-out keeps the device as usual. A
      later password sign-in there adds a password keyring **beside**
      the device one (both open the same data key), so alternating
      password and QR sign-ins never sets the browser up again. A QR
      sign-in on a browser that holds the account under the password
      only cannot open it: that browser starts over as a new device
      (history from the handover). "Sign out and erase" deletes the
      server's secret too.
    - **The secret in the link never reaches the server** (it is in the
      `#` part). The recovery handover (backup id and backup key, not
      the 12 words: a signed-in device only keeps the key) is encrypted
      under a key derived from it, so the server relays it blind. The
      server makes the session; the QR stands in for both the password
      and the two-factor code, since the approving device passed both.

### Planned: picture-in-picture for streams

Agreed with Ryan 2026-11-11; built the same day (`client-web/src/pip.ts`),
PP1-PP10 pass (desktop app watching a Chrome share); the Firefox
greyed-out button is untested.

- **What:** a floating, always-on-top window showing the screen share
  you're watching, so you can keep watching over other apps (borderless
  or windowed games; nothing can draw over exclusive fullscreen).
- **Video PiP, not Document PiP** (changed after the experiment, Ryan's
  pick): the browser's own PiP window for one `<video>`, with **Mute and
  Leave** from the Media Session API (`togglemicrophone`, `hangup`;
  Chromium's video-call PiP buttons). The same everywhere: desktop app,
  Chrome, Edge, Safari. Firefox has no PiP API, so the button is greyed
  out. The agreed design was Document PiP (our own HTML: stream plus
  Mute/Deafen/Leave), but Electron doesn't implement it (Implementation
  notes, Electron, "Picture-in-picture"). No Deafen in the window for
  now; revisit if Electron gains Document PiP.
- **Opened only by a PiP button** on share tiles (call view and Watch
  view), beside Fullscreen; "Close PiP" (filled) while open. Never
  automatic (Ryan: visually invasive; the user should choose it). One
  PiP at a time: PiP on another share moves it there.
- **Closes** with the window's X (or back-to-tab), Close PiP, the share
  ending, or leaving the call. **Stays open** when switching channels or
  going back to chat: the video is our own element outside React.
- **Mic button** follows the voice bar's mute button: shown only when
  that one works (hidden when server-muted or in push-to-talk, forced or
  chosen); shown off while muted or deafened, and turning it on
  undeafens, as the voice bar does.
- **Quality:** LiveKit's adaptiveStream picks the layer from the
  element's size *in the page*, not the PiP window's, so the hidden
  element follows the PiP window's size (`resize` on the
  PictureInPictureWindow). It sits invisible (opacity 0) inside the
  viewport: off screen, adaptiveStream would count it hidden and pause
  the video before PiP opens. Once in PiP, livekit-client 2.23 counts it
  visible even when the app is minimised (`isElementInPiP`).

### Planned: replies, links and code blocks

Decided with Ryan, 2026-11-06 (all as recommended). Related: a reply
jumps to its original through a message link, and all three change how
messages are written and drawn (`markdown.tsx`). Built in three stages,
one session each, in this order:

1. **Code blocks with a language.** The fence's language ("```go") is
   kept and shown on the block, with a Copy button and syntax colouring
   by **lowlight** (highlight.js's engine producing a syntax tree, so
   React elements, never HTML strings: bodies are untrusted; Feature
   decisions, "Markdown"). About 35 common languages, loaded lazily the
   first time a block with a language is drawn; unknown languages show
   the label, uncoloured. Token colours are theme variables in
   `styles.css` (so `appearance.ts` overrides work). The composer gets a
   Code button that wraps the selection (or an empty line) in ```
   fences. To settle while building: the exact language list and the
   bundle size (report it to Ryan).

   **Built 2026-11-06, CB1-CB8 pass.** Settled: 37 languages
   (`codeHighlight.ts`: lowlight's "common" set minus arduino, vbnet and
   wasm, plus dockerfile, nginx and powershell; aliases such as js, sh,
   yml, html, toml, ps1 work). The highlighter is its own chunk, 155 KB
   (50 KB gzipped), loaded on the first block with a language; the main
   bundle is unchanged. Every fenced block gets the bar (label if any,
   Copy). Token colours are ten `--code-*` variables, each at least
   4.5:1 on `--input`; not in Settings > Appearance (clutter). Added
   while building (CB6-CB7): Enter inside a code block (odd number of ```
   before the caret) starts a new line instead of sending or saving.
2. **Channel and message links.** Addresses in the URL fragment, so the
   server needs no routes and nothing is sent to it:
   `https://<server>/#/c/<channel id>` and `.../#/c/<channel id>/<message
   id>` (ids, so renames don't break links). Copy Link in the channel
   menu (replacing the waiting placeholder) and on each message.
   Opening one goes there (browser or desktop app; the fragment is
   cleared afterwards, like `#signin=`). In chat, a link to this server
   shows as a clickable **#general** chip (message links: "#general >
   message") that navigates in-app instead of reloading; a channel you
   can't see shows as a greyed "#unknown-channel". Typing # in the
   composer suggests channels and inserts the link address (portable,
   and it reads as a link anywhere). To settle while building: a
   message link to a message that isn't loaded uses the same "load
   older until found" as reply jumps.

   **Built 2026-11-06, LK1-LK9 pass** (`client-web/src/links.ts`; chips
   in `markdown.tsx`; jump in `ChannelPane.tsx` MessageList). Settled:
   Ryan renamed the action: **Copy Channel Link** (channel menu, text
   channels only: opening a voice link would mean joining a call) and
   **Copy Message Link** (message hover bar), since "Copy Link" read
   like copying a web address. A jump loads up to 20 older pages (1,000
   messages), centres the message and highlights it for 2 s
   (`.msg.jumped`); otherwise a channel notice says why (deleted, older
   than the channel keeps, before this device could read it, or too far
   back). A link to a channel you can't see, opened or clicked, leaves a
   notice. A link the page was opened with waits through sign-in;
   `hashchange` follows links pasted into the same tab. Own links get
   no link preview. The # list shares one `useSuggestions` with the @
   list; it needs "#" to start a word (so "C#" and URLs don't trigger).
   Known limits: a link opened in a new browser tab while another tab
   holds the account hits the one-tab lock; in the desktop app a link to
   a different added server opens in the browser rather than switching
   (would need a desktop release).
3. **Replies.** A Reply action on each message; a bar above the
   composer ("Replying to staff", preview, cancel, and an @ on/off
   toggle, on by default). The sent message shows the original's
   author and first line above it; clicking jumps there, loading older
   history page by page (bounded) and saying so when the original is
   gone (deleted, or older than the channel keeps). The reference (the
   original's id and author) and the preview line travel **inside the
   message body**, so it works in encrypted channels and for people who
   joined after the original; the server never parses it. The @ toggle
   adds the original's author to the message's mentions, which the
   server already delivers as notifications. To settle while building:
   the body format (a first-line token like stickers'), and what older
   clients show.

   **Built 2026-11-06, RP1-RP11 pass** (`client-core/src/replies.ts`;
   UI in `ChannelPane.tsx`). Settled with Ryan: the body's first line is
   a token, `[reply:<message id>:<author id>:<name>] <preview>`, then the
   reply (chosen over a quote holding a message link, which breaks if
   the server's address changes). A browser tab not yet refreshed shows
   that line raw; every client is served by the server, so that lasts
   until a refresh. Chat splits it off (`ChatMessage.text` is the reply
   alone, `.reply` the reference); send() and edit() put it back, and an
   edit keeps the author's mention if the reply had it. The preview is
   the original's first line with words (code fences and a quote marker
   skipped), at most 100 characters; "Sticker", "Attachment" or "N
   attachments" when there's no text. Shown **live** when the original
   is loaded (edits; "Original message deleted"), else the saved
   preview. Also settled: Reply sits after React in the hover bar, not
   on pending, deleted, unreadable or deleted-account messages; @ is
   greyed and off for your own message; GIFs and stickers sent while
   replying are replies; Esc or × cancels, switching channel clears it;
   a reply always gets its name header (never compact). Reports send
   the body with its token (plain channels compare it with the stored
   body) and Server settings > Reports shows "Replying to …" above it.
   A sticker reply can't be edited, like any sticker (Ryan: leave it).

### Planned: installable web app (PWA)

Decided with Ryan, 2026-11-12 (all as recommended; Feature roadmap, 1).
Built 2026-11-13 (server `pwa.go`, `client-web/public/sw.js`,
`client-web/src/install.tsx`). Headless Chrome on DEV: installable with
no errors, the shell cached, the page loads offline.

*Tests (PW1-PW10).* Run 2026-11-13 in headless Chrome with DEV test
accounts: **PW2** installed (standalone) shows Install App greyed,
"already installed"; **PW3** after the prompt, or where Chrome doesn't
offer one, greyed with the menu tooltip; **PW4** same path as Firefox
(no install event); **PW6** a rebuild brings "New features are
available." within 30 s, the reload runs the new build and the worker
drops the old build's files; **PW7** offline, and during a server
restart (Caddy's 502), a reload shows "Can't reach the server" and loads
by itself once it's back, still signed in. Also passed: the button in
About and on the sign-in page, the iPhone hint (iPhone user agent), and
no button or service worker when the desktop app's bridge is present.
Still for real devices: **PW1** Chrome's install dialog on Windows,
**PW5** the desktop app itself, **PW8** Android install and icon,
**PW9** iPhone Add to Home Screen and icon, **PW10** uninstall, then
Install App enabled again.

*Found while testing, fixed:* a reload with no connection signed the
user out ("Sign in again to unlock…"): the unlock secret couldn't be
fetched, and any failure counted as "session ended". Unreachable (no
network, or 502/503/504 from the proxy) now shows "Can't reach the
server" (`App.tsx`, phase `offline`) and tries again on a growing delay
(2 s up to 30 s) and when the browser says it's back online; only a
real answer from the server signs out. Before the service worker this
only happened on a reload during a server restart. And the worker now
serves the cached app instead of the proxy's 502 page while the server
restarts.
Lets people install a server's web client as an app on phones and
desktops (its own window and home-screen icon), without the desktop app.

- **Scope:** installing and caching the app shell (the built JS, CSS,
  fonts, sounds) only. No API responses, messages or attachments are
  ever cached, encrypted or not. Offline shows the app's normal
  "reconnecting" state. Web Push comes later with roadmap item 7.
- **Name and icon per server:** the server serves the manifest itself
  (`/manifest.webmanifest`, built per request from the server name and
  icon in Server settings), so each server installs as its own app.
  Without a server icon: the OpenVoxa icon (Ryan's PNG, 2026-11-12),
  shipped as 192 and 512 px PNGs plus a maskable version (padded on the
  dark hexagon colour, because Android crops icons to its own shape).
  *Settled while building:* the server converts the stored icon (WebP
  or PNG) to PNG on request, at 192 and 512 px for the manifest
  (`/api/v1/app-icon?size=&v=`, cached for good per icon version) and
  180 px on the app colour for Safari (`/apple-touch-icon.png`, where
  iOS looks for it anyway; it shows transparency as black). PNG is the
  one format every launcher takes, and it needs no second upload or
  migration. Decoding WebP needs `golang.org/x/image` (the Go team's
  image package: WebP decoder and scaling). Default PNGs live in
  `client-web/public/icons/` (made from `docs/images/icon.png`, the
  1024 px source); the tab icon falls back to it too.
- **Updates never hidden:** the service worker fetches the page
  network-first and falls back to the cache only when offline; hashed
  assets (already `immutable`) can be cache-first. The new version
  notice (`newVersion.ts`, fetches `/` with `no-store`) keeps working.
- **Install button, no pop-up:** an "Install App" button in Settings
  (About, This App: a normal button) and on the login page next to the
  desktop download link (a link-styled button, like the link beside it), using the
  browser's `beforeinstallprompt`; greyed out with a tooltip where the
  browser can't install (or it's already installed). No banner.
  *Changed 2026-11-13 (Ryan, PW9):* inside the installed app the sign-in
  page leaves it out, as it does in the desktop app (a greyed link still
  looks like a link, and phones show no tooltip); Settings, About keeps
  it greyed, "already installed". In Safari itself it keeps showing after
  Add to Home Screen: iOS never tells a page it was added.
- **iPhone and iPad:** Safari has no install prompt, so there the button
  shows a short "Share, then Add to Home Screen" hint instead.
- **Desktop app:** unaffected: inside it the web client registers no
  service worker and shows no Install button (it is already an app).
- *As built, the service worker:* only same-origin GETs for the page,
  `/assets/`, `/sounds/` and `/icons/`; everything else (API, socket,
  attachments, avatars, `/desktop-updates/`, the manifest) is left to
  the browser. Install caches the page and the files it names; a page
  with a new main script drops the old build's assets. The new version
  check is a plain fetch, not a navigation, so it always reaches the
  server.

### Typing indicators

Decided with Ryan, 2026-11-13 (all as recommended; Feature roadmap, 2).
Built 2026-11-13 (server `typing.go`, `ChannelView.typing` /
`stopTyping` in client-core, `TypingLine` in `ChannelPane.tsx`).

- **What shows:** a line between the messages and the message box of
  the open channel or DM: "bot-mod is typing…", "bot-mod and bot-member
  are typing…", three names, then "Several people are typing…". Its
  20px are always kept (the message list gave up its 16px bottom padding),
  so nothing jumps when it comes and goes. *Changed 2026-11-13 (Ryan):*
  first built under the box, at the very bottom of the window: too easy
  to miss. Not in the sidebar (Ryan:
  open channel only, so only people looking at the channel get the
  signal). Blocked people's typing isn't shown in channels.
- **How it travels:** on the channel's own socket. While the draft is
  non-empty the client sends `{"type":"typing"}` at most every 3 s;
  emptying the box sends `typing_stop`, and so does leaving the channel.
  The server passes each on as `{"type":"typing", channel_id, user_id,
  username, stop?}` to everyone watching and stores nothing. Viewers drop
  a name 8 s after its last signal, at once on `stop`, or when that
  person's message arrives.
- **Flood limit:** per connection the server passes on at most one typing
  signal every 2.5 s and a stop only after a start (`typingGate`);
  extra frames are dropped silently, never answered. Only someone who may
  post there is passed on (DMs re-checked, as for messages).
- **Encrypted channels and DMs:** shown the same way (Ryan). The server
  learns who is typing where and when, never what: metadata like
  mentions (see "Mentions are metadata the server sees").
- **Opt-out:** Settings, Chat, "Show when I'm typing", on by default
  (least friction), per browser like the other chat switches. Off, the
  client sends nothing.

*Tests (TY1-TY9).* Run 2026-11-13 in headless Chrome with bot-admin,
bot-mod and bot-member, in general (plain) and secret (encrypted):
**TY1** bot-mod types, bot-admin sees "bot-mod is typing…" at once;
**TY2** bot-mod sends, the name goes within 0.5 s; **TY3** bot-member
empties the box, the line clears at once; **TY4** bot-mod stops without
sending, the line clears after 8 s; **TY5** two typers, "bot-mod and
bot-member are typing…"; **TY6** "Show when I'm typing" off, nothing
shows; **TY7** a DM (bot-mod to bot-admin), shows and clears on send;
**TY8** nobody sees their own name; **TY9** the message box doesn't
move when the line appears. All pass. `TestTypingGate` covers the flood
limit. Still for Ryan: the look on a phone and in the desktop app.

### Unread jump and Mark as Read

Decided with Ryan, 2026-11-13 (all as recommended; Feature roadmap, 3).
Built 2026-11-13 (client only: `ChannelView.unreadSince` /
`clearUnreadSince` and `Chat.markAllRead` in client-core, the line and
bar in `ChannelPane.tsx`, the menus and Shift+Esc in `ChatApp.tsx`).

- **"New" line:** opening a channel with unread messages keeps the old
  read mark (opening still marks the channel read at once) and draws a
  line labelled New above the first message from someone else after it.
  It also appears for messages that arrived in the open channel while
  you weren't looking (another window, a background tab, or Home, the
  call or a stream on screen). It stays until you switch channels, press
  Esc or Mark as Read. Colour: the Unread dot colour
  (Settings > Appearance), so no new colour setting.
- **Jump bar:** "12 new messages since 14:32" with Jump and Mark as Read,
  the reply bar's look, floating at the top of the list. It shows only
  while the New line is above what's on screen (or not loaded yet: then
  "50+", since the first history page is 50 messages). Jump scrolls to
  the line, loading older pages first if needed (up to 20, like jumping
  to a message link).
- **Esc** marks the open channel read and drops the line and the bar,
  unless a dialog, menu or picker is open, the message box is cancelling
  a reply or an edit, or another field has focus.
- **Mark All as Read:** right-click (or long-press) the Text channels
  heading (the menu also has Create Channel / Create Category, greyed
  without manage_channels), or Shift+Esc as in Discord. Text channels
  only, not direct messages (they alert like mentions; clearing them by
  accident is worse). **Mark Category as Read** heads a text category's
  menu. The Messages tab's right-click menu has its own Mark All as Read
  for direct messages. Each is greyed when nothing in it is unread.
- **Fixed on the way:** the read mark only advanced to the newest time in
  the channel list fetched at sign-in, so a channel read during a
  session could come back unread after a reload; the list now follows
  live messages, and catching up after a reconnect counts too. And the
  open channel counted as "looked at" while Home, the call or a stream
  covered it, so messages there were marked read unseen.
- **Not now:** read marks stay per browser (localStorage). Syncing them
  across devices needs read marks on the server (Open items, Features
  not built yet).

*Tests (UN0-UN11).* Run 2026-11-13 in headless Chrome, bot-mod posting
and bot-admin reading (`unread.mjs`, `unread2.mjs`): **UN0** general
unread while bot-admin is on Home; **UN1** opening it, the New line sits
above the first new message and no bar shows (all on screen); **UN2** Esc
removes the line; **UN3** 60 new messages in lfg (encrypted): bar "60 new
messages since …", Jump puts the line on screen and hides the bar;
**UN4** back at the bottom the bar returns, Mark as Read clears both;
**UN5** messages while bot-admin is on Home leave general unread, coming
back shows the line above them; **UN6** Text channels heading, Mark All as
Read clears general and lfg, then greys out; **UN7** Shift+Esc clears
every text channel; **UN8** a channel read live stays read after a
reload; **UN9** 60 messages while in another channel: "50+ new
messages", Jump loads older pages to the line; **UN10** Mark Category as
Read (Admin Category, vip-test); **UN11** Messages tab, Mark All as Read
clears the DM badge. All pass. Ryan checked the look on his PC and
phone (line, bar, menus, long-press, narrow screen), 2026-11-13: pass.

### Settings layout

Ryan, 2026-11-13 (bug: the tab row never wrapped, so in a half-screen
window the last Server settings tabs, up to Security, were cut off).
Built 2026-11-13 (client only: `SettingsNav.tsx`, both dialogs,
`styles.css` "Tabs in a column").

- **Tabs in a column** on the left of Settings and Server settings, as
  wide as "Voice and Video" (150 px), each scrolling on its own; the
  open tab sits on a stage to the right whose body scrolls, with its
  footer (Save bottom left, Done) under the stage. The open tab has the
  active channel's look.
- **Server settings runs by role:** first what every staff member sees
  (Groups, Members, Stickers), then a **Moderation** heading (Reports,
  Bug Reports, Bans, Log, each as its permission allows), then
  **Administration** (General, Voice and Video, Sign-Up, Security). The
  everyday tabs keep their places whatever the role; more powerful
  ones gather at the bottom. It opens on Groups (General before), or on
  Reports / Bug Reports when some wait; Home's Edit still opens General.
- **Heading colours:** each heading takes its role's name colour: the
  lowest-ranked coloured group holding `administrator` for
  Administration; for Moderation, the lowest-ranked coloured group with a
  moderation switch (ban, view reports, delete messages, server mute,
  move members) but not `administrator`. Plain grey when name colours are
  off (server switch or Settings > Appearance) or no such group has a
  colour.
- **Settings** keeps its tabs and order (no headings: every tab is for
  everyone). Stays two dialogs (a merged one was considered).
- **Phones** (window 520 px or less): the tabs go back to the top and
  wrap onto rows; the headings hide, the order stays. A half-screen
  window on a 150% display (~570 px) keeps the column.

*Tests (SL1-SL6).* Run 2026-11-13 in headless Chrome (`narrow2.mjs`,
`navprofile.mjs`): **SL1** 1280 px, bot-admin: column with every tab,
Moderation in Moderator's magenta, Administration in Administrator's
orange, footer under the stage; **SL2** 570 px: column kept, nothing cut,
Security opens with Save and Done in view; **SL3** 390 px: tabs wrap onto
three rows at the top, headings hidden, nothing cut; **SL4** bot-mod:
Groups, Members, Stickers, then Moderation with four tabs, no
Administration; **SL5** bot-member: no Server settings gear, Settings >
Profile (own body and footer) sits on the stage at 1280 and 390 px;
**SL6** Settings at all three widths, nothing cut. All pass. Ryan's look
on his PC (full and half screen) and phone, SL7-SL9, 2026-11-13: pass.

## Permission groups

Build-order step 12, decided by Ryan 2026-10-31.

**Switches decide what you can do; rank decides whom you can do it to.**
A group carries permission switches (`perm.All`: administrator,
manage_groups, manage_channels, delete_messages, view_reports, ban,
force_ptt, server_mute, manage_stickers). An account holds the union of its groups' switches. Groups
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
access_changed, channel_deleted, user_purged). Found on the test server
2026-10-31: losing a group closed the account's only socket, so the re-add
never arrived and the channel list stayed stale until a reload. Client-core's
`Chat` opens one at sign-in and reconnects it; channel sockets
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

Devices that go unused expire (decided by Ryan, built 2026-10-31): a
device whose keys are gone (a closed private window, a wiped browser)
would otherwise stay active forever, members would keep adding it and
spend its key packages, last resort included. `touchDevice` updates
`last_seen_at` (at most once a minute) on key package count/publish and
every MLS call that checks `ownDevice`; `db.StartDeviceExpirySweep`
revokes devices idle 30 days, hourly and at startup, deletes their
unclaimed packages and sends `access_changed`. The count check returns
410 for a revoked device, and `Identity.start` then wipes local storage
and registers a new one. Migration 0013 restarted every active device's
clock, since nothing had maintained `last_seen_at` before. Same idea as
Signal unlinking idle devices.

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

Every device joining or leaving is shown in the channel ("sam added a
device", "sam's laptop was removed"). That is the mitigation for the
tension below and is part of the feature, not polish.

**Notices are per person by default, per device on request.** Decided by
Ryan, 2026-10-31. Most users care who is in a channel, not which of
their devices is. So chat shows, by default:

- "sam joined" when an account's first device enters the group, and
  "sam left" when its last device leaves;
- "sam joined on a new device" when an account already present gains
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
that safeguard and stays available to every user.

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

Reconciliation is the only way into a group (the debug page's "Add
everyone" buttons and the public `groups.addMembers` went on
2026-10-31).

**Media keys come from the voice channel's own MLS group.** A voice
channel gets a group exactly like an encrypted text channel. Each member
derives the frame key with the MLS exporter (label `OpenVoxa media key
v1`, context = channel ID, 32 bytes) and hands it to LiveKit, which runs
it through HKDF to an AES-GCM key and encrypts every frame in a worker
before it leaves the browser. The key is never transmitted. A membership
change is a new epoch and therefore a new key, so removal and addition
rotate media keys with no separate key distribution.

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

**Recovery key and history backup.** Decided with Ryan 2026-10-31 and
2026-11-01 (step 13, M1). v1 is history backup only.

- *The key:* generated at sign-up, shown once (12 words and a QR code),
  confirmed by typing 3 random words (the first four letters suffice);
  no "Not now" at sign-up. 128 random bits as 12 BIP-39 words (the
  checksum catches typos) or a QR payload `OVRK1:<hex>`; QR scanning by
  camera is not built, the text can be pasted. The key is random, not a
  password, so HKDF-SHA256 with a per-backup salt is enough (no Argon2).
- *Storage* (server, migration 0015, `recovery.go`): one backup per
  account, a small opaque header (format, KDF salt, key check, so a wrong
  key reads as wrong, not as damage) plus named opaque chunks. Chunk
  names are client-chosen so the server does not learn which channel a
  chunk covers. Starting a backup replaces the header, drops all chunks
  and issues a new backup id; uploads carry that id and get 409 if it is
  stale, so chunks sealed under two keys never mix. Limits: 4 MB per
  chunk, 1000 chunks, 256 MB per account.
- *Format* (client-core `recovery.ts`): chunks are gzip'd JSON under
  AES-256-GCM with the backup id and chunk name as additional data. Each
  upload writes a whole new generation `<gen>-<n>` then deletes the old
  one, so an interrupted upload leaves one complete copy. Restore only
  adds entries the device lacks. The derived key (not the words) is kept
  on the device as a non-extractable CryptoKey for later uploads; another
  device starting a new backup locks the others until they enter the new
  key.
- *Screens* (`Recovery.tsx`, `backup.ts` BackupManager): an older account
  without a backup is asked once per browser. A backup this device cannot
  use (never unlocked here, or replaced by another device) gets the
  restore screen: restore merges and remembers the key; "Skip for now"
  lasts the session; "I lost my key" starts a new backup after a
  warning. Uploads happen before sign-out and about a minute after the
  latest new message (`BackupManager.scheduleUpload`, debounced).

**Local storage is encrypted under the password, with a server-held
half for refreshes.** Decided by Ryan, 2026-11-03; built the same day
(server `sessionsecret.go` + migration 0019, client-core `localkey.ts`,
`codec.ts`, `storage.ts`, client-web `unlock.ts`).

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
  still wipes everything.
- *Sign out and erase (shared computer).* Built 2026-11-04, verified by
  Ryan (E1-E5). Settings, Account, Devices, on the "This browser" row;
  plain Log out stays one click (an extra choice on every sign-out is
  friction for the common case). It uploads the backup if this browser
  can, revokes this device on the server (`DELETE /devices/{id}`, so it
  leaves encrypted channels at once, not after 30 days), deletes this
  account's whole IndexedDB database including the keyring
  (`storage.destroy`: clear every store, then `deleteDatabase`; a
  blocked delete is fine since the contents are gone) and the
  `recoveryAsked` flag, then signs out. Per-browser preferences
  (colours, voice devices, notification switches) and other accounts'
  databases stay. A failed step does not stop the erase; the login page
  names it. Signing in again is a new device: recovery key for history.
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

*Encrypting the keys at rest (envelope encryption).* Added 2026-11-03.
On its own the key folder stores each account key in the clear, so the
folder (or any backup of it) is enough to read every plaintext channel.
An operator can set a 32-byte key-encryption key (`OPENVOXA_KEK`, base64,
or `OPENVOXA_KEK_FILE` for a mounted secret); the server then wraps every
account key under it (AES-256-GCM, the account id as associated data so a
wrapped file cannot be moved between accounts) where it rests on disk.
A stolen key folder, key-folder backup or disk image is then inert
without the KEK, which the operator keeps off both backups. It is opt-in
and off by default: existing deployments keep working, and
`keystore.WrapExisting` upgrades clear-text key files in place at startup
(readers accept both forms, like `SealExisting`). Crypto-shredding is
unchanged — deletion still unlinks the account's (wrapped) key file — and
the KEK can never un-shred, since it wraps keys, it does not escrow them.

Chosen over the alternatives discussed with Ryan: a separate keys
database (reintroduces the "keys in a backup" problem and adds a
networked service holding every key) and a boot-time unseal passphrase
(defends a live-server compromise too, but breaks unattended restart —
noted as a possible opt-in "sealed mode" later). The hard limit, stated
in the README: nothing here defends against a compromise of the
*running* server, which must hold the unwrapped keys in memory to read
messages at all. This layer is about backups and offline theft only.

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
crypto-shredding".

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

**Whoever hosts desktop updates can ship code to every installed app.**
The app is unsigned, so the updater's only check is the SHA-512 in
`latest.yml`, which comes over HTTPS from the same folder as the
installer. Anyone who controls that folder (today, Ryan's server) can
push native code that runs with the user's rights, far more than a
server's page can do inside its sandboxed view. Signing would tie updates
to a key held off the server; until then the folder is as sensitive as
the build machine.

**Live deletion reaches connected clients only.** An offline client keeps
whatever it cached until it reconnects, and nothing prevents a screenshot.
Deletion is enforced server-side and propagated live, which is the part
that can be enforced.

## Implementation notes

Things that cost real time to discover and are invisible in the code.
Grouped by area; read the group before touching that part.

### MLS and ts-mls

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
  documented. Found on the test server 2026-10-31 (a second account stuck reopening
  `stuck-test`), reproduced in Node. So catch-up treats any commit it
  cannot apply as removal: drop the state, rejoin by welcome or
  GroupInfo.

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

**Only a device removes its own duplicate leaves.** After rejoining from
a GroupInfo a device can hold two leaves. Another member cannot tell
which is live, and removing the wrong one would kick the device out, so
reconcile removes duplicates of its own device ID only.

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
is persisted, and in order through one queue.

**Voice commits are polled.** `group_advanced` only reaches subscribers of
the text channel a socket is connected to, so a call also catches up on
its voice group when someone joins, on any decryption error, and every 5
seconds. Cheap at this scale; a socket subscribed to several channels
would replace it.

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

### LiveKit and media

**Switching a share in place** (2026-11-06, experiment: two rooms in
headless Chromium against our LiveKit 1.13.11, livekit-client 2.23.0,
E2EE on, canvas captures). `LocalVideoTrack.replaceTrack(newTrack,
{ userProvidedTrack: false })` keeps the track SID (viewers saw no
unpublish), keeps E2EE (the transform sits on the sender), stops the old
capture, and works out the encodings again from the new size (1920x1080
to 800x1000 to 2560x1440: both simulcast layers kept flowing, the
viewer's picture changed size live). The small layer is the preset's
half size, not half the capture (a 2560x1440 capture with the 1080p
preset sends 960x540 as the small copy). **Quality live:** set
`track.publishOptions` (screenShareEncoding, layers),
`track.lastEncodedDimensions = undefined`, then `replaceTrack` with the
same MediaStreamTrack: LiveKit skips the swap but redoes the encodings
(4 Mbps 30 fps to 1.5 Mbps 15 fps live, both layers). **The size the
server has stays the publish-time one:** `UpdateVideoLayers` (sent by
hand) was ignored, so `ListParticipants` and the share limit check keep
seeing the original size and bitrates. **Desktop window sound:** the
app runs one helper per server, and the page's stop also cancels a pick
still waiting for its sound, so after a switch the old sound must not
call `stopShareSound` (`desktopShareSound.ts`, `current`).

**LiveKit is served from our origin, pinned exactly.** Browsers refuse a
Worker script from another origin, and the E2EE worker speaks a message
protocol to the main library that changes between releases, so a floating
CDN tag would eventually break encryption silently. Self-hosting also
removes a third party able to serve code that sees every decrypted frame.
The web client's Vite build bundles the worker from client-core's
own copy (`voiceWorker.ts`). The worker is not terminated by
LiveKit; the client terminates it on leave.

**Voice refuses to start without encryption.** Keys are loaded and
`setE2EEEnabled(true)` is called before `connect`, so nothing is ever
published in the clear, and a browser without insertable streams or
`RTCRtpScriptTransform` cannot join. `room.isE2EEEnabled` reads false until
connected (it waits for an event naming the local participant);
`localParticipant.isE2EEEnabled` is what governs publishing and is true
from the start.

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

**Losing access removes you from the call, and old media keys expire.**
Found on the test server 2026-10-31: a banned account stayed in the call and stayed
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

**LiveKit's track info is declared, not measured** (found 2026-11-04,
LiveKit v1.13.11). `ListParticipants` gives each track's width, height
and per-layer width/height/bitrate (in `codecs[].layers`; the top-level
`layers` is deprecated but still filled), all as the browser announced
them; there is no measured bitrate in the API. Twirp JSON uses
snake_case and enum names as strings. `UpdateParticipant` replaces the
whole permission, so send every field back (`setPublishSources` keeps
them raw). Narrowing `can_publish_sources` unpublishes the dropped
sources at once and new publishes fail with "insufficient permissions";
an empty list means every source. livekit-client did not notice the
server-side unpublish on its own: the share button stayed lit and the
browser kept capturing until the client handled it.

**LiveKit stops a local track the server unpublishes.** Found on the test server
2026-11-04 (livekit-client 2.23.0): when the server takes a source away,
the client calls `unpublishTrack` with the Room option
`stopLocalTrackOnUnpublish`, true by default, which ends the capture. A
screen share's audio can't be reopened without the browser's picker, so
an unmute had nothing to send. The Room now sets it to false; every
place that should end a track (`stopShare`, `#syncMic`, `#cleanup`)
stops it itself, and a server-muted share's audio waits in
`#heldShareAudio` until the source is allowed again.

**LiveKit screen shares ignore `videoEncoding`.** Screen-share tracks read
`screenShareEncoding` and `screenShareSimulcastLayers`, not the video
equivalents. Setting the wrong one fails silently and leaves LiveKit's
default of 1080p at 15fps and ~1.5 Mbps in place, producing a stream that
appears to ignore every setting.

**LiveKit asks for screen share sizes as "ideal".**
`createLocalScreenTracks({resolution})` turns into `ideal` constraints
(`max` only on Safari), so a capture can be bigger than the preset;
`applyConstraints` with max values after capture holds it down.

**`contentHint` defaults to detail on display capture.** That tells the
encoder to hold resolution and sacrifice frame rate, which pins screen
shares around 15fps regardless of bitrate. Set it to `motion` for video
content. The "prioritise detail / motion" control sets both this and
`degradationPreference`.

**H.264 simulcast is poorly supported; VP8 simulcast is mature.** So VP8
when simulcast is on, H.264 when it is off and hardware decoding matters
(notably Safari and iOS). Awkward and inherent to WebRTC today.

**H.264 share as one copy (2026-11-09, experiment: two headless Chrome
157 against our LiveKit 1.13.11, livekit-client 2.23.0, E2EE on, a
1080p60 canvas).** `videoCodec: "h264"` with `simulcast: false` sends
one copy; LiveKit adds no backup codec when E2EE is on (its source says
so), so it really is one. The viewer decoded 1920x1080 at 60 fps in a
320 px tile (no smaller copy to pick), and a live quality change (6 Mbps
60 fps to 3 Mbps 30 fps by `replaceTrack` with itself) applied in place.
**Chrome hides `encoderImplementation`, `decoderImplementation` and
`powerEfficientEncoder/Decoder` unless the page is capturing:** with no
capture they were missing; with a getUserMedia track stopped at once,
still missing; with a mic track kept open: "OpenH264" / "FFmpeg",
power-efficient false (no GPU in the container). In a call the mic is
open, so Stats can show them; a hardware encoder reports
`powerEfficientEncoder: true`. Not yet seen on a real graphics card.

**Why "Hardware (H.264)" still encodes in software (2026-11-09, Ryan's
RTX 4090, Windows 11, Brave 1.99 / Chromium 157; log via
`--enable-logging --v=1`).** LiveKit lets publishers send only H.264
Constrained Baseline (`42e01f`): it filters High profile out of the
publisher transport (`filterOutH264HighProfile: !IsOfferer`, v1.13.11
`pkg/rtc/transport.go`), and Baseline/Main (`42001f`/`4d001f`) are only
registered when `enabled_codecs` lists them with that exact fmtp line.
Chromium on Windows doesn't offer the graphics card for Constrained
Baseline (feature `PlatformH264CbpEncoding`, off by default on Windows
only). Turned on, Chromium tries the card and NVIDIA's Media Foundation
encoder refuses it ("Couldn't set output media type, The input type is
not supported for D3D device (0xC00D6D76)"), so it falls back to
OpenH264 (`implementation_name = 'OpenH264'`). `brave://gpu` lists
hardware H.264 baseline/main/high (1080p up to 121 fps, 4K up to 30).
`WebRtcScreenshareSwEncoding` is unrelated (off by default, VP8 only).

**Safari screen share layers (2026-11-05, CV5).** An iPad Pro in Safari
sharing with VP8 simulcast sent only the small layer: tiles worked,
but Watch (full layer) received 0x0, 0 kbps, a black view, and the
tile stayed black after coming back until resubscribed. WebKit
browsers therefore share one full H.264 copy (`#publishShare`).
Two more from the same work: a share's subscription is let go 1.5 s
after its last element detaches, so a tile handing over to the big view
doesn't stop and restart the download; and TrackUnsubscribed must never
remove the page's video elements (only our hidden audio ones).

**`adaptiveStream` picks a layer from on-screen element size.** Sensible
for saving bandwidth, wrong when a fixed quality is wanted. Exposed as a
"pin max quality" toggle; it is Room-level so it only applies at join.

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
works. The compose file pins v1.13.11 (see the note above).

**Mic processor: mediaStreamTrack changes meaning (2026-11-05).** Once a
processor is set, LiveKit's `LocalTrack.mediaStreamTrack` returns the
*processed* track, while `mute()`/`unmute()` toggle the *raw* one
(`_mediaStreamTrack`). So `mic.mediaStreamTrack.enabled = true` after
`setProcessor` enables the wrong track and the mic stays silent. And
`unmute()` returns early unless LiveKit itself marked the track muted
(VA2: a hand-disabled raw track stayed off; the meter, fed by the clone,
showed voice while others heard nothing). So the mic is `mute()`d,
published, the processor goes on, then `unmute()`. A clone of a disabled track starts
disabled: micChain sets `clone.enabled = true`. LiveKit stops
`processedTrack` when the processor stops, so a chain lives exactly as
long as its mic. Audio processors need `track.setAudioContext()` first
when `webAudioMix` is off.

**Recapturing the mic: don't use restartTrack (2026-11-06, RN7).**
Changing a capture filter (echo cancellation, noise suppression,
automatic gain) needs a new getUserMedia. LiveKit's
`restartTrack()` with our processor worked in Chrome and in a fake-mic
Electron test on Linux, but in the desktop app on Windows (Electron 45)
the restarted capture was dead, the meter included, until a rejoin; also
with micChain's clone released first. `#recapture` in voice.ts now
unpublishes, stops and drops the chain, then `#syncMic` publishes a
fresh mic, the join path. The gap isn't noticeable (Ryan). Device
switching still uses `switchActiveDevice` and works.

**A fake mic beeps once a second.** Chromium's
`--use-fake-device-for-media-stream` sends short beeps, so a level
sampled over less than a second can read silence. Sample peaks over
2 s or more. Testing LiveKit headless: mint a token with the stack's
API key in the test itself (HS256 JWT, `video.roomJoin`), run Electron
under Xvfb in `node:22-bookworm` with `--network host`, room
`rt-test-*`.

### Electron and Windows

**Electron screen share (desktop step 2, found by experiment).**
`display-capture` must pass the session's permission handler or the
page gets NotAllowedError before `setDisplayMediaRequestHandler` is
ever called. Refusing in that handler (`callback(null)`, `{}` or no
argument alike) reaches the page as `AbortError: Invalid capture
constraints`, not NotAllowedError, so the web client treats both as
"cancelled". Testing under Xvfb in a container: start Xvfb with
`-extension MIT-SHM` or screen capture fails ("Failed to initialize
pixel buffer", empty source list), and run a window manager (openbox)
or no windows are listed.

**Electron's permission check origin has a trailing slash.** The
permission check handler gets `requestingOrigin` as
`https://host/`, so a plain comparison with the view's origin fails and
the page is refused device names. Compare normalised origins. Found in
desktop step 1 (ED7b).

**electron-updater needs `resources/app-update.yml` to download.**
Found 2026-11-05 (DU3). Setting the feed in code (`setFeedURL`) is enough
to check for updates, but the download step reads `updaterCacheDirName`
from `app-update.yml` and silently never starts without it (no request
for the installer reached Caddy). electron-builder writes that file only
when it packages the app itself; we package with @electron/packager and
hand electron-builder the folder (`--prepackaged`), so
`scripts/package.mjs` writes it (provider, url, cache name). Building
the NSIS installer on Linux needs Wine (32-bit too): electron-builder
makes the uninstaller by running the installer stub, hence the Wine
container in `scripts/builder.Dockerfile`.

**Differential updates need the package name to match the cache folder.**
Found 2026-11-05 (DU7, from the app's updater.log). A differential
download compares against `%LOCALAPPDATA%\<cache>\installer.exe`, a copy
the NSIS installer makes of itself at install time. The installer names
that folder (and the install folder) after the npm package name, so
"@openvoxa/client-desktop" gave `@openvoxaclient-desktop-updater`, while
the app looked in `openvoxa-updater`: every update fell back to the full
installer. `release.mjs` now runs electron-builder from a small project
folder whose package.json says "openvoxa". The first update after an
install made by hand is always full (no copy yet).

**Windows process loopback (desktop step 3, found by experiment).**
Chromium 156's `restrictOwnAudio` constraint works with Electron's
`loopback`: the app's own sound is left out of a whole-screen share
(RO1). In the helper (`windows` crate 0.62): the activation
PROPVARIANT and AUDIOCLIENT_ACTIVATION_PARAMS are laid out by hand
(`#[repr(C)]`) because the crate's PROPVARIANT type keeps changing; the
completion handler must also implement IAgileObject (empty
`IAgileObject_Impl`); `CreateEventW` needs the `Win32_Security`
feature. Windows sends packets continuously while the target is silent
(WH3), so the reader gets a steady 192,000 bytes a second. Electron's
`desktopCapturer` window IDs are `window:<HWND as decimal>:0`.

**Picture-in-picture in Electron (2026-11-11, by experiment, Electron
45.2.2 / Chromium 156).** `documentPictureInPicture` exists (secure
contexts only: a `data:` page doesn't have it) and `requestWindow()`
resolves, but no window or WebContents is ever created: the returned
window stays 0x0 and an element moved into it just disappears. The
request does go through the page's `setWindowOpenHandler` first (url
`about:blank`, disposition `other`), and denying it rejects the
promise. Plain video PiP (`video.requestPictureInPicture()`) works: a
real always-on-top window, playing, with the Media Session call buttons
(`togglemicrophone`, `togglecamera`, `hangup`) shown on hover. Video
PiP needs the element's metadata first and the page's user activation.

### Server (Go, Postgres, HTTP)

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

**Server-to-client events never grant anything.** `perms_changed` (was
`role_changed`) makes a client refetch what it displays; the server
re-reads permissions from the database on every request regardless. A forged event changes what a client draws and
nothing else.

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

**`messages.body` is `BYTEA` from the first migration.** Plaintext
channels store UTF-8 there today; encrypted channels will store MLS
ciphertext in the same column. Enabling encryption needs no migration.

**Retention sweep interval scales to the shortest policy.** A quarter of
the shortest retention on the server, clamped between 30 seconds and 15
minutes. A fixed interval makes the displayed policy wrong by a variable
amount; scaling bounds overshoot to 25% of the stated value. The wait is
chosen after each pass, so changing a channel's retention wakes the sweep
at once (2026-11-04); before, a channel moved from forever to 2 minutes
kept its messages until the old 15-minute wait ran out.

**MLS handshake bodies have their own size cap.** Every JSON body was
capped at 64 KB. An add commit carries the Welcome and the whole ratchet
tree (tagged JSON) once per added device, so it grows with the square of
the devices added at once; adding about ten devices to a new channel got
413 and nobody was added (found 2026-11-01 in the cloud test). Group
creation, commits, resets and GroupInfo uploads now allow 8 MB
(`maxMLSBody`). Sending the tree once per commit instead of per welcome
would make it linear; not needed at our scale yet.

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

**Oversized uploads must be rejected before the multipart parser runs.**
`MaxBytesReader` kills the parser before it yields a file, so the error
that surfaces is "malformed form" when the truth is "file too large".
Checking `Content-Length` first gives the right message and avoids
buffering the upload at all; the body cap stays as a backstop because a
chunked request declares no length.

**Previews are deleted with their message.** A tombstone or retention
sweep removes the preview card too. Leaving it would keep the deleted
content's title and thumbnail on screen, which defeats the deletion.

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

**Archive copies follow deletions while the app is open.** Built
2026-11-04. The startup `archive-check` (crypto-shredding S5) already
covers retention, so the gap was an app left open. Deleting a message or
a retention sweep in an **encrypted** channel also sends
`archive_message_gone` (message id) or `archive_channel_expired` to every
connected viewer (`notifyArchives` in events.go, the `channelViewers`
rule, so outsiders learn nothing). New type names, because emitUsers
reaches channel sockets too and the open view must not apply a deletion
twice. The client deletes a single copy directly and runs the coalesced
archive check after a sweep or `channel_deleted` (which also catches the
open channel's unloaded older messages). Someone who lost access keeps
copies until their next start. Storing channel and time per archive
entry was rejected: it changes the archive and backup formats for little
gain.

### Web client and browsers

**Audio worklets have no `self` or `location`.** Vite's worker build
(`?worker&url`, IIFE) turns `import.meta.url` into
`self.location.href`, which throws on the audio thread. The Emscripten
glue in rnnoiseWorklet reads it at load, so `rnnoiseShim.ts` (imported
first) defines both. Any new worklet that imports a library: check the
built file's first line.

**Markdown escapes before formatting, never after.** Message bodies are
untrusted input. Escaping first and applying formatting to the escaped
text means no user-supplied angle bracket can become a tag. The reverse
order is a stored XSS vulnerability.

**Link previews are click-to-load for embeds.** An auto-embedded YouTube
player would contact Google for every message containing a link, whether
or not anyone watches it. The thumbnail comes from the preview the server
already fetched, and the iframe (on `youtube-nocookie.com`) is only
created on click.
The player iframe sends `Referer` as our origin only (`strict-origin`):
with no referrer at all YouTube shows "Error 153" and won't play.

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

**Own echoes are paired by a ref, not by order.** The debug page (since
deleted) paired its own echoed messages with what it sent by queue
order, so a send the server refused ("slow down") left an orphan and
every later own message in that session was archived with the previous
one's text. A send frame now carries an optional client-chosen `ref` (up
to 64 chars), echoed on the resulting message and on an error about that
frame; client-core pairs by it.

**Disabled buttons still get pointer events in Safari.** Found in TB7
(2026-11-06): the greyed-out talk button still answered taps on the
iPad, and with no mic behind it (server-muted) Tap to Talk flipped its
flag and showed "Talking". `disabled` stops clicks, not `pointerdown`.
Check the condition in the handler too, and have the model refuse
(`VoiceClient.setPTTHeld` ignores a press while the mic can't open).

**Uploads must leave Content-Type alone.** A FormData body needs the
browser's own multipart boundary header; the upload `ApiCall` in
client-web `core.ts` must not set Content-Type.

### Docker and builds

**The Docker build context is the repository root.** The server image
bundles client-core alongside the Go binary, so the Node stage and the Go
stage both need to be in context. The bundle must be copied in BEFORE
`go build`: the embed directive reads the directory at compile time, so a
bundle copied afterwards silently produces a server with no client.

**Docker applies image directory ownership only on a volume's first
mount.** A named volume for the blob store arrives owned by root, and the
server runs as `nonroot` (UID 65532), so directory creation fails and the
container crash-loops. Distroless has no shell, so the Dockerfile uses a
throwaway Alpine stage to create the directory with the right ownership
and copies it into the final image. Changing this after a volume exists
requires removing the volume.

**Blobs are safe on network storage; Postgres is not.** Attachment bytes
are write-once, read-many, with no locking, which NFS handles fine. A
database over NFS is a well-documented way to corrupt things. The blob
directory is a single path in config precisely so it can be a bind mount
to whatever an operator wants.

**Two-factor (`twofactor.go`).** The TOTP secret must be readable to
check codes, so it is sealed under the account's keystore key (context
`openvoxa/totp/v1`), not hashed; backup codes are one sealed JSON list.
A password sign-in on a two-factor account returns `two_factor_ticket`
(in memory, 5 minutes, 5 wrong codes) instead of a session. Wrong codes
are also limited per account (`twoFactorUser`, 5 then one per 5
minutes), because a right password resets the per-username login
limiter and would otherwise buy fresh guesses. `totp_last_step` refuses
a code's reuse. The "required" gate is in `requireAuth` itself (403,
`code: "two_factor_setup_required"`, only `/me`, unlock-secret, logout
and `/me/two-factor*` pass), so every route and the websocket ticket
are covered; the client's `call`/`apiCall` reload on that code and
`App.tsx` checks `/me` before starting the device. Turning the
requirement on disconnects covered accounts' sockets so their apps hit
the gate at once. Host-command log entries have no actor and detail
`host command`; the log shows them as "The server host".

**QR login (`signinlinks.go`, client-core `signinlink.ts`, client-web
`SignInLink.tsx`).** Links live in server memory (a restart cancels the
ones in flight); one per account at a time. States: waiting (2 min to
be opened) -> claimed (2 more min to approve) -> approved (1 min to
collect) -> done, or denied. The claim token (256 bits, only its hash
kept) is what the new device polls `/status` with, so that endpoint has
no rate limit; `/claim` shares the login IP limiter. Approval creates
the session with `createSession` (split out of `issueSession`); if the
link died meanwhile the fresh session is deleted again. The handover is
HKDF(link secret, salt = id) AES-GCM with the id in the AAD; the server
stores and returns it as opaque base64. Device keyrings are a second
record (`deviceKeyring`) beside `keyring` in the device store; the
session copy's check works with either. `/me/device-secrets*` passes
the two-factor setup gate, like `unlock-secret`. Max 20 secrets per
account, oldest dropped.

**Bug reports (`bugreports.go`, migration 0032, client-web
`BugReports.tsx`, About's `BugReportForm`).** The body is JSON {text,
debug} sealed under the reporter's keystore key (context
`openvoxa/bug-report/v1`), so account deletion shreds it; the list then
shows "(deleted with the reporter's account)" and Send to GitHub is
greyed. `debug` is the About rows as `[{section, items: [[k, v]]}]`,
size-checked only. Filing: 5 per account, then one per 10 minutes.
Reading and PATCH/DELETE need View reports; PATCH with
`sent_to_github` also needs Administrator (403 otherwise).
`bug_reports_changed` goes to View reports and Administrator holders. Send to
GitHub is built in the administrator's client (`issueUrl`): drops the
Address, Signed in as and Groups rows, adds this server's version from
`/version`, shortens the text to keep the address under ~7000
characters, and opens github.com/OpenVoxa/OpenVoxa/issues/new (the
desktop app sends it to the system browser).

**`go mod tidy` silently raises the `go` directive.** Running it with a
newer local toolchain than the Dockerfile's base image rewrites `go.mod`
and the container build then fails with a confusing version error. Keep
the Dockerfile's Go version at or above the directive.

## Build order

What was built when, with test IDs. Design detail lives in the sections
named; Docker is the test server.

1. ✅ Server skeleton, auth, one text channel
2. ✅ Permissions: Administrator, Moderator, User, Guest (replaced in 12)
3. ✅ Voice via LiveKit, unencrypted
4. ✅ TLS deployment
5. ✅ Screen sharing with configurable resolution and frame rate
6. ✅ Retention enforcement, account deletion, live deletion events
7. ✅ Rich text: markdown, link previews, attachments, GIF picker
8. ✅ Moderation tooling: message removal, verified reports, bans
9. ✅ MLS for text, the largest single piece of work. `client-core`
   package and `MlsProvider` interface; browser self-test; server-side
   device identity, key package storage, group state, epoch-ordered
   commits, handshake log, welcome delivery; client identity in
   IndexedDB; tree and state serialisation; encrypted messages.
   Two-party test on the test server 2026-10-30 (two accounts): welcome path and
   forward-secrecy boundary. Encrypted attachments verified the same day
   (image, mp3, PDF; stored blob opaque, row shows `encrypted` /
   octet-stream).
10. ✅ Media encryption keyed off the MLS exporter secret. Members agree
    on the key, it changes per epoch and channel (Node); LiveKit E2EE
    with epoch-indexed key slots, LiveKit 2.23.0 self-hosted and pinned.
    Two-party call on the test server 2026-10-30: a device outside the group is
    refused; adding it rotates the key; audio and screen share both ways.
11. ✅ Automatic group membership from channel access (Encryption, "Group
    membership follows channel access"). All verified on the test server
    2026-10-31 with two accounts:
    - ts-mls external commit and removal behaviour proven in Node.
    - Server: one access rule (`access.go`), allowed-devices endpoint,
      welcome recipients checked, key package claims scoped to a channel
      (every refusal case checked).
    - Client `groups.reconcile` (removals, then additions, own-leaf check
      after every commit). Node run with a real epoch race; on the test server
      the second account was added, removed and re-added while offline, then joined
      from the newest welcome.
    - Triggers (`reconcileSoon`, `access_changed`, demotion closes lost
      sockets): demote, promote, self-revoke and a new device each made
      exactly one commit.
    - Join/leave notices (`groups.onMembership`, `device-names`): an
      offline device announced changes on reconnecting, credited to the
      committer.
    - "Add everyone" buttons and public `groups.addMembers` removed.
    - External join and stuck-group reset: a new device joined an empty
      call from the GroupInfo; a demoted sole member was replaced and
      removed; a reset (`ext-test`, generation 2) with both old members
      rejoining.
    - "Forget this device" revokes it on the server first.
12. ✅ Custom permission groups replacing the fixed roles (migration 0012,
    `groups.go`, `perm`). Verified on the test server 2026-10-31 (two accounts,
    tester): upgrade kept every account's access; removal and re-add
    while connected; losing access mid-call removed the second account via the LiveKit
    sweep; a ban-only group at rank 12 acted on a Member but not on a higher-ranked account.
    Found on the way: retiring old voice keys switched every device onto
    junk keys 10 s after a key change (fixed `efc38c6`).
13. ✅ The real client, `client-web` (Architecture, "How the web client is
    served"). Order decided with Ryan 2026-10-31:
    - M1 sign-up, login, recovery key (2026-11-01; T1, B1, R1, K1 flow 1;
      K1 flows 2-5 deferred by Ryan). Encryption, "Recovery key and
      history backup". Password rules and the two-administrator floor
      (A2) came with it.
    - M2 text chat (Feature decisions, "Text chat in the web client").
    - M3 voice and screen share ("Voice and screen share in the web
      client").
    - M4 session A markdown, previews, GIFs, notices (2026-11-01); session
      B attachment upload (2026-11-03, A1).
    - M5 session A account settings, B groups and members, C moderation
      (2026-11-03). Channel management was moved forward from M5.
    - @mentions (2026-11-03).
    - Local storage encrypted under the password (2026-11-03).
14. ✅ Crypto-shredding (2026-11-03; Encryption, "Account deletion is
    crypto-shredding"). One commit per step, each tested on the test server:
    - S1 key folder (`internal/keystore`: a file per account, created on
      first seal via temp file + link, cached) and sealing of new
      plaintext bodies and edits (`httpapi/sealing.go`: AES-256-GCM,
      format byte 0x01, channel and author as associated data; an
      unopenable body is delivered empty). Migration 0020, compose volume
      `key-data`.
    - S2 existing bodies and report copies sealed at startup
      (`SealExisting`, batches of 500, guarded UPDATEs so a concurrent
      edit or delete wins). Migration 0021 (`reports.claimed_body` to
      BYTEA, `claimed_sealed`; blanks leftovers of already-deleted
      accounts). 17 messages and 4 reports sealed.
    - S3 plaintext-channel attachments sealed (`internal/sealedfile`:
      random key per file, 64 KiB AES-GCM chunks, nonce = chunk index +
      last flag, so range requests and video seeking work;
      `httpapi/attachseal.go`: file key and name sealed under the
      uploader's key, bound to channel, uploader and blob hash; download
      decrypts on the fly, 410 once the key is gone; `storeAttachment` shared
      by uploads and GIFs). Migration 0022 (`file_key`, `sealed_name`).
      GIFs in plaintext channels sealed too.
    - S4 deletion destroys the key (`keystore.Destroy`: unlink, folder
      fsync, and refuses to re-create that account's key in the same
      process, so a racing send cannot revive it). Called after the purge
      commits, in `purgeUser` and `delete-user`; a failure is logged with
      the file to remove by hand. `PurgeUserTx` also deletes the account's
      attachments and blanks report copies; the report list has
      `content_deleted`. Rejected: a startup sweep of
      key files with no account (a server pointed at the wrong database
      would destroy every key).
    - S5 delete-account wording; `POST /messages/archive-check` (up to 500
      ids, `archivecheck.go`) and `Chat.pruneArchive` at every start and
      2 s after `user_purged`, followed by a backup upload.
    - S6 `deploy/README.md`, "Account keys and backups".
    - Later the same day: keys wrapped under an optional KEK (Encryption,
      "Encrypting the keys at rest").

After step 14 the work went feature by feature. Dates are when Ryan
verified; the section named holds the design.

- 2026-11-04 Emoji (Feature decisions, "Emoji").
- 2026-11-04 Custom stickers, ST1-ST7 (ST6 as a plain Member);
  `:name:` suggestions SC1-SC5.
- 2026-11-04 Reactions ("Reactions are metadata the server sees").
- 2026-11-04 Sign out and erase, E1-E5 (Encryption, "Local storage").
- 2026-11-04 Username colours, NC1-NC7, ND1-ND3.
- 2026-11-04 Screen share quality limit and upload speed test.
- 2026-11-04 Server mute, SM1-SM10 (mute, rejoin, unmute without
  rejoining, share audio dropped and restored, timed expiry, log, rank
  refusal); force-PTT closed as advisory.
- 2026-11-04 Debug page deleted (Open items, closed list).
- 2026-11-04 Archive copies follow deletions, AR1-AR6 (Implementation
  notes, server).
- 2026-11-04 Custom sounds stage 1, CS1-CS10; stage 2 (message sound,
  Mute Sounds, cooldown), MS1-MS9, MC1-MC9; Speaker output and device
  names, SO0a-SO0c, SO1-SO7.
- 2026-11-04 Password strength with zxcvbn, ZX1-ZX7.
- 2026-11-04 Desktop step 1, Electron shell with the server pane: ED1-ED7,
  ED9-ED11, ED7b. Unsigned Windows zip built in Docker
  (`npm run package:win`, pure-JS packager, no Wine).
- 2026-11-04 Stay signed in (after ED5); speaking indicator tuned (ED7).
- 2026-11-04 Desktop step 2, screen share picker: ED8, SP1-SP7, SD1 (SD2
  no echo seen). The web client now explains an operating-system refusal
  ("Permission denied by system") instead of closing quietly.
- 2026-11-04 Desktop step 3, per-app share sound: RO1, RS1-RS3, WH1-WH3,
  WS1-WS7.
- 2026-11-04 Receiving shares on demand, LS1-LS7.
- 2026-11-05 Voice channel view, CV1-CV11, CK1-CK5 (`fd4fcde`).
- 2026-11-05 Desktop updates (installer, updater, release command):
  DU1-DU6 (DU1b after the `app-update.yml` fix, DU3 failed before it);
  DU7 after the package name fix (0.1.6 to 0.1.7 fetched 0.8 MB, not
  121 MB).
- 2026-11-05 About tab in Settings, AB1-AB8 (Feature decisions, "About
  tab in Settings"); desktop app 0.1.8 adds `appInfo` (AB8: 0.1.7 to
  0.1.8 fetched 0.8 MB and installed on quit).
- 2026-11-05 Channel menus and channel rename, CM1-CM9 (Feature
  decisions, "Channel menus").
- 2026-11-05 Voice activation, Tap to Talk and audio settings, VA1-VA13
  (VA7c open: Open items, Untested); Settings dialogs at 80% of the
  window.
- 2026-11-05 Channel changes in the moderation log, ML1-ML4 (Feature
  decisions, "Channel menus").
- 2026-11-05 Server password and sign-up modes, SP1-SP8 (Feature
  decisions, "Server password").
- 2026-11-06 On-screen talk button for touchscreens, TB1-TB8, TB7b-TB7c
  (Feature decisions, "Voice activation and audio settings").
- 2026-11-06 Ducking share sound while others talk, DK1-DK9 (untested:
  Open items, Untested; Feature decisions, "Voice activation and audio
  settings").
- 2026-11-06 Settings section headers in the accent colour with a line
  between sections (SH1-SH4; Ryan: the lines are subtle, fine for now).
- 2026-11-06 Strong noise suppression (RNNoise), RN1-RN9, RN7b-RN7d
  (Feature decisions, "Voice activation and audio settings").
- 2026-11-06 Switch stream and live share quality, SW1-SW9, SW7b (the
  "You're muted" banner moved to the tile's bottom right, clear of the
  share buttons) (Feature decisions, "Switch stream").
- 2026-11-06 Two-factor sign-in (TOTP + 10 backup codes, Settings,
  Account; Server settings, Security; Members, Remove 2FA; host command
  `reset-two-factor`), TF1-TF11 (Feature decisions, "Planned",
  two-factor; Implementation notes, Server, "Two-factor").
- 2026-11-06 QR login (Settings, Account, Sign In on Another Device;
  login page "Sign in with a link"; device keyrings, migration 0031),
  QR1-QR9 (Feature decisions, "Planned", "QR login settled";
  Implementation notes, Server, "QR login").
- 2026-11-06 Bug reports (Settings, About, Report a Bug; Server
  settings, Bug Reports for View reports holders; Send to GitHub for
  administrators; migration 0032), BR1-BR8 (Feature decisions,
  "Planned", bug reports, "Changed and settled"; Implementation notes,
  Server, "Bug reports").
- 2026-11-06 Code blocks with a language (lowlight colouring, Copy,
  composer Code button), CB1-CB8 (Feature decisions, "Planned: replies,
  links and code blocks", stage 1).
- 2026-11-06 Channel and message links (Copy Channel Link, Copy Message
  Link, #channel chips, # suggestions, jump to message), LK1-LK9 (same
  section, stage 2).
- 2026-11-06 Replies (Reply action, reply bar with @ toggle, reply line
  that jumps to the original), RP1-RP11 (same section, stage 3).
- 2026-11-07 Server name and icon (Server settings, General, with a
  crop tool; desktop pane, tab title and favicon, sign-in branding;
  migration 0033; desktop 0.1.9), SI1-SI3, SI5-SI7, SI9-SI12 (Feature
  decisions, "Server name and icon").
- 2026-11-07 Home page and community rules (Home item, banner with a
  chosen shape also on the sign-in card, welcome and rules, enforced
  acceptance with a server-side hold; migration 0034), HP1-HP18
  (Feature decisions, "Home page and community rules").
- 2026-11-08 Direct messages stage 1, server (migration 0036, dms.go,
  the DM branch of access.go; `direct_messages` switch on Member; Go
  tests `TestDMAccess` against a throwaway Postgres), DM1-DM4 regression
  checks (Feature decisions, "Direct messages", "Stage 1 as built").
- 2026-11-08 Direct messages stage 2, web client (Channels / Messages
  sidebar tabs, DM list, New Message, "Message" on names, read-only box,
  alerts), DM1-DM12; one-minute sound cooldowns for DMs (per
  conversation) and @mentions (all channels), MC1-MC4 (Feature
  decisions, "Direct messages", "Stage 2 as built").
- 2026-11-08 Direct messages stage 3, Block UI (name and DM row menus,
  Settings > Chat > Blocked People, collapsed blocked messages, no
  alerts from blocked people), BK1-BK8 (Feature decisions, "Direct
  messages", "Stage 3 as built").
- 2026-11-09 H.264 share encoder option (Encoder
  choice in the share dialog, one full copy; VP8, the default, keeps the
  small copy for tiles) and a trimmed Stats line (sent / max fps and
  kbps, encoder hardware or software, frames dropped); the share dialog
  reworked into a Quality template (with Custom) over Resolution, Frame
  rate, Bitrate, Optimise for and Encoder fields, HW1-HW9 pass (Feature
  decisions, "Voice channel view"; Implementation notes, LiveKit, "H.264
  share as one copy").
- 2026-11-09 User avatars stage 1 (Settings > Profile with the crop
  tool; voice tiles and list, DMs, beside messages; moderators' Remove
  Avatar, logged; sealed under the account key; migration 0037),
  AV1-AV12 pass (Feature decisions, "Planned", "User avatars and
  profiles", "Stage 1 as built").
- 2026-11-09 New version notice (a Reload bar after a server update
  brings a new web client, hidden during calls), NV1-NV6 (Feature
  decisions, "New version notice").
- 2026-11-11 Profiles stage 2a (profile card from names, avatars and
  voice menus; bio sealed under the account key, 300 characters;
  "Joined"; last seen with a Profile setting that hides it both ways;
  moderators' Clear Bio, logged, rank-checked; migration 0038),
  PR1-PR11 pass (Feature decisions, "Planned", "User avatars and
  profiles", "Stage 2a as built").
- 2026-11-11 Picture-in-picture for streams (video PiP from a PiP button
  on share tiles, Mute and Leave in the window from Media Session; stays
  open across channels; Document PiP ruled out by experiment in
  Electron), PP1-PP10 pass; the Firefox greyed-out button untested
  (Feature decisions, "Planned: picture-in-picture for streams").
- 2026-11-12 Profiles stage 2b, custom status (emoji plus 60 characters,
  Set Status dialog and Profile tab, Clear after Never / 1 hour / 4
  hours / Today with a one-minute server sweep, live to everyone, shown
  on the card, in voice channels and the user panel; moderators' Clear
  Status, logged; migration 0039), ST1-ST12 pass (Feature decisions,
  "Planned", "User avatars and profiles", "Stage 2b as built").
- 2026-11-12 Resizable sidebar (drag the right edge, 200-480 px,
  double-click resets, kept per browser), SB1-SB8 pass (Feature
  decisions, "Resizable sidebar").
- 2026-11-12 Channel ordering and categories (drag to reorder, shared;
  Discord-style categories per section, one level, labels only, collapse
  per browser, header colour with the name-colour contrast rule;
  migrations 0040-0041), CG1-CG14 and CC1-CC10 pass (Feature decisions,
  "Channel ordering and categories").
- 2026-11-12 Reordering on touchscreens (tap opens at once, long press
  opens the menu, long press then move drags; Move Up / Move Down / Move
  to Category… in the menus; long press on category headers), TR1-TR9
  and TT1-TT11 pass (Feature decisions, "Channel ordering and
  categories", "Touchscreens").
- 2026-11-12 Category permissions (a category's View/Post or Join/Speak
  table, channels Same as category or Custom, a Move Channel dialog on
  every move to another place; migration 0042), CP1-CP7 run 2026-11-12,
  MV1-MV7 and CP11-CP14 pass 2026-11-13 (Feature decisions, "Channel
  ordering and categories", "Category permissions").
- 2026-11-13 Installable web app (manifest and PNG icons built by the
  server from its name and icon, OpenVoxa icon by default; service
  worker caching the app shell only, page network-first; Install App on
  the sign-in page and in Settings, About; iPhone hint; a reload offline
  or during a server restart now waits instead of signing out),
  PW2-PW4, PW6, PW7 pass in headless Chrome; PW1, PW5, PW8-PW10 on real
  devices to test (Feature decisions, "Planned: installable web app (PWA)").
- 2026-11-13 Typing indicators (open channel and DMs, encrypted ones
  too; "Show when I'm typing" in Settings, Chat, on by default; nothing
  stored), TY1-TY9 pass in headless Chrome (Feature decisions, "Typing
  indicators").
- 2026-11-13 Unread jump and Mark as Read ("New" line, jump bar, Esc,
  Mark Category / All as Read, Shift+Esc; two read-mark fixes), UN0-UN11
  pass in headless Chrome (Feature decisions, "Unread jump and Mark as
  Read").

## Open items

### Next up (Ryan picks; each gets a design talk first)

- [x] **Reordering on touchscreens** (Ryan, 2026-11-12): built
      2026-11-12, TR1-TR9 and TT1-TT11 pass (Feature decisions, "Channel
      ordering and categories", "Touchscreens").
- [x] **Per-category permissions** (Ryan, 2026-11-12): designed and
      built and committed 2026-11-12; CP1-CP7 run (no problems
      reported), MV1-MV7 and CP11-CP14 pass 2026-11-13 (Feature
      decisions, "Channel ordering and categories", "Category
      permissions").
- [x] **Self-host audit, whole repo** (2026-11-09): checked every
      tracked file so anyone can clone and host their own server. No
      personal network or account details were in the repo. Fixed:
      `down -v` in Resetting deleted certificates too (verified by
      experiment; now named volumes); a fresh clone's
      `deploy/desktop-updates` was created by Docker as root, so
      `release:win` couldn't write (now kept with a `.gitkeep`); database
      backups added (`scripts/backup-db.sh`, offered by `setup.sh`,
      restore tested); `.env.example` lists every setting and no longer
      ships a password (compose refuses an empty one); README leads with
      `setup.sh`, calls the project beta; deploy/README documents release
      tags for updating and building the desktop app; CONTRIBUTING has real
      build checks. Dev notes stay public and generic: the maintainer's
      own workflow and hosts moved to a gitignored `CLAUDE.local.md`.
      Verified: `setup.sh --dry-run` from a fresh clone on Debian 13.
      Still open: a full install from a fresh clone on a throwaway VM;
      `release:win` bumps `package.json` in a self-hoster's clone (see
      deploy/README "Publishing updates"; a version taken from the update
      folder instead would avoid it).
- [x] **Beta v1** (2026-11-07 to 11-08): the first install of a live
      server from scratch with the setup script, then releases from tags.
      - **`deploy/setup.sh`.** Runs as the normal user, sudo only where
        needed; refuses if `.env` or the override exists. Installs Docker
        from Docker's apt repo on Debian/Ubuntu (and curl), adds the
        docker group and continues via `sg`. Asks: TLS path (http /
        Cloudflare dns / internal), domain + Let's Encrypt email (+
        token), HTTPS port (override `ports: !override` when not 443),
        internet or LAN (media IP detected: 1.1.1.1 trace or the route's
        src), uploads folder (Enter = volume; a path is write-tested as
        65532, gets the server volume override and a docker.service
        drop-in `RequiresMountsFor`; NFS/CIFS on an `allow-hotplug` NIC
        offers `auto` + `ifupdown-wait-online`, found on the first real
        install), and the crons. KEK always generated, shown once,
        continues only after typing `saved`. Secrets are hex (URL-safe in
        the database URL). Starts, waits for the setup code and `/health`
        (curl `--resolve` to 127.0.0.1, no hairpin), prints address, code
        and forwards. `--dry-run` writes to a temp dir. Tested: shellcheck,
        dry runs on Debian 13, `compose config` on the override, refusal
        on a set-up server, and a real install on a fresh Debian 13 VM
        (Cloudflare path, a non-443 port, NAS folder, internet): SU1 git +
        clone; SU2 Docker installed, carries on after the group change
        without a new login; SU3 questions, detected public IP right; SU4
        uploads folder passes the write test, drop-in written; SU5 key
        shown, `saved` gate; SU6 build, setup code and HTTPS health
        reported; SU7 first account registered at the domain; SU8 reboot:
        share mounted before Docker, stack back up. All passed. Learned
        (deploy/README updated): routers without NAT loopback need a local
        DNS record for LAN users; the user's own shell needs a new login
        for the docker group; "memory almost full" in a hypervisor during
        the build is page cache (about 600 MB really used).
      - **Releasing.** Tag and push the tag; on the server (no sudo) `git
        fetch --tags && git checkout <tag>`, `docker compose --profile tls
        build` while the old containers serve, then `up -d`. Only changed
        containers are recreated (the server: about 5 s); LiveKit and
        Caddy keep running, so calls stay up; clients reconnect by
        themselves and load the new web client on reload. A **hotfix**
        (`v1.0.0-beta.N.M`, which semver orders between beta.N and
        beta.N+1, where a `-hotfix` suffix would sort after beta.N+1) is
        for a change that needs nobody to rejoin a call, no desktop app
        update, and doesn't touch voice, screen share or LiveKit.
      - **v1.0.0-beta.1 (2026-11-08):** the 60 fps small copy fix, shipped
        while people were in calls. SS32-SS33 passed (over 30 fps).
        Seen: each client fetched a WebSocket ticket twice, about 3 s
        apart, after the restart (Open items).
      - **v1.0.0-beta.2 (2026-11-08):** Move members, direct messages
        (all three stages, with blocks), the one-minute DM and @mention
        sound cooldowns; migrations 0035-0036. Server and web client
        only.
      - **v1.0.0-beta.2.1 (2026-11-08, hotfix):** the login page download
        link and the public DNS record following the IP (Feature
        decisions). Web client and a host script only.
      - **v1.0.0-beta.2.2 (2026-11-09, hotfix):** the self-host audit
        (deploy files and docs only; nightly `scripts/backup-db.sh`).
        No server or client change, so the server needs no rebuild:
        `git checkout` the tag and add the cron line.
      - **v1.0.0-beta.3 (2026-11-09):** the share dialog rework (Quality
        Preset over Resolution / Frame rate / Bitrate fields with Custom,
        Encoder VP8 or H.264, trimmed Stats), HW1-HW9. Web client only:
        no desktop app update. Same routine; served bundle matched DEV.
      - **v1.0.0-beta.4 (2026-11-09):** user avatars, profiles stage 1
        (AV1-AV12); migration 0037. Server and web client only: no
        desktop app update. Same routine; served bundle matched DEV.
      - **v1.0.0-beta.4.1 (2026-11-09, hotfix):** the new version notice
        (NV1-NV6). Web client only; same routine; served bundle matched
        DEV. Pages opened before it have no notice; from the next release
        on, open pages offer Reload.
      - **v1.0.0-beta.4.2 (2026-11-11, hotfix):** profiles stage 2a
        (profile card, bio, Joined, last seen, Clear Bio; PR1-PR11);
        migration 0038. Server and web client only. It edits the voice
        menus (a View Profile item) but no media or LiveKit code, and
        nobody has to rejoin, so it qualified as a hotfix. Same routine;
        LiveKit kept running; served bundle matched DEV.
      - **v1.0.0-beta.4.3 (2026-11-11, hotfix):** picture-in-picture for
        streams (PP1-PP10). Web client only. It changes the voice UI (a
        PiP button and Media Session handlers) but no media or LiveKit
        code and needs nobody to rejoin, so Ryan chose a hotfix. Same
        routine; only the server restarted; served bundle matched DEV.
      - **v1.0.0-beta.4.4 (2026-11-12, hotfix):** custom status, profiles
        stage 2b (ST1-ST12); migration 0039. Server and web client only.
        It adds a status line under names in the voice member list but
        no media or LiveKit code, and nobody has to rejoin. Same routine;
        only the server restarted; served bundle matched DEV.
      - **v1.0.0-beta.4.5 (2026-11-12, hotfix):** the resizable sidebar
        (SB1-SB8) and channel ordering and categories with header colours
        (CG1-CG14, CC1-CC10); migrations 0040-0041 (PROD's channels
        started in alphabetical order, no categories). Server and web
        client only. It changes the voice channel list (drag handles,
        categories) but no media or LiveKit code, and nobody has to
        rejoin. Same routine; only the server restarted; served bundle
        matched DEV.
      - **v1.0.0-beta.4.6 (2026-11-12, hotfix):** reordering on
        touchscreens (TR1-TR9, TT1-TT11): taps act at once, long press
        for the menu, long press then move to drag; Move Up / Move Down /
        Move to Category… in the menus. Web client only. It changes how
        voice channel rows take taps but no media or LiveKit code, and
        nobody has to rejoin. Same routine; only the server restarted;
        served bundle matched DEV.
      - **v1.0.0-beta.4.7 (2026-11-13, hotfix):** the installable web app
        (PW1-PW10), staying signed in when the server can't be reached,
        and category permissions (CP, MV); migration 0042. Server and web
        client only. Category permissions can disconnect someone from
        voice when an administrator takes their access away, as channel
        permissions already did, but nobody has to rejoin. Fresh database
        backup first; same routine; only the server restarted; migration
        applied; served bundle matched DEV.
      - **v1.0.0-beta.4.8 (2026-11-13, hotfix):** typing indicators
        (TY1-TY9). Server and web client only; no migration. Same
        routine; only the server restarted; served bundle matched DEV.
      - **Open for later:** an official desktop app on GitHub Releases
        for other people's servers; prebuilt server images.
- [ ] **Desktop app icon** (Ryan, 2026-11-07): replace the Electron
      logo. PNG received 2026-11-12 (1024 px, transparent: an orange
      speech bubble with a white V on a dark hexagon; in the repo as
      `docs/images/icon.png` since 2026-11-13); also the default
      icon of the installable web app (Feature roadmap, 1). The banner
      (1324x233) heads the README (`docs/images/banner.png`). The
      installer stays one-click (Ryan, 2026-11-12): NSIS sidebar and
      header pictures only show in the paged installer, which would add
      3-4 clicks to a first install, so the banner isn't used there. Then: generate a multi-size
      `client-desktop/build/icon.ico` (16-256 px); set `icon` in
      `scripts/package.mjs` (the packager writes it into the exe, no
      Wine), `win.icon` / `nsis.installerIcon` / `uninstallerIcon` in
      `scripts/release.mjs`, and `icon` on the BrowserWindow in
      `src/main.ts`; ship with `npm run release:win`. Windows may show
      the old shortcut icon until its icon cache refreshes.

- [x] **User avatars and profiles** (design agreed 2026-11-09): stage 1
      avatars (AV) built 2026-11-09, AV1-AV12 pass; stage 2a profile card,
      bio, joined, last seen built 2026-11-10, PR1-PR11 pass; stage 2b
      custom status built 2026-11-11, ST1-ST12 pass. Feature decisions,
      "Planned", "User avatars and profiles".
- [x] **Picture-in-picture for streams** (design agreed 2026-11-11):
      video PiP from a PiP button on share tiles, with Mute and Leave
      (Electron has no working Document PiP); built 2026-11-11, PP1-PP10
      pass. Feature decisions, "Planned: picture-in-picture for
      streams".
- [x] Server icon and name in the pane, set in Server settings: built
      2026-11-07 (Feature decisions, "Server name and icon"; SI1-SI9).
- [ ] Audio quality per voice channel (Feature decisions, "Voice
      activation and audio settings", Later). Ryan: rarely used, later.
- [ ] Desktop app, later: badges via a preload, voice handoff between
      servers, global push-to-talk, notifications, idle unload of
      background servers.
- [ ] Desktop updates, later: code signing via SignPath Foundation
      (parked; needs the installer built in GitHub Actions, see
      Electron feature notes); "this server needs app version X".
- [ ] Minimized windows are probably missing from our share picker, as
      from Edge's (RS3; unchecked).

Added by Ryan 2026-11-06 (each still needs a design talk):

- [x] **Switch stream:** built 2026-11-06 with live quality changes
      (Feature decisions, "Switch stream"; SW1-SW9 passed).
- [x] **Channel groups and ordering:** text channels are sorted by name
      (`listChannels`, `ORDER BY c.name`). Wanted: named groups
      (categories) that collapse, and drag-to-reorder for channels and
      groups (`manage_channels`). Built 2026-11-12 with category
      colours, CG1-CG14 and CC1-CC10 pass (Feature decisions, "Channel
      ordering and categories"). Later, if wanted: reordering on
      touchscreens (no HTML drag there), per-category permissions.
- [x] **Direct messages** ("whispers" = DMs): all three stages built
      2026-11-08 (Feature decisions, "Direct messages"). Later, offered:
      "Message" on @mention chips.
- [x] **Home page** and community rules: built 2026-11-07 (Feature
      decisions, "Home page and community rules"; HP1-HP18).
- [ ] **Desktop status icon:** your status on the taskbar button
      (overlay icon: online, in voice, muted, deafened), maybe a tray
      icon with Mute/Deafen. Needs the status from the server view
      through a preload (as badges do).

**Feature roadmap** (Ryan picked the features 2026-11-12 from a list
compared against Discord, TeamSpeak, Slack, Guilded, Revolt, Mumble and
Element; ranked so popular and quick features come first and
foundations come before what builds on them). Each still gets a design
talk; one stage per session. "Hotfix" = could ship as one (no voice or
LiveKit change, no rejoin, no desktop install); voice items are meant to
ship together in one release.

Stage 1, everyday chat (small, hotfix):

1. [ ] **Installable web app (PWA)** (design agreed 2026-11-12, built
   2026-11-13, PW1-PW10 to test; Feature decisions, "Planned: installable web app (PWA)"; Ryan: high priority; the
   OpenVoxa icon from Ryan is the default when a server has none): manifest,
   icons, service worker for the app shell, "Install" on phones and
   desktops. Web Push comes with 7.
2. [x] **Typing indicators** (built 2026-11-13, TY1-TY9 pass; Feature
   decisions, "Typing indicators"). The server sees who types where
   (metadata, like mentions).
3. [x] **Unread jump and Mark as Read** (built 2026-11-13, UN0-UN11
   pass; Feature decisions, "Unread jump and Mark as Read"): "New" line,
   jump bar, Esc, Mark Category / All as Read, Shift+Esc. Client only.
4. [ ] **Pinned messages** per channel (`manage_messages` or a new
   permission). Encrypted channels: the server sees which message id is
   pinned, not its content.
5. [ ] **Spoiler tags:** `||text||` and blurred spoiler attachments
   (markdown and attachments only).

Stage 2, notifications (foundation for 7 and 15):

6. [ ] **Per-channel notification settings:** All / Mentions / Nothing,
   per channel and per server, mute for a time.
7. [ ] **`@everyone` / `@group` mentions and notifications while the app
   is closed** (Web Push via the PWA; the payload says where, never what,
   for encrypted channels).

Stage 3, voice for gaming (one release; desktop app update for 8):

8. [ ] **Global push-to-talk and desktop status icon** (desktop app;
   status icon from Next up above).
9. [ ] **Webcam video in voice** (E2EE like shares).
10. [ ] **Soundboard:** short clips per server, played into the call.
11. [ ] **Temporary voice channels:** join "Create Squad", get your own
    channel, removed when empty (inside a category, taking its
    permissions).
12. [ ] **Priority speaker and whisper lists** (TeamSpeak/Mumble).
13. [ ] **Stage / listen-only mode:** join muted, speak by permission
    or hand-raise.

Stage 4, community:

14. [ ] **Invite links**, single-use or expiring; the way in for guest
    accounts (Features not built yet) and an alternative to the server
    password.
15. [ ] **Scheduled events** with RSVP and reminders (uses 6-7).
16. [ ] **Polls**, in both kinds of channel (Ryan, 2026-11-12).
    Plaintext: the server counts; anonymous polls possible. Encrypted:
    votes are MLS messages counted by each client, so Anonymous is
    greyed out with a tooltip, members who join later don't see the poll
    (no earlier history), one vote per person and the closing time are
    enforced by clients, and a deleted account's votes disappear.
17. [ ] **Keyboard shortcuts:** quick switcher (Ctrl+K), Alt+Up/Down,
    Esc to mark read.
18. [ ] **Rich presence:** "In voice: Squads" on profiles and member
    lists (no game detection).
19. [ ] **Bookmarks / Save Message.**

Stage 5, administration and integration:

20. [ ] **Wider audit log:** channel and category edits, kicks, bans,
    deletions, server settings (today: group changes only).
21. [ ] **Webhooks / small bot API.** Rule (Ryan, 2026-11-12): only in
    unencrypted channels (a webhook can't be an MLS member, so it can't
    post into an encrypted one). Needs a token model.
22. [ ] **Data export:** your own messages and files as an archive
    (encrypted channels decrypted on the client).

Dropped (Ryan, 2026-11-12): **message search** (a search index on
every device for encrypted channels is too heavy) and **keyword
alerts** (user reports stay the way moderators review messages; How
reporting works under encryption).

Later:

23. [ ] **Accessibility pass and translations (i18n).**

### Features not built yet

- [ ] Guest accounts: the Everyone group exists, but there is no
      anonymous or invite flow to create one.
- [ ] `@everyone` / `@group` mentions, mention counts, notifications
      while the app is closed.
- [ ] Per-group screen share limits; a per-user upload test in the share
      dialog.
- [ ] Emoji: arrow keys inside the picker grid, bigger emoji-only
      messages.
- [ ] Recovery: QR scanning by camera; a second wrapping of the local
      data key under the recovery key (so a password changed elsewhere
      doesn't force a restore); Electron `safeStorage` on top.
- [ ] Reproducible builds.
- [ ] Read marks synced across devices (and between the web app and the
      desktop app): today each browser keeps its own in localStorage, so
      reading on a phone leaves the channel unread on the PC. Needs read
      marks stored on the server.

### Untested

- [ ] **PiP button greyed out in Firefox** (2026-11-11): Firefox has no
      video PiP API, so the button should be disabled with a tooltip.
      Not checked (picture-in-picture for streams, PP1-PP10 passed).
- [x] **Double reconnect after a server restart** (2026-11-08, live server
      v1.0.0-beta.1): each of three clients fetched a WebSocket ticket
      twice, about 3 s apart, all 200. Explained 2026-11-08, no change:
      a client in a channel has two sockets, the events socket (`Chat`,
      retry 5 s) and the channel socket (`ChannelView`, retry 1 s, then
      2 s, ...), and each trades its own single-use ticket.

- [ ] K1 flows 2-5 (recovery screens other than sign-up; deferred by
      Ryan), G2-G4 (GIFs), P3 (password), D1 (`delete-user` host
      command).
- [ ] VA7c: lifting a channel's forced push-to-talk sometimes left the
      *other* device stuck in it (crossed-out mic, not orange, can't
      unmute; seen twice, a second account on the iPad, an admin in the desktop
      app). `#applyMic` now redraws before and after the mute switch and
      reports failures; Ryan couldn't reproduce afterwards. Possibly
      Safari. If it returns: what the voice bar says, and any notice.
- [ ] DK1-DK9 (ducking share sound): built 2026-11-06, needs more than
      one person (someone sharing a video with sound, someone talking,
      someone listening). Ryan will run it with others.
- [ ] SI4 and SI8 (server name and icon reaching *other* people's
      tabs and desktop panes live): need a second signed-in account
      (SI8 a second administrator, or any account watching while an
      administrator saves).

### Security and protocol gaps

- [ ] Reports in encrypted channels need MLS signature verification
      before `verified` can be anything but NULL there.
- [ ] Media frames are authenticated to the group, not to a sender. The
      key is shared, so any member could forge frames under another
      member's identity. Per-sender media keys (exporter context
      including the leaf) would close this at the cost of one key per
      participant.
- [ ] Device verification (comparing safety numbers, as Signal does):
      the stronger answer to "the server's permission list decides who
      joins" (Known tensions).
- [ ] Encrypted attachment sizes are visible to the server. Padding to
      size buckets would blur them at some storage cost.
- [ ] Link previews in encrypted channels: would need to be generated by
      the sender's client and carried inside the message, as Signal does.
- [ ] A device whose commit the server accepted but which crashed before
      persisting the new state is stuck: it cannot process its own commit
      from the handshake log. Recovery would be a rejoin (external commit
      or re-invite).
- [ ] The `ratchet_tree` column in migration 0010 assumes the tree
      travels separately from the welcome. If the extension route is ever
      made to work, both that column and the custom serialiser go away.
- [ ] An add commit carries the tree once per welcome, so it grows with
      the square of devices added at once (8 MB cap, `maxMLSBody`).
      Sending it once per commit would make it linear; not needed at our
      scale yet.
- [ ] Single message deletion and retention expiry don't crypto-shred:
      backups keep plaintext-channel bodies until they age out. A key per
      message would cover them (Encryption, "Account deletion").
- [ ] An optional boot-time unseal passphrase ("sealed mode") that would
      also defend the account keys against a live-server compromise, at
      the cost of unattended restarts.
- [ ] The OpenMLS swap behind `MlsProvider` (Encryption, "ts-mls now").
- [ ] LiveKit's `encryption` option also turns on data channel
      encryption. Nothing uses data channels yet; anything that does
      later gets it for free, but must not assume the SFU can read them.
- [ ] Unfurl endpoint is a deliberate SSRF surface. Worth naming in
      SECURITY.md so reviewers look at it first.
- [ ] A promotion leaves an open read-only socket read-only until it
      reconnects (`can_post` is fixed at upgrade). Demotion is handled.
- [ ] Group changes go to `perm_group_changes`, which nothing reads yet.
- [ ] Confirm whether screen sharing should have its own permission
      rather than reusing the voice publish permission.

### Closed

One line each; the section named has the detail.

- [x] Replies, channel and message links, code blocks: all three
      stages built 2026-11-06, CB1-CB8, LK1-LK9, RP1-RP11 pass (Feature
      decisions, "Planned: replies, links and code blocks").
- [x] Bug reports: built 2026-11-06, BR1-BR8 pass (Feature
      decisions, "Planned", bug reports, "Changed and settled").
- [x] QR login (device linking by QR): built 2026-11-06, QR1-QR9
      pass (Feature decisions, "Planned", "QR login settled").
- [x] Two-factor sign-in: built 2026-11-06 (Feature decisions,
      "Planned", two-factor; Build order).
- [x] On-screen push-to-talk button for touchscreens: built 2026-11-06
      ("Voice activation and audio settings").
- [x] Server browser (Ryan, 2026-11-03): built as the desktop app's
      server pane (Feature decisions, "Server browser and desktop
      shell").
- [x] Server-side bitrate ceiling so one user cannot saturate the
      operator's uplink: "Screen share quality limit" (2026-11-04).
- [x] Force-PTT is advisory: closed 2026-11-04 as advisory by design (the
      server can't know whether a key is down); server mute is the
      enforceable tool ("Server mute").
- [x] Delete the debug page. Done 2026-11-04 (Ryan: "having it early was
      a blessing but it's now a security hole"). chat.html was
      unmaintained code rendering other people's messages on the same
      origin as the web client, so a rendering bug there could read the
      real client's session and keys. Removed `debugui/`, the `/debug/`
      route, `OPENVOXA_DEBUG_UI` and the core.js / LiveKit bundle steps
      (client-core's build now only patches ts-mls). `/debug/...` now
      gets the web app like any unknown path.
- [x] Role demotion did not reach a live websocket: fixed 2026-10-31
      (Implementation notes, "Revoking access must reach live
      connections").
- [x] Nothing read `moderation_log`: the Log tab, 2026-11-03.
- [x] Group state persisted to IndexedDB unencrypted: Encryption, "Local
      storage is encrypted under the password" (2026-11-03).
- [x] Recovery keys: step 13 M1.
- [x] Removing a revoked device from its groups: reconciliation (step 11).
- [x] Inactive devices expire after 30 days (2026-10-31; Encryption, "A
      device is the cryptographic identity").
- [x] Plaintext-channel attachments were deduplicated across users,
      revealing identical uploads: every file has its own key since
      crypto-shredding S3.
- [x] Archive copies of messages removed while the app was open:
      Implementation notes, "Archive copies follow deletions".
- [x] Opt-in history sharing for encrypted channels (2026-11-01;
      Encryption, "History sharing is opt-in per channel").
- [x] The commit endpoint checks each welcome's recipient (step 11).
- [x] A new device could only join a call or encrypted channel while a
      member was online: external join (step 11).
