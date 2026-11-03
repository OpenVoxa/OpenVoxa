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

## First account and administrator recovery

The first account becomes the administrator, so it needs a **setup code**
from the server log (the code changes on every restart):

```bash
docker compose logs server | grep setup_code
```

Open the site, choose Register, and enter the code with your username and
password.

Give the server a second administrator soon after: it refuses any change
that takes it below two (so a taken-over account cannot remove everyone
else), and it warns in the log while it has fewer. If you are ever
locked out, grant it from the host. This works only from
the machine running Docker, never over the network:

```bash
docker compose exec server /openvoxa-server grant-admin <username>
docker compose exec server /openvoxa-server list-admins
```

Accounts can be listed and deleted from the host too. Deletion is
permanent (messages emptied, sessions ended) and keeps the two-administrator
floor unless you add `--force`:

```bash
docker compose exec server /openvoxa-server list-users
docker compose exec server /openvoxa-server delete-user <username> [<username>...]
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
| `/rtc*` | `host:7880` (LiveKit uses the host network) | WebSocket upgrade required |
| everything else | `server:8080` | WebSocket upgrade required on `/api/v1/ws` |

Both need WebSocket support. Many default proxy configs do not pass the `Upgrade` header, which produces a connection that opens and immediately closes.

You will also need to publish port 8080 from the `server` service, since the default compose file keeps it internal.

**Only set `OPENVOXA_TRUST_PROXY=true` when a proxy you control is actually in front.** With it on and no proxy, anyone can send an `X-Forwarded-For` header, choose their own rate-limit bucket, and walk past the login limiter.

## LIVEKIT_NODE_IP is the setting that breaks things

LiveKit advertises this address as the destination for RTP. Media travels over UDP directly from client to LiveKit and **never passes through Caddy**, so TLS does not change what this value should be.

| Deployment | Value |
| --- | --- |
| LAN only | The server's LAN address, e.g. `192.168.1.9` |
| Internet facing | Your public IP, with UDP 50000-50100 forwarded |

LiveKit runs on the host's network and also offers the host's own addresses (`advertise_internal_ip` in `livekit.yaml`). So with the public IP set here, clients on your LAN still connect straight to the LAN address, and your router doesn't need hairpin NAT. Forward TCP 7881 too if some outside clients can't use UDP. Don't forward 7880: browsers reach it through Caddy at `/rtc`.

### Home servers whose public IP changes

LiveKit reads the node IP only when it starts. `scripts/update-node-ip.sh` checks the public IP (via Cloudflare's `1.1.1.1/cdn-cgi/trace`), and when it differs from `LIVEKIT_NODE_IP` it rewrites `.env` and recreates the `livekit` container. It does nothing while `LIVEKIT_NODE_IP` is a private address, so a LAN-only server is left alone. Run it from cron on the Docker host as a user who can run docker:

```
*/5 * * * * /home/you/OpenVoxa/deploy/scripts/update-node-ip.sh >> $HOME/openvoxa-node-ip.log 2>&1
```

Your DNS record still needs its own dynamic DNS updater; this only covers LiveKit.

Getting it wrong gives you a connection that establishes successfully and then carries no audio. Signalling works, the participant list populates, and nobody hears anything. It is the most common self-hosted LiveKit failure by a wide margin.

## Attachments and storage

Uploaded files are stored by the SHA-256 of their contents, spread across two levels of hex directories. In channels that are not end-to-end encrypted the server encrypts each file under its own key first (see [Account keys](#account-keys-and-backups)), so identical uploads are no longer stored once; in encrypted channels the browser has already encrypted them. The database holds the references; the bytes live wherever `OPENVOXA_BLOB_DIR` points.

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

## Account keys and backups

Deleting an account must also make its messages unreadable in your **database backups**, not just in the live database. For channels that are not end-to-end encrypted, the server does this by storing each account's messages, report copies and files encrypted under a key belonging to that account. Deleting the account deletes the key, and every copy of its content, backups included, becomes permanently unreadable. Encrypted channels need none of this: the server could never read them in the first place.

The keys live in their own folder, one small file per account, **deliberately outside Postgres**: a key kept in the database would be restored from a backup along with the data it exists to destroy.

- Inside the container: `/var/lib/openvoxa/keys` (`OPENVOXA_KEY_DIR`).
- On the host: the Docker named volume `deploy_key-data`.
- Owned by UID 65532, mode 700. The server creates keys itself when first needed; there is nothing to set up.

### Back it up, separately and briefly

Without this folder, the server cannot read any message in a plaintext channel. So back it up, but **not alongside your database backups, and not for long**:

- **Separately**, because a database backup plus a key backup from the same day can still show the messages of an account deleted since. Store them in different places so one leaked or stolen backup is not both.
- **Short-lived**, because an account deletion is only complete once the last key backup holding that account's key has been deleted. Keep about a week of key backups and delete older ones. Database backups can be kept as long as you like.

A key backup is a small archive of the folder. It holds the keys in the clear, so treat it like a password file:

```bash
cd ~/OpenVoxa/deploy
docker run --rm -v deploy_key-data:/keys:ro -v /path/to/key-backups:/out alpine \
  tar czf /out/openvoxa-keys-$(date +%F).tar.gz -C /keys .
chmod 600 /path/to/key-backups/openvoxa-keys-*.tar.gz
# delete key backups older than 7 days
find /path/to/key-backups -name 'openvoxa-keys-*.tar.gz' -mtime +7 -delete
```

Run it daily from cron, the same way as `update-node-ip.sh`.

### Restoring

The server keeps keys in memory, so stop it while restoring:

```bash
docker compose stop server
docker run --rm -v deploy_key-data:/keys -v /path/to/key-backups:/in alpine \
  sh -c 'tar xzf /in/openvoxa-keys-YYYY-MM-DD.tar.gz -C /keys && chown -R 65532:65532 /keys'
docker compose start server
```

A key backup may hold keys of accounts deleted after it was taken. Against the live database they unlock nothing (those accounts' rows are already blank), but they should not exist. To list key files that belong to no account:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select id from users"' | sort > /tmp/users.txt
docker run --rm -v deploy_key-data:/keys:ro alpine ls /keys | sed -n 's/\.key$//p' | sort | comm -13 /tmp/users.txt -
```

Delete each one it prints with `docker run --rm -v deploy_key-data:/keys alpine rm /keys/<id>.key`. The server never does this itself: pointed at the wrong database by mistake, it would delete every key.

### If the folder is lost

With no backup, everything already written in plaintext channels becomes unreadable for good: messages and report copies show as empty, and attachments fail to download (the server answers 410 Gone). New messages work at once, since the server makes new keys as needed. Encrypted channels, voice and screen share are unaffected.

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

LiveKit listens on the host itself, and Caddy and the server reach it through `host.docker.internal`. If voice fails to connect at all and Caddy logs errors for `/rtc`, a firewall on the Docker host (ufw, firewalld) may be blocking containers from host port 7880.

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

Accounts, messages, channels, uploaded files and account keys are gone. Certificates live in a separate volume and survive, which matters because Let's Encrypt rate-limits repeated issuance. A bind-mounted blob directory is not touched by `down -v`; remove its contents yourself if you want a clean slate.
