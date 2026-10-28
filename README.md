# OpenVoxa
 
**Self-hosted chat, voice, and screen sharing that doesn't sell you out.**
 
A free, open-source alternative to Discord and TeamSpeak. Your server, your data, your rules. No telemetry, no analytics, no ad brokers, no features held hostage behind a subscription tier.
 
---
 
## ⚠️ Do not use this yet. Seriously.
 
OpenVoxa is **pre-alpha**. It is being built in public, from scratch, by someone learning large chunks of this as they go.
 
Right now it is closer to a well-documented intention than a piece of software.
 
**Please do not:**
 
- Use this for any conversation you would mind seeing on a billboard
- Deploy it anywhere reachable from the open internet
- Recommend it to anyone who actually needs privacy (journalists, activists, people in unsafe situations)
- Assume the word "encrypted" anywhere in this repo means it has been verified by anyone qualified
**You may absolutely:**
 
- Read the code and tell us what's wrong with it
- Run it locally and break it
- Argue with the design decisions in [`docs/decisions.md`](docs/decisions.md)
- Open issues that start with "this is a terrible idea because..."
The banner comes down when a qualified reviewer has audited the cryptographic implementation and we have said so publicly, with their name on it. Until then, assume it is broken. It probably is.
 
---
 
## Why this exists
 
Every platform in this space follows the same arc. It launches good, it gets popular, it gets funded, and then the things that made it good start quietly getting worse. Features that used to be free aren't. Data that used to be yours isn't. The privacy policy grows a paragraph nobody reads.
 
OpenVoxa is an attempt at the boring alternative: software that does one set of things, does them well, and has no business model that depends on knowing anything about you.
 
If this project ever has a monetization strategy, something has gone wrong. Please file an issue.
 
## What it's meant to do
 
- **Text channels and voice channels, loosely coupled.** Sit in a voice channel and post in any text channel without leaving it. No forced context switching to say something.
- **Rich text that behaves.** Markdown, link previews, embedded YouTube, file attachments.
- **End-to-end encrypted voice and screen sharing.** The media server relays ciphertext it cannot read.
- **End-to-end encrypted text**, per channel, at the administrator's discretion, with the encryption status visible in the channel so nobody has to guess.
- **Retention policies you can actually see.** Every channel displays how long messages are kept, from "purged daily" to "kept forever." Set by the admin, shown to everyone, before they post.
- **Account deletion that means it.** Delete your account and your content becomes permanently unrecoverable on the server. No soft-delete, no 30-day grace period, no "anonymized for analytics."
- **Screen sharing without artificial limits.** Preset resolutions and frame rates in the UI, fully editable if you want something custom.
- **Simple permissions.** Administrator, Moderator, User, Guest. More later, once the basics are solid.
## What it's explicitly not doing
 
- **Federation.** Each instance is an island, TeamSpeak-style. This is deliberate. No shared backend, no hive-mind, nothing for anyone to aggregate across servers.
- **Mobile clients.** Not until desktop and web are stable. Doing both at once is how projects die.
- **Scale.** Target is tens of concurrent users per instance. If you need to host 50,000 people, this is the wrong tool and probably always will be.
## Threat model
 
Stating the limits plainly is most of the point. A privacy tool that is vague about what it protects is just marketing.
 
### What this is designed to protect against
 
- A curious or malicious server operator reading message content in encrypted channels
- Someone observing your network traffic
- A subpoena served on the server, which should yield ciphertext and nothing useful
- Any form of commercial data harvesting, because there is nothing collecting data
### What this does not protect against
 
- **A compromised device.** Plaintext lives on your computer. If someone has your machine, they have your messages.
- **Metadata.** The server can see who talks to whom, when, and how often. It cannot see what was said. This is true of essentially every system in this category, Signal included, and pretending otherwise would be dishonest.
- **Other people in the channel.** Anyone who can read a message can screenshot it. Cryptography does not fix social problems.
- **A malicious build.** You run the binary we ship. Reproducible builds are a goal, not a feature yet.
### What has not been proven
 
All of it. No audit has been performed. No security researcher has looked at this. The cryptographic design is based on established standards ([MLS / RFC 9420](https://datatracker.ietf.org/doc/html/rfc9420)) and established implementations, which is the right starting point and absolutely not a guarantee of correct usage.
 
We did not write our own cryptography, which is the single best decision in the project.
 
## Status
 
Pre-alpha. Nothing works yet. Here's the honest state of things:
 
| Milestone | Status |
| --- | --- |
| Design decisions documented | ✅ Done |
| Repo structure, license, contribution model | ✅ Done |
| Server skeleton, auth, one text channel | ✅ Done |
| Permissions | ⬜ ✅ Done |
| Voice via LiveKit | ⬜ Not started |
| End-to-end encrypted text (MLS) | ⬜ Not started |
| End-to-end encrypted media | ⬜ Not started |
| Screen sharing | ⬜ Not started |
| Retention, deletion, moderation tooling | ⬜ Not started |
| A user interface a human would enjoy | ⬜ Not started |
 
Yes, that's a lot of empty boxes. That's what pre-alpha means.
 
## How it's built
 
| Layer | Choice |
| --- | --- |
| Server | Go |
| Database | PostgreSQL |
| Client core | TypeScript, shared between desktop and web |
| Desktop | Electron |
| Web | React |
| Media | [LiveKit](https://livekit.io), self-hosted |
| Group encryption | MLS (RFC 9420) |
 
The server never decrypts anything in an encrypted channel. It routes opaque blobs between clients and never sits in the media path at all. See [`docs/decisions.md`](docs/decisions.md) for the reasoning behind every one of these choices, including the tradeoffs we took on purpose.
 
## Building it
 
Not yet. There's nothing to build. Check back.
 
When there is, it will be a `docker-compose up` away, because if self-hosting is hard then "self-hostable" is a technicality rather than a feature.
 
## Contributing
 
Very welcome, especially from people who know more about this than we do.
 
- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first
- Commits require DCO sign-off: `git commit -s`
- Design debate goes in [Discussions](../../discussions), bugs go in [Issues](../../issues)
- Found a security problem? [`SECURITY.md`](SECURITY.md) has the private reporting channel. Please use it rather than opening a public issue.
If you are a cryptographer or a security researcher and you want to tear this apart, you are the single most welcome category of contributor this project has.
 
## License
 
[GNU Affero General Public License v3.0 or later](LICENSE).
 
AGPL specifically, not MIT. If you run a modified version of OpenVoxa as a network service, you have to publish your changes. That's the whole point. A project built to resist enshittification shouldn't ship a license that makes enshittification trivially easy.
 
---
 
<sub>Named OpenVoxa because every good name was taken and this one at least sounds like it knows what it's doing.</sub>
