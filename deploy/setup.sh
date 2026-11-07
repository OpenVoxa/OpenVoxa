#!/usr/bin/env bash
# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# First-time setup for an OpenVoxa server. Run it from a git clone, as your
# normal user; it asks for sudo only for the steps that need it:
#
#   git clone https://github.com/OpenVoxa/OpenVoxa.git
#   cd OpenVoxa/deploy
#   ./setup.sh
#
# It installs Docker if it is missing (Debian and Ubuntu), asks a few
# questions, generates every secret, writes .env (and
# docker-compose.override.yml when needed), builds and starts the server,
# and prints the setup code for the first account.
#
# It never touches an existing .env: on a server that is already set up it
# stops before changing anything, because new secrets would lock you out
# of the existing data.
#
#   ./setup.sh --dry-run   ask the questions and show what it would do and
#                          write, without installing or starting anything

set -euo pipefail

ARGS=("$@")
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DEPLOY_DIR"

DRY_RUN=false
case "${1:-}" in
	"") ;;
	--dry-run) DRY_RUN=true ;;
	*) echo "Usage: ./setup.sh [--dry-run]" >&2; exit 2 ;;
esac

# ------------------------------------------------------------------ helpers

if [[ -t 1 ]]; then B=$'\e[1m' Y=$'\e[33m' R=$'\e[31m' G=$'\e[32m' N=$'\e[0m'; else B="" Y="" R="" G="" N=""; fi
say() { printf '%s\n' "$*"; }
step() { printf '\n%s== %s ==%s\n' "$B" "$*" "$N"; }
warn() { printf '%s%s%s\n' "$Y" "$*" "$N"; }
die() { printf '%sStopped: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ask VAR "Question" [default]
ask() {
	local reply
	if [[ -n ${3:-} ]]; then read -r -p "$2 [$3]: " reply; else read -r -p "$2: " reply; fi
	printf -v "$1" '%s' "${reply:-${3:-}}"
}

# ask_secret VAR "Question": not echoed
ask_secret() {
	local reply
	read -r -s -p "$2: " reply
	echo
	printf -v "$1" '%s' "$reply"
}

# yes_no "Question" Y|N: succeeds for yes
yes_no() {
	local reply hint="y/N"
	[[ $2 == Y ]] && hint="Y/n"
	while true; do
		read -r -p "$1 [$hint]: " reply
		case "${reply:-$2}" in
			[Yy] | [Yy][Ee][Ss]) return 0 ;;
			[Nn] | [Nn][Oo]) return 1 ;;
		esac
	done
}

# choose VAR "Question" default count: a number from 1 to count
choose() {
	local reply
	while true; do
		read -r -p "$2 [$3]: " reply
		reply=${reply:-$3}
		if [[ $reply =~ ^[0-9]+$ ]] && ((reply >= 1 && reply <= $4)); then
			printf -v "$1" '%s' "$reply"
			return
		fi
	done
}

# run: execute, or only show it in a dry run
run() {
	if $DRY_RUN; then printf '  (dry run) %s\n' "$*"; else "$@"; fi
}

# write_root FILE: stdin to a root-owned file
write_root() {
	if $DRY_RUN; then
		printf '  (dry run) would write %s:\n' "$1"
		sed 's/^/    /'
	else
		sudo tee "$1" >/dev/null
	fi
}

