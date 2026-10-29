# Deploying OpenVoxa

Everything here brings up four containers: PostgreSQL, a LiveKit SFU, the OpenVoxa server, and optionally Caddy for TLS.

**This is pre-alpha software with no encryption. Do not expose it to the internet.** A LAN or a private network is the right place for it today.

## Requirements

- Docker and Docker Compose v2
- A machine with room for a few GB of images and build cache. 20 GB of disk is not enough if you build Caddy from source.
- UDP ports 50000-50100 reachable from your clients
- Disk for attachments, which can be local or network storage

## Quick start

```bash
git clone https://github.com/OpenVoxa/OpenVoxa.git
cd OpenVoxa/deploy
cp .env.example .env
```

Generate a LiveKit key pair and put both values in `.env`:

```bash
docker run --rm livekit/livekit-server generate-keys
```

Then edit the rest of `.env` and start it:

```bash
docker compose --profile tls up -d
```

Check it came up:

```bash
curl https://your.domain/health
# {"status":"ok","database":"ok","channels":2}
```

## Why TLS is not optional

Browsers refuse microphone and screen-capture access outside a secure context. Without TLS, `navigator.mediaDevices` is undefined on anything but `localhost`, and voice simply does not work. The failure is confusing rather than obvious: the page loads, the channel connects, and then the microphone call fails with a null reference.

So unless you are testing on the same machine that runs the server, use the `tls` profile.

## Choosing a TLS path

Set `CADDYFILE` in `.env` to one of three values. Each Caddyfile documents its own requirements at the top.

### `Caddyfile.http` — public domain, ports open

The simplest case. Caddy obtains certificates over the HTTP challenge with no extra configuration.

Needs: a DNS A record pointing at your public IP, ports 80 and 443 forwarded to this host, and `OPENVOXA_DOMAIN` plus `CADDY_EMAIL` set.

### `Caddyfile.dns` — public domain, no inbound access

For a server on a private IP, behind CGNAT, or behind a NAT you do not control. Caddy proves domain ownership by writing a TXT record through your DNS provider's API, so nothing has to reach you from outside. You still get a publicly trusted certificate.

Needs: an API token scoped to DNS edits on your zone, and a Caddy build that includes your provider's plugin.

