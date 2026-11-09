# Contributing to OpenVoxa

Thanks for looking. This project is early, built largely by one person learning as they go, and genuinely benefits from people who know more than we do showing up and saying so.

## Before you start

OpenVoxa is in beta: text, voice, screen share and end-to-end encryption are built and in daily use by a small group, and nothing has been independently reviewed. Read [`docs/decisions.md`](docs/decisions.md) before proposing changes to the design, because most of the obvious questions ("why not federate?", "why Electron?", "why not just use Matrix?") already have recorded answers and recorded tradeoffs.

If you disagree with one of those decisions, that's a great Discussion. Just start from what's written rather than from scratch.

## What help is most useful right now

In rough order of value:

1. **Security and cryptography review.** The project stakes its entire value proposition on getting encryption right, and nobody qualified has looked at it. If you do this for a living, you are the most welcome contributor this repo has.
2. **Protocol design feedback.** Especially around MLS integration, key handoff on channel join, and multi-device identity.
3. **Go and TypeScript code review.** Idiomatic corrections, concurrency bugs, anything that would embarrass us later.
4. **Documentation.** Including telling us where the docs are wrong or misleading.
5. **Features.** Useful. Please open a Discussion before building something large: `docs/decisions.md`, "Open items", lists what is planned.

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
- **TypeScript:** `npx tsc --noEmit` must pass in `client-core`, and `npm run build` (which type-checks) in `client-web`. There is no lint or formatter config yet; match the style of the file you're in.
- **Everything:** no commented-out code in a merged PR, and no `TODO` without an issue number next to it.

## Cryptography: the hard rule

**Do not write cryptographic primitives.** Not a cipher, not a key derivation, not a protocol, not a "small improvement" to an existing one.

OpenVoxa uses established implementations ([ts-mls](https://github.com/LukaJCB/ts-mls) for MLS, LiveKit's E2EE for media, the browser's Web Crypto) and uses them as documented. A PR that hand-rolls crypto will be closed regardless of how correct it looks, because "looks correct" is exactly how cryptographic bugs get shipped.

If you believe an existing library is being used incorrectly, that's an extremely valuable issue. Please open one.

## Building and running

To run a server of your own, follow [`deploy/README.md`](deploy/README.md): `./setup.sh` builds everything from your clone, so your changes go into the image with `docker compose --profile tls up -d --build`.

Checks before a PR, by part:

| Part | Where | Check |
| --- | --- | --- |
| Server (Go) | `server/` | `go vet ./... && go test ./...` (tests that need Postgres skip unless `OPENVOXA_TEST_DATABASE_URL` is set) |
| Protocol and crypto (TypeScript, no UI) | `client-core/` | `npm ci && npm run build && npx tsc --noEmit` |
| Web client (React) | `client-web/` | `npm ci && npm run build` |
| Desktop app (Electron) | `client-desktop/` | `npm ci && npm run build`; installers: [`deploy/README.md`](deploy/README.md), "Desktop app" |

Go isn't needed on your machine: `docker run --rm -v "$PWD":/src -w /src golang:1.26 go test ./...` from `server/` works too. The server image (`server/Dockerfile`) builds `client-core` and `client-web` and embeds the web client, so a successful image build is the final check.

## Code of conduct

Be decent. Disagree about code as much as you like, but not about people.

## Licensing of contributions

By contributing, you agree that your contributions are licensed under the [AGPL-3.0-or-later](LICENSE), the same license as the project. You retain copyright on your work.
