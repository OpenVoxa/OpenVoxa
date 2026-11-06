# OpenVoxa

**Self-hosted chat, voice, and screen sharing that doesn't sell you out.**

A free, open-source alternative to Discord and TeamSpeak. Your server, your data, your rules. No telemetry, no analytics, no ad brokers, no features held hostage behind a subscription tier.

---

## ⚠️ Do not use this yet. Seriously.

OpenVoxa is **pre-alpha**. It is being built in public, from scratch, by someone learning large chunks of this as they go.

Text, voice and screen sharing work, and end-to-end encryption is now built: encrypted channels and every call are encrypted on your device with MLS (RFC 9420), so the server only stores and relays ciphertext. **But none of it has been reviewed by anyone qualified.** Encryption that hasn't been audited is encryption you should assume is broken somewhere. That review is the line between "interesting project" and "something to trust".

**Please do not:**

- Use this for any conversation you would mind seeing on a billboard
- Expose it to the open internet
- Recommend it to anyone who actually needs privacy (journalists, activists, people in unsafe situations)
- Assume the word "encrypted" anywhere in this repo means "reviewed and safe"; it means "built and tested by us"

**You may absolutely:**

- Read the code and tell us what's wrong with it
- Run it on your own network and break it
- Argue with the design decisions in [`docs/decisions.md`](docs/decisions.md)
- Open issues that start with "this is a terrible idea because..."

The banner comes down when a qualified reviewer has audited the encryption, with their name on the review. Until then, assume it is broken. It probably is.

---

## Why this exists

Every platform in this space follows the same arc. It launches good, it gets popular, it gets funded, and then the things that made it good start quietly getting worse. Features that used to be free aren't. Data that used to be yours isn't. The privacy policy grows a paragraph nobody reads.

OpenVoxa is an attempt at the boring alternative: software that does one set of things, does them well, and has no business model that depends on knowing anything about you.

If this project ever has a monetization strategy, something has gone wrong. Please file an issue.

## What works today

**End-to-end encryption**

- **Encrypted text channels** using MLS (RFC 9420) via ts-mls. Message bodies are ciphertext in the database; only the MLS framing (group and epoch) is in the clear. New members see nothing from before they joined, unless the channel turns on history sharing, where existing members' apps send newcomers what they hold, marked "shared by".
- **Encrypted voice and screen sharing.** Every call has its own MLS group, and each audio and video frame is encrypted in the browser before it reaches the media server. The key changes whenever someone joins or leaves, and removed devices are cut off.
- **Encrypted attachments**: each file gets its own key, sent inside the encrypted message.
- **Membership follows access.** Who belongs in a channel's encryption group is decided by who may view the channel. Clients add and remove devices automatically, and every join and leave is announced to the people in the channel, so a device the server slips in cannot hide.
- **Recovery key.** At sign-up you get 12 words (and a QR code). They encrypt a backup of your message history, which the server stores without being able to read. A new device restores your history with the words.
- **Encrypted local storage.** Keys and message history on your device are encrypted under your password, and signing a session out from elsewhere locks a lost laptop's copy.
- **Device lifecycle**: a device is the cryptographic identity, not the account. Unused devices expire after 30 days, and "Sign out and erase" wipes a shared computer.

**The web client** (served at `/`)

- Sign-up and login with sensible password rules (length, a common-password list, zxcvbn strength meter), recovery key setup and restore, "Stay signed in"
- Discord-style layout: channel list with unread markers, message history that loads as you scroll, edit and delete your own messages
- Chat extras: @mentions, emoji (picker and `:shortcodes:`), reactions, server-wide custom stickers, username colours by group
- Voice: click a channel to join, a tile per person in the call, speaking indicators, mute, deafen, push-to-talk with a key of your choice, per-person volume, microphone and speaker pickers
- Screen sharing with quality presets (up to 4K or 1440p60), a choice between sharp text and smooth motion, optional audio, live previews in the call tiles, and a full view with fullscreen and live stats. Nothing of a share is downloaded until you look at it, and its sound plays only after you click Listen
- Channel management for admins: create text and voice channels, choose who can view and post, retention, history sharing, forced push-to-talk, delete
- Notification sounds for joins, leaves, screen shares, mentions and new messages: pick from a built-in library or your own files, per-sound volume, a cooldown, per-channel mute

**The desktop app** (Electron, Windows build; pre-release)

- A pane of server icons down the left, like Discord: each bookmark opens that server's own web client in an isolated view, so accounts and keys never mix between servers
- Its own screen share picker, and on Windows 10 2004 or later, sharing a window carries that program's sound only

**The server**

- **Accounts** with argon2id password hashing and revocable server-side sessions
- **Two-factor sign-in** with an authenticator app (TOTP) and single-use backup codes; administrators can require it for staff or for everyone
- **Permission groups**: admin-defined groups with permission switches and a rank order; each channel lists which groups may view and which may post. Starts as Administrator, Moderator, Member and Everyone. There are always at least two administrators, and host commands to recover if not
- **Voice** via a self-hosted LiveKit SFU, tested on desktop and iOS Safari. The server never touches media; it only hands out tokens
- **Rate limiting** on authentication, per IP and per account
- **Rich text**: markdown, link previews with SSRF-hardened unfurling, file attachments with inline image, audio and video playback, and GIF search that never puts your users in front of a third party
- **Moderation**: message removal, reports verified against the server's own copy (for unencrypted channels), bans that cut off live connections and calls immediately, server mutes (for a while or until lifted) that take someone's microphone away in every voice channel, and a moderation log
- **Screen share limit**: an optional server-wide cap on share quality, with a built-in upload speed test to suggest one
- **Retention and deletion** that actually work: channels display their policy and a sweep enforces it, account deletion destroys content (including in the server's backups, by destroying the account's key), and both propagate live to connected clients
- **TLS** with three documented deployment paths

