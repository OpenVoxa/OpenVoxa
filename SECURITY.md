# Security Policy

## Current status: assume it's broken

OpenVoxa is **pre-alpha and unaudited**. No security researcher has reviewed it. The cryptographic design follows established standards and uses established implementations, but correct usage of those implementations has not been verified by anyone qualified.

Do not deploy this where real privacy matters. Do not use it for conversations you would mind being public.

That context matters for reporting: we are not claiming this is secure, so "I found a vulnerability" is currently closer to "I found a bug" in severity terms. Report it anyway. Early findings are more valuable than late ones.

## Supported versions

None. There has been no release. Everything here is `main`, and `main` is a construction site.

| Version | Supported |
| --- | --- |
| `main` | Best effort, no guarantees |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: go to the [Security tab](../../security/advisories/new) and open a draft advisory. This creates a private channel visible only to maintainers.

If that doesn't work for you, the fallback contact is in the repository owner's GitHub profile.

### What to include

- What the issue is, in a sentence
- How to reproduce it, ideally with steps or a proof of concept
- Which component and which commit
- What an attacker could actually do with it
- Whether you plan to publish, and on what timeline

You don't need all of this. Partial reports are better than none.

### What to expect

- **Acknowledgement within 7 days.** This is a side project, not a company. If you haven't heard back in a week, ping again.
- **An honest assessment**, including "you're right and I don't know how to fix this yet" if that's the truth.
- **Credit in the advisory and the release notes**, unless you'd rather stay anonymous.
- **No bug bounty.** There is no money here. There is gratitude and a public thank-you.

### Coordinated disclosure

We'd ask for 90 days before public disclosure, or until a fix ships, whichever comes first. That's a request rather than a demand. If a problem is being actively exploited, or if we go quiet on you, publish. Users being informed beats a maintainer being comfortable.

## Scope

**In scope:**

- Anything that breaks the encryption guarantees described in the [README](README.md)
- Authentication and session handling flaws
- Incorrect use of MLS, LiveKit E2EE, or any cryptographic library
- Server-side access to data it should not be able to read
- Account deletion or retention policy failing to actually delete
- Permission bypass between the Administrator / Moderator / User / Guest roles
- Anything in the dependency chain that we're using unsafely

**Out of scope:**

- Issues in upstream dependencies themselves. Report those upstream, though we'd appreciate a heads-up.
- Attacks requiring a compromised client device. This is documented as outside the threat model.
- Metadata visible to the server operator. Also documented, also outside the threat model. If you can show us a practical way to reduce it, that's a very welcome Discussion.
- Social engineering, physical access, denial of service against a specific self-hosted instance.
- Missing security headers or best-practice findings with no demonstrated impact. Automated scanner output without analysis will be closed.

## Known limitations

These are design tradeoffs, not undiscovered bugs. They're documented in [`docs/decisions.md`](docs/decisions.md):

- The server sees URLs sent to the link-unfurling endpoint, though never message bodies
- The server sees signaling metadata: who is in which channel, and when
- Crypto-shredding renders deleted users' content unreadable on the server, but cannot remove plaintext already cached on other members' devices
- Lost recovery keys mean permanently lost message history, by design

If you think one of these is worse than we've assessed, say so. We'd rather be told.