is_ipv4() {
	[[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
	local o
	for o in "${BASH_REMATCH[@]:1}"; do ((o <= 255)) || return 1; done
}

hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

# set_env FILE KEY VALUE: replace KEY=... (or append), value taken verbatim
set_env() {
	V="$3" awk -v k="$2" '
		BEGIN { v = ENVIRON["V"] }
		index($0, k "=") == 1 { print k "=" v; done = 1; next }
		{ print }
		END { if (!done) print k "=" v }
	' "$1" >"$1.tmp" && mv "$1.tmp" "$1"
}

# ---------------------------------------------------------------- preflight

((EUID != 0)) || die "run this as your normal user, not root. It asks for sudo when it needs it."
[[ -e ../.git ]] || die "run this from a git clone (git clone https://github.com/OpenVoxa/OpenVoxa.git), not a downloaded zip: the build reads the git history to stamp the server's version."
if ! $DRY_RUN; then
	[[ ! -e .env ]] || die ".env already exists, so this server is already set up. setup.sh never replaces it: new secrets would lock you out of the existing data. To start over, see deploy/README.md, \"Resetting\"."
	[[ ! -e docker-compose.override.yml ]] || die "docker-compose.override.yml already exists. Move it aside first; setup.sh writes its own."
fi

OS_ID="" OS_CODENAME=""
if [[ -r /etc/os-release ]]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	OS_ID=${ID:-}
	OS_CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
fi
APT=false
[[ $OS_ID == debian || $OS_ID == ubuntu ]] && APT=true

$DRY_RUN && warn "Dry run: nothing will be installed, started or written outside a temporary folder."

# ------------------------------------------------------------------- docker

step "1/7 Docker"

if ! command -v curl >/dev/null; then
	$APT || die "curl is missing. Install it, then run this again."
	say "Installing curl (asks for your password)..."
	run sudo apt-get update -qq
	run sudo apt-get install -y -qq curl
fi

if ! command -v docker >/dev/null; then
	$APT || die "Docker isn't installed. Install Docker Engine with the Compose plugin (https://docs.docker.com/engine/install/), then run this again."
	yes_no "Docker isn't installed. Install it now from Docker's official repository?" Y ||
		die "Docker is needed. Install it (https://docs.docker.com/engine/install/), then run this again."
	run sudo apt-get update -qq
	run sudo apt-get install -y -qq ca-certificates curl
	run sudo install -m 0755 -d /etc/apt/keyrings
	run sudo curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
	run sudo chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable" |
		write_root /etc/apt/sources.list.d/docker.list
	run sudo apt-get update -qq
	run sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if ! $DRY_RUN && ! docker info >/dev/null 2>&1; then
	if id -nG | grep -qw docker; then
		die "Docker is installed but not answering. Start it with: sudo systemctl start docker"
	fi
	say "Letting $USER use Docker without sudo (adds you to the docker group)..."
	getent group docker | grep -qw "$USER" || sudo usermod -aG docker "$USER"
	# The new group only applies to new logins; carry on inside one.
	exec sg docker -c "$(printf '%q ' "$DEPLOY_DIR/setup.sh" "${ARGS[@]}")"
fi

$DRY_RUN || docker compose version >/dev/null 2>&1 ||
	die "the Docker Compose plugin is missing (docker compose). Install docker-compose-plugin, then run this again."
say "${G}Docker is ready.${N}"

ROUTE="$(ip -4 route get 1.1.1.1 2>/dev/null || true)"
LAN_IP="$(awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' <<<"$ROUTE")"
LAN_IFACE="$(awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}' <<<"$ROUTE")"

# ------------------------------------------------------- address and TLS

step "2/7 Address and certificate"
say "Browsers only allow microphones and screen sharing over HTTPS, so the"
say "server always gets a certificate. How will people reach it?"
say "  1) A public domain, with ports 80 and 443 forwarded to this machine"
say "  2) A public domain on Cloudflare DNS (no ports needed for the certificate;"
say "     works for a server only reachable at home, too)"
say "  3) No domain, only this network (each device has to trust the"
say "     server's own certificate once)"
choose TLS_CHOICE "Choose" 1 3

DOMAIN="" EMAIL="" CF_TOKEN=""
case $TLS_CHOICE in
	1 | 2)
		while [[ -z $DOMAIN ]]; do
			ask DOMAIN "Domain name, e.g. openvoxa.example.com"
			DOMAIN=${DOMAIN#http://}
			DOMAIN=${DOMAIN#https://}
			DOMAIN=${DOMAIN%%/*}
			DOMAIN=${DOMAIN%%:*}
		done
		getent hosts "$DOMAIN" >/dev/null ||
			warn "Note: $DOMAIN doesn't resolve yet. Create its DNS record before people connect."
		while [[ $EMAIL != *@* ]]; do
			ask EMAIL "Email for Let's Encrypt (certificate expiry notices only)"
		done
		;;
	3)
		ask DOMAIN "Address people will type (this machine's LAN IP or a local name)" "$LAN_IP"
		;;
esac
if [[ $TLS_CHOICE == 2 ]]; then
	say "Caddy proves you own the domain by adding a DNS record through"
	say "Cloudflare's API. Create an API token with Zone > DNS > Edit for this"
	say "domain's zone (Cloudflare dashboard > My Profile > API Tokens)."
	while [[ -z $CF_TOKEN ]]; do ask_secret CF_TOKEN "Cloudflare API token (hidden)"; done
fi

say "HTTPS normally uses port 443. If your router forwards a different port"
say "to this machine (e.g. because 443 is taken), enter that instead."
HTTPS_PORT=""
until [[ $HTTPS_PORT =~ ^[0-9]+$ ]] && ((HTTPS_PORT >= 1 && HTTPS_PORT <= 65535)); do
	ask HTTPS_PORT "HTTPS port" 443
done
SITE_URL="https://$DOMAIN"
[[ $HTTPS_PORT == 443 ]] || SITE_URL="$SITE_URL:$HTTPS_PORT"

# ------------------------------------------------------------------- voice

step "3/7 Voice and screen share"
say "Voice travels directly to this machine over UDP, so it needs the IP"
say "address people's devices send it to."
INTERNET=false
if [[ $TLS_CHOICE == 3 ]]; then
	NODE_IP=""
	until is_ipv4 "$NODE_IP"; do ask NODE_IP "This machine's LAN IP" "$LAN_IP"; done
else
	say "Who will connect?"
	say "  1) People on the internet (needs UDP 50000-50100 and TCP 7881 forwarded)"
	say "  2) Only people on this network"
	choose WHO "Choose" 1 2
	if [[ $WHO == 1 ]]; then
		INTERNET=true
		PUBLIC_IP="$(curl -fsS --max-time 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true)"
		NODE_IP=""
		until is_ipv4 "$NODE_IP"; do ask NODE_IP "Your public IP" "$PUBLIC_IP"; done
	else
		NODE_IP=""
		until is_ipv4 "$NODE_IP"; do ask NODE_IP "This machine's LAN IP" "$LAN_IP"; done
	fi
fi

# ----------------------------------------------------------------- uploads

step "4/7 Uploaded files"
say "Press Enter to keep uploads on this machine (a Docker volume), or type"
say "a folder that is already mounted, such as a NAS share."
BLOB_DIR="" BLOB_IS_MOUNT=false FIX_NIC=false
while true; do
	ask BLOB_DIR "Folder (Enter = this machine)"
	BLOB_DIR=${BLOB_DIR%/}
	[[ -z $BLOB_DIR ]] && break
	if [[ ! $BLOB_DIR =~ ^/[A-Za-z0-9._/-]+$ ]]; then
		warn "Use a full path (starting with /) without spaces or colons."
		continue
	fi
	if [[ ! -d $BLOB_DIR ]]; then
		warn "$BLOB_DIR doesn't exist. Mount it first, or press Enter for this machine."
		continue
	fi
	if ! $DRY_RUN && ! docker run --rm -u 65532:65532 -v "$BLOB_DIR:/test" alpine:3 \
		sh -c 'touch /test/.openvoxa-probe && rm /test/.openvoxa-probe' >/dev/null 2>&1; then
		warn "The server runs as user ID 65532 and can't write to $BLOB_DIR."
		warn "On the machine that owns the folder (the NAS, or here with sudo), run:"
		warn "  chown 65532:65532 <folder>   and   chmod 750 <folder>"
		warn "then enter the path again."
		continue
	fi
	if [[ "$(findmnt -n -o TARGET --target "$BLOB_DIR")" != / ]]; then
		BLOB_IS_MOUNT=true
		# Debian's installer brings the network card up in the background
		# (allow-hotplug), so network mounts are tried before there is an
		# address, fail, and are never retried.
		case "$(findmnt -n -o FSTYPE --target "$BLOB_DIR")" in
			nfs* | cifs | smb*)
				if [[ -n $LAN_IFACE ]] && grep -qE "^allow-hotplug[[:space:]]+$LAN_IFACE([[:space:]]|$)" /etc/network/interfaces 2>/dev/null; then
					say "This network share may fail to mount at boot: $LAN_IFACE comes up in"
					say "the background, after the share is tried."
					yes_no "Make startup wait for the network?" Y && FIX_NIC=true
				fi
				;;
		esac
	fi
	break
done

# ------------------------------------------------------------- account key

step "5/7 Account key protection"
POSTGRES_PASSWORD="$(hex 24)"
LIVEKIT_API_KEY="API$(hex 8)"
LIVEKIT_API_SECRET="$(hex 32)"
KEK="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
say "Every account has its own key; deleting an account destroys it. These"
say "keys are encrypted with the key below, so a stolen backup of them is"
say "useless on its own. It is also saved in deploy/.env on this machine."
say ""
say "${B}Save it now, somewhere safe and separate from your backups${N}"
say "${B}(e.g. a password manager). If it is lost along with .env, all${N}"
say "${B}history in unencrypted channels becomes unreadable for good.${N}"
say ""
say "    $KEK"
say ""
if ! $DRY_RUN; then
	reply=""
	until [[ $reply == saved ]]; do read -r -p "Type 'saved' once you have stored it: " reply; done
fi

# ------------------------------------------------------------------ upkeep

step "6/7 Backups and upkeep"
CRON_BACKUP=false CRON_IP=false
yes_no "Back up the account keys every night at 03:30 to ~/openvoxa-key-backups (keeps 7 days)?" Y && CRON_BACKUP=true
if $INTERNET; then
	say "Most home connections get a new public IP now and then, which stops voice."
	yes_no "Check the public IP every 5 minutes and update voice automatically?" Y && CRON_IP=true
fi

# ------------------------------------------------------------ write files

OUT="$DEPLOY_DIR"
$DRY_RUN && OUT="$(mktemp -d)"
umask 077
cp .env.example "$OUT/.env"
set_env "$OUT/.env" POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
set_env "$OUT/.env" LIVEKIT_API_KEY "$LIVEKIT_API_KEY"
set_env "$OUT/.env" LIVEKIT_API_SECRET "$LIVEKIT_API_SECRET"
set_env "$OUT/.env" LIVEKIT_NODE_IP "$NODE_IP"
set_env "$OUT/.env" OPENVOXA_LIVEKIT_URL "wss://${SITE_URL#https://}"
set_env "$OUT/.env" OPENVOXA_DOMAIN "$DOMAIN"
case $TLS_CHOICE in
	1) set_env "$OUT/.env" CADDYFILE Caddyfile.http ;;
	2) set_env "$OUT/.env" CADDYFILE Caddyfile.dns ;;
	3) set_env "$OUT/.env" CADDYFILE Caddyfile.internal ;;
esac
set_env "$OUT/.env" CADDY_EMAIL "$EMAIL"
set_env "$OUT/.env" CLOUDFLARE_API_TOKEN "$CF_TOKEN"
set_env "$OUT/.env" OPENVOXA_TRUST_PROXY true
set_env "$OUT/.env" OPENVOXA_KEK "$KEK"
umask 022

if [[ $TLS_CHOICE == 2 || $HTTPS_PORT != 443 || -n $BLOB_DIR ]]; then
	{
		echo "# Written by setup.sh. Gitignored; local to this server."
		echo "services:"
		if [[ $TLS_CHOICE == 2 || $HTTPS_PORT != 443 ]]; then
			echo "  caddy:"
			if [[ $TLS_CHOICE == 2 ]]; then
				echo "    # Caddy with the Cloudflare DNS plugin, for Caddyfile.dns."
				echo "    build:"
				echo "      context: ./caddy"
				echo "    image: !reset null"
			fi
			if [[ $HTTPS_PORT != 443 ]]; then
				echo "    ports: !override"
				echo "      - \"80:80\""
				echo "      - \"$HTTPS_PORT:443\""
			fi
		fi
		if [[ -n $BLOB_DIR ]]; then
			echo "  server:"
			echo "    volumes:"
			echo "      - $BLOB_DIR:/var/lib/openvoxa/blobs"
		fi
	} >"$OUT/docker-compose.override.yml"
fi

if $DRY_RUN; then
	step "Files it would write (secrets included; this is a dry run)"
	for f in "$OUT/.env" "$OUT/docker-compose.override.yml"; do
		[[ -e $f ]] || continue
		say "--- ${f##*/}"
		grep -v '^#' "$f" | grep -v '^$'
	done
	rm -rf "$OUT"
fi

# --------------------------------------------------------- system changes

if $FIX_NIC; then
	say "Making startup wait for $LAN_IFACE (asks for your password)..."
	run sudo sed -i -E "s/^allow-hotplug([[:space:]]+)$LAN_IFACE([[:space:]]|$)/auto\\1$LAN_IFACE\\2/" /etc/network/interfaces
	if systemctl list-unit-files ifupdown-wait-online.service >/dev/null 2>&1; then
		run sudo systemctl enable ifupdown-wait-online.service
	fi
fi
if $BLOB_IS_MOUNT; then
	# Without this, Docker can start before the share is mounted and the
	# server quietly writes uploads to the empty folder underneath.
	say "Making Docker wait for $BLOB_DIR at startup (asks for your password)..."
	run sudo mkdir -p /etc/systemd/system/docker.service.d
	printf '# Written by OpenVoxa setup.sh: start Docker only once the uploads\n# folder is mounted.\n[Unit]\nRequiresMountsFor=%s\n' "$BLOB_DIR" |
		write_root /etc/systemd/system/docker.service.d/openvoxa-blobs.conf
	run sudo systemctl daemon-reload
fi

# ------------------------------------------------------------------- start

step "7/7 Building and starting"
say "The first build takes several minutes."
run docker compose --profile tls up -d --build

SETUP_CODE=""
if ! $DRY_RUN; then
	printf 'Waiting for the server'
	for _ in $(seq 60); do
		SETUP_CODE="$(docker compose logs server 2>/dev/null | grep -o 'setup_code=[^ ]*' | tail -n 1 | cut -d= -f2 | tr -d '"' || true)"
		[[ -n $SETUP_CODE ]] && break
		printf '.'
		sleep 2
	done
	echo
	[[ -n $SETUP_CODE ]] || warn "The server didn't print a setup code yet. Check: docker compose logs server --tail 30"

	# Ask Caddy on this machine directly, so no router loopback is needed.
	# A public certificate can take a minute or two the first time.
	CURL_ARGS=(-fsS --max-time 5 --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1")
	[[ $TLS_CHOICE == 3 ]] && CURL_ARGS+=(-k)
	printf 'Waiting for HTTPS'
	HEALTHY=false
	for _ in $(seq 36); do
		if curl "${CURL_ARGS[@]}" "$SITE_URL/health" >/dev/null 2>&1; then HEALTHY=true; break; fi
		printf '.'
		sleep 5
	done
	echo
	$HEALTHY || warn "HTTPS isn't answering yet; the certificate may still be on its way. Check: docker compose logs caddy --tail 30"
fi

# ------------------------------------------------------------------- cron

if $CRON_BACKUP || $CRON_IP; then
	if ! command -v crontab >/dev/null; then
		$APT || die "cron is missing; install it and add the lines from deploy/README.md."
		run sudo apt-get install -y -qq cron
	fi
	add_cron() {
		if $DRY_RUN; then
			printf '  (dry run) crontab: %s\n' "$1"
		else
			{ crontab -l 2>/dev/null | grep -vF "$2" || true; echo "$1"; } | crontab -
		fi
	}
	$CRON_BACKUP && add_cron "30 3 * * * $DEPLOY_DIR/scripts/backup-keys.sh >> \$HOME/openvoxa-key-backup.log 2>&1" "$DEPLOY_DIR/scripts/backup-keys.sh"
	$CRON_IP && add_cron "*/5 * * * * $DEPLOY_DIR/scripts/update-node-ip.sh >> \$HOME/openvoxa-node-ip.log 2>&1" "$DEPLOY_DIR/scripts/update-node-ip.sh"
fi

# ------------------------------------------------------------------- done

step "Done"
say "Open ${B}$SITE_URL${N}, choose Register, and create the first account."
say "It becomes the administrator and needs this setup code:"
say ""
say "    ${B}${SETUP_CODE:-(see: docker compose logs server | grep setup_code)}${N}"
say ""
say "The code changes whenever the server restarts; get the current one with:"
say "    docker compose logs server | grep setup_code"
say "Then add a second administrator (deploy/README.md, \"First account\")."
if $INTERNET; then
	say ""
	say "On your router, forward these to this machine (${LAN_IP:-its LAN IP}):"
	[[ $TLS_CHOICE == 1 ]] && say "    TCP 80 (certificate renewal)"
	say "    TCP $HTTPS_PORT (the site)"
	say "    UDP 50000-50100 and TCP 7881 (voice and screen share)"
fi
if [[ $TLS_CHOICE == 3 ]]; then
	say ""
	say "Each device must trust this server's certificate once before voice"
	say "works: deploy/README.md, \"Caddyfile.internal\"."
fi
say ""
say "Secrets are in deploy/.env (readable only by you). Back it up somewhere"
say "safe; the account key you saved above is the most important part."
