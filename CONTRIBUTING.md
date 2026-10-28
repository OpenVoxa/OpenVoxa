# Contributing to OpenVoxa

Thanks for looking. This project is early, built largely by one person learning as they go, and genuinely benefits from people who know more than we do showing up and saying so.

## Before you start

OpenVoxa is pre-alpha. The architecture is settled but very little is implemented. Read [`docs/decisions.md`](docs/decisions.md) before proposing changes to the design, because most of the obvious questions ("why not federate?", "why Electron?", "why not just use Matrix?") already have recorded answers and recorded tradeoffs.

If you disagree with one of those decisions, that's a great Discussion. Just start from what's written rather than from scratch.

## What help is most useful right now

In rough order of value:

1. **Security and cryptography review.** The project stakes its entire value proposition on getting encryption right, and nobody qualified has looked at it. If you do this for a living, you are the most welcome contributor this repo has.
2. **Protocol design feedback.** Especially around MLS integration, key handoff on channel join, and multi-device identity.
3. **Go and TypeScript code review.** Idiomatic corrections, concurrency bugs, anything that would embarrass us later.
4. **Documentation.** Including telling us where the docs are wrong or misleading.
5. **Features.** Useful, but the core has to exist first. Please open a Discussion before building something large.

## Where things go

- **[Issues](../../issues)** — bugs, concrete tasks, things that are broken
- **[Discussions](../../discussions)** — design debate, questions, proposals, "have you considered"
- **[`SECURITY.md`](SECURITY.md)** — vulnerabilities, privately. Please do not open a public issue for a security problem.

## Developer Certificate of Origin

Every commit must be signed off. This is a DCO, not a CLA: you keep copyright on your contributions, and you're asserting that you have the right to submit them under the project's license.

Configure git once:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Then sign off on each commit:

```bash
git commit -s -m "Add retention policy enforcement"
```

The `-s` appends a `Signed-off-by:` line. CI enforces this, so a PR without it won't merge. Forgot on the last commit?

```bash
git commit --amend -s --no-edit
```

For several commits, `git rebase --signoff main` fixes the branch.

The full DCO text is at [developercertificate.org](https://developercertificate.org/).

## License headers

Every source file carries an SPDX header. Add it when you create a file:

```go
// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later
```

Comment syntax varies by language, the content doesn't.

## Pull requests

- Branch from `main`, PR back into `main`
- One logical change per PR. A PR that fixes a bug and refactors three files is two PRs.
- Explain *why* in the description, not just what. The diff shows what.
- Keep the branch rebased on `main` rather than merging `main` into it
- Draft PRs are welcome for work in progress, and are a good way to get early feedback

### Commit messages

Imperative mood, present tense, under ~72 characters on the first line:

```
Add BYTEA message body column

Plaintext and ciphertext share one column so enabling
encryption later needs no migration.
```

Not `Added stuff` or `fixes`.

## Code style

- **Go:** `gofmt` is non-negotiable. `go vet` must pass. Prefer the standard library where it's reasonable.
- **TypeScript:** Prettier and ESLint configs live in the repo. Run them before pushing.
- **Everything:** no commented-out code in a merged PR, and no `TODO` without an issue number next to it.

## Cryptography: the hard rule

**Do not write cryptographic primitives.** Not a cipher, not a key derivation, not a protocol, not a "small improvement" to an existing one.

OpenVoxa uses established implementations ([OpenMLS](https://github.com/openmls/openmls), LiveKit's E2EE) and uses them as documented. A PR that hand-rolls crypto will be closed regardless of how correct it looks, because "looks correct" is exactly how cryptographic bugs get shipped.

If you believe an existing library is being used incorrectly, that's an extremely valuable issue. Please open one.

## Building and running

Nothing to build yet. When there is, the instructions will be here and the whole thing will come up with `docker-compose up`.

## Code of conduct

The [Contributor Covenant](CODE_OF_CONDUCT.md) applies. In short: be decent. Disagree about code as much as you like, but not about people.

## Licensing of contributions

By contributing, you agree that your contributions are licensed under the [AGPL-3.0-or-later](LICENSE), the same license as the project. You retain copyright on your work.