Permissions are enforced where it counts. A user without post rights in a voice channel receives a token that physically cannot publish audio, refused by the media server rather than hidden by the UI.

## What it's meant to do, and doesn't yet

- **More of the desktop app**: a global push-to-talk key, unread badges, tray, notifications, an installer with updates.
- **Signing in on a new device by QR code.**
- **Several devices per account at once.** The design supports it; only one device per account is built.
- **User avatars, server icons, channel right-click menus, a touchscreen push-to-talk button.**
- **An independent security review.** See the banner.

## What it's explicitly not doing

- **Federation.** Each instance is an island, TeamSpeak-style. This is deliberate. No shared backend, nothing for anyone to aggregate across servers.
- **Mobile apps.** The web client works on phones. Native apps wait until desktop and web are stable.
- **Scale.** Target is tens of concurrent users per instance. If you need to host 50,000 people, this is the wrong tool and probably always will be.

## Threat model

Stating the limits plainly is most of the point. A privacy tool that is vague about what it protects is just marketing.

### What this is designed to protect against

*In encrypted channels and calls. Channels can also be created unencrypted, and the server can read those; every channel shows which it is.*

- A curious or malicious server operator reading message content in encrypted channels
- Someone observing your network traffic
- A subpoena served on the server, which should yield ciphertext and nothing useful
- Any form of commercial data harvesting, because there is nothing collecting data

### What this does not protect against, ever

- **A compromised device.** Plaintext lives on your computer. If someone has your machine, they have your messages.
- **Metadata.** The server can see who talks to whom, when, and how often, including who was @mentioned in a message and who reacted with which emoji. It cannot see what was said. This is true of essentially every system in this category, Signal included, and pretending otherwise would be dishonest.
- **Other people in the channel.** Anyone who can read a message can screenshot it. Cryptography does not fix social problems.
- **A malicious build.** You run the binary we ship. Reproducible builds are a goal, not a feature yet.

### What has not been proven

All of it. No audit has been performed. No security researcher has looked at this. The cryptographic design is based on established standards ([MLS / RFC 9420](https://datatracker.ietf.org/doc/html/rfc9420)) and established implementations, which is the right starting point and absolutely not a guarantee of correct usage.

We did not write our own cryptography, which is the single best decision in the project.

## Status

Everything in "What works today" is built and tested by us, on one homelab server with a handful of accounts. Not started: the independent security review, reproducible builds, mobile apps. The review is the one that matters now; built and tested by us is not the same thing as safe.

The full build history, with what was tested when, is in [`docs/decisions.md`](docs/decisions.md) ("Build order").

## How it's built

| Layer | Choice |
| --- | --- |
| Server | Go |
| Database | PostgreSQL |
| Client core | TypeScript, shared between desktop and web |
| Desktop | Electron shell; each server's own web client in its own view |
| Web | React + Vite, embedded in the server binary and served at `/` |
| Media | [LiveKit](https://livekit.io), self-hosted |
| Attachments | Content-addressed blobs on disk; local or network storage |
| GIF search | Giphy or Tenor, proxied server-side; off by default |
| Reverse proxy | [Caddy](https://caddyserver.com), optional |
| Group encryption | MLS (RFC 9420) via ts-mls, behind a swappable interface |

The server never sits in the media path. It mints short-lived, room-scoped tokens and LiveKit carries the audio directly. See [`docs/decisions.md`](docs/decisions.md) for the reasoning behind every choice, including the tradeoffs taken on purpose.

## Running it

Requires Docker and Docker Compose.

```bash
git clone https://github.com/OpenVoxa/OpenVoxa.git
cd OpenVoxa/deploy
cp .env.example .env
# edit .env, then:
docker compose --profile tls up -d
```

**TLS is not optional in practice.** Browsers refuse microphone and screen-capture access outside a secure context, so without it voice does not work anywhere but `localhost`. Three ready-made Caddy setups cover a public domain, a domain with no inbound access (private IPs, CGNAT), and LAN only; or put your own reverse proxy in front.

Everything else, from the first administrator account to TLS, LiveKit networking, storage, key backups and troubleshooting, is in [`deploy/README.md`](deploy/README.md).

## Contributing

Very welcome, especially from people who know more about this than we do.

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first
- Commits require DCO sign-off: `git commit -s`
- Design debate goes in [Discussions](../../discussions), bugs go in [Issues](../../issues)
- Found a security problem? [`SECURITY.md`](SECURITY.md) has the private reporting channel. Please use it rather than opening a public issue.

If you are a cryptographer or a security researcher and you want to tear this apart, you are the single most welcome category of contributor this project has. The encryption is built and has never been reviewed, which makes now the most useful possible time to arrive.

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

AGPL specifically, not MIT. If you run a modified version of OpenVoxa as a network service, you have to publish your changes. That's the whole point. A project built to resist enshittification shouldn't ship a license that makes enshittification trivially easy.

The built-in sounds are [Interface Sounds](https://kenney.nl/assets/interface-sounds) by Kenney, released as CC0 (public domain), not AGPL; see `client-web/public/sounds/`.

---

<sub>Named OpenVoxa because every good name was taken and this one at least sounds like it knows what it's doing.</sub>