The shipped `caddy/Dockerfile` builds with the Cloudflare plugin. For another provider, change the `--with` line — [caddyserver.com/download](https://caddyserver.com/download) lists around a hundred, all following the same `github.com/caddy-dns/<name>` pattern. Then update the `dns` directive in `Caddyfile.dns` to match.

To use the custom build:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
```

Compose merges that automatically. The copy is gitignored, so your local build choice never lands in a commit.

**Private IPs need local DNS.** A public A record pointing at `10.0.0.5` is both useless to outsiders and a small information leak. Better to add the record to your local resolver (Pi-hole, your router, an internal DNS server) and leave no public A record at all. The DNS challenge only needs TXT records, so the certificate works either way.

### `Caddyfile.internal` — LAN only, no domain

Caddy runs its own certificate authority. No domain, no public IP, no third party involved.

The cost is per-client setup. Export the root certificate:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .
```

Then install `root.crt` as a trusted authority on every machine that connects. On Windows: double-click, Install Certificate, Local Machine, Trusted Root Certification Authorities. Until you do, browsers show a warning and voice stays broken.

## Using your own reverse proxy

Already running nginx, Traefik, HAProxy, or a tunnel? Skip the `tls` profile:

```bash
docker compose up -d
```

Then point your proxy at the server and set `OPENVOXA_TRUST_PROXY=true` in `.env`.

Your proxy needs two routes on the same hostname:

| Path | Upstream | Notes |
| --- | --- | --- |
| `/rtc*` | `livekit:7880` | WebSocket upgrade required |
| everything else | `server:8080` | WebSocket upgrade required on `/api/v1/ws` |

Both need WebSocket support. Many default proxy configs do not pass the `Upgrade` header, which produces a connection that opens and immediately closes.

You will also need to publish port 8080 from the `server` service, since the default compose file keeps it internal.

**Only set `OPENVOXA_TRUST_PROXY=true` when a proxy you control is actually in front.** With it on and no proxy, anyone can send an `X-Forwarded-For` header, choose their own rate-limit bucket, and walk past the login limiter.

## LIVEKIT_NODE_IP is the setting that breaks things

LiveKit advertises this address as the destination for RTP. Media travels over UDP directly from client to LiveKit and **never passes through Caddy**, so TLS does not change what this value should be.

| Deployment | Value |
| --- | --- |
| LAN only | The server's LAN address, e.g. `10.0.3.9` |
| Internet facing | Your public IP, with UDP 50000-50100 forwarded |

Getting it wrong gives you a connection that establishes successfully and then carries no audio. Signalling works, the participant list populates, and nobody hears anything. It is the most common self-hosted LiveKit failure by a wide margin.

## Attachments and storage

Uploaded files are stored by the SHA-256 of their contents, spread across two levels of hex directories, with identical files stored once. The database holds the references; the bytes live wherever `OPENVOXA_BLOB_DIR` points.

Two settings in `.env`:

```
OPENVOXA_MAX_ATTACHMENT_MB=25
```

`OPENVOXA_BLOB_DIR` defaults to `/var/lib/openvoxa/blobs` inside the container and rarely needs changing. What you change is what gets mounted there.

By default that is a Docker named volume, `blob-data`. Attachments inherit their channel's retention policy: when retention removes a message, its attachment rows go with it, and a sweep deletes any blob nothing references any more.

**The server runs as UID 65532**, and the image ships the blob directory with that ownership. Docker copies ownership onto a named volume only the first time it is mounted, so if you ever see `permission denied` on `/var/lib/openvoxa/blobs/tmp`, remove the volume and let it be recreated:

```bash
docker compose --profile tls down
docker volume rm deploy_blob-data
docker compose --profile tls up -d --build
```

## GIF search

Off by default. To enable it, set both of these in `.env`:

```
OPENVOXA_GIF_PROVIDER=giphy
OPENVOXA_GIF_API_KEY=your-key
```

`giphy` and `tenor` are the supported values; an empty provider disables the feature and hides the button. Setting a provider without a key fails at startup rather than silently disabling it.

Keys come from [developers.giphy.com](https://developers.giphy.com) (instant, free tier) or [Google's Tenor API](https://developers.google.com/tenor/guides/quickstart) (needs a Cloud project, higher limits). Both providers require an attribution line, which the client displays.

**Clients never contact the provider.** Thumbnails are proxied through your server, and a chosen GIF is downloaded once and stored as an ordinary attachment, so it obeys the channel's retention policy and lives on your own disk. Your server does send search queries to the provider, so they see what this instance searches for but not who searched. If that is not acceptable for your deployment, leave the feature off.

GIFs count against `OPENVOXA_MAX_ATTACHMENT_MB` and against your storage. A couple of megabytes each is normal.

### Using network storage

Attachments are a good fit for a NAS: write once, read many, no locking. **Do not put Postgres on network storage** — that is a well-known way to corrupt a database.

Export a share to the Docker host, restricted to its IP specifically rather than a subnet. NFS trusts whatever UID a client claims, so the IP restriction is doing real work.

Set ownership on the share, from the NAS:

```bash
chown -R 65532:65532 /path/to/share
chmod 750 /path/to/share
```

Mount it on the Docker host and make it persistent in `/etc/fstab`:

```
nas.example:/export/openvoxa  /mnt/openvoxa-blobs  nfs  defaults,_netdev,soft,timeo=100,noatime  0  0
```

`_netdev` stops boot hanging before networking is up. `soft,timeo=100` makes the mount fail fast rather than blocking forever when the NAS is unreachable; without it a NAS reboot can wedge the server.

Confirm the container's UID can write through a Docker mount:

```bash
docker run --rm -u 65532:65532 -v /mnt/openvoxa-blobs:/test alpine \
  sh -c 'touch /test/probe && echo writable && rm /test/probe'
```

Then point the server at it in `docker-compose.override.yml`:

```yaml
services:
  server:
    volumes:
      - /mnt/openvoxa-blobs:/var/lib/openvoxa/blobs
```

Migrating from an existing named volume:

```bash
docker run --rm -v deploy_blob-data:/from -v /mnt/openvoxa-blobs:/to -u 65532:65532 alpine \
  sh -c 'cp -a /from/. /to/'
```

Verify attachments still load before removing the old volume. That volume is your undo.

If the share becomes unavailable, uploads and downloads fail while chat and voice keep working.

## Updating

Code changes flow through git. Push from wherever you develop, then on the server:

```bash
cd OpenVoxa
git pull
cd deploy
docker compose --profile tls up -d --build
```

Hard-refresh the browser (Ctrl+Shift+R) after changes to anything under `debugui/`.

## Troubleshooting

### Changes are not showing up

Check the chain in order. It is almost always one of these rather than the code:

1. Is the change saved on the development machine?
2. Is it committed and pushed?
3. Did the server `git pull`?
4. Did the image rebuild? `docker compose up -d --build server`
5. Is the browser serving a cached page?

### Certificate errors

```bash
docker compose logs caddy --tail 50
```

`certificate obtained successfully` means Caddy is fine and something else is answering on 443. Check what is actually being served:

```bash
curl -vk https://your.domain 2>&1 | grep -i "subject:"
```

A certificate for a different hostname means another service, your router, or a CDN is intercepting. Confirm where the name resolves:

```bash
nslookup your.domain
```

Two addresses in the answer usually means a local DNS record and a public record both exist, and the browser may pick either.

### Voice connects but no audio

Almost always `LIVEKIT_NODE_IP`. Confirm what LiveKit thinks it is:

```bash
docker compose logs livekit | grep nodeIP
```

If that address is not reachable from your clients, that is the problem. Also check UDP 50000-50100 is not blocked by a firewall between client and server.

### getUserMedia is undefined

Not a secure context. Either TLS is not working, or you are on plain HTTP. There is no way around this in a browser.

### Server restarts in a loop

```bash
docker compose logs server --tail 20
```

`permission denied` on the blob directory means a volume created before the image carried the right ownership. See the attachments section above.

### GIF button does not appear

```bash
docker compose logs server | grep "gif search"
```

`gif search disabled` means the provider or key is unset. The client only shows the button when the server reports the feature enabled, so check `.env` and recreate the container — environment changes need `--force-recreate`, not a restart.

### Attachments show a broken image icon

Signed download links are minted per delivery and expire after two hours, and the signing key is regenerated on every server restart. Reload the page to fetch fresh links. If it persists, check the blob directory is mounted and readable by UID 65532.

### Build fails with "no space left on device"

Building Caddy from source needs several GB of scratch space. Free some:

```bash
docker builder prune -af
docker image prune -af
```

If that is not enough, grow the disk. The stock Caddy image needs no build at all, so `Caddyfile.http` and `Caddyfile.internal` avoid this entirely.

### Checking what is actually running

```bash
docker compose ps
docker compose logs server --tail 30
docker compose logs caddy --tail 30
docker compose logs livekit --tail 30
```

## Secrets

`.env` holds your database password, LiveKit keys, and any DNS provider token. It is gitignored. Keep it that way.

Before pushing anything:

```bash
git status --short
git diff --cached | grep -iE "secret|token|password|api_key"
```

If that second command prints a real value rather than a variable name, stop.

Git history is permanent. A key committed once is a key to rotate, not a key to delete.

## Resetting

Wipe everything including the database and attachments:

```bash
docker compose down -v
```

Accounts, messages, channels and uploaded files are gone. Certificates live in a separate volume and survive, which matters because Let's Encrypt rate-limits repeated issuance. A bind-mounted blob directory is not touched by `down -v`; remove its contents yourself if you want a clean slate.
