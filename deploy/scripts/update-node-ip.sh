#!/usr/bin/env bash
# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Keeps LIVEKIT_NODE_IP in .env equal to this network's public IP, for
# home servers whose ISP changes the address. LiveKit only reads the node
# IP at startup, so on a change this rewrites .env and recreates the
# livekit container (a call in progress drops and reconnects; with the
# old address it had stopped working anyway).
#
# With CLOUDFLARE_API_TOKEN and OPENVOXA_DOMAIN set, it also keeps the
# domain's public A record on that IP, using the token Caddy already has
# (DNS: Edit). It only changes the address of an A record that exists: it
# never creates one and leaves the proxy setting and TTL alone. The record
# is compared on every run, so a failed update is retried 5 minutes later.
#
# Does nothing while LIVEKIT_NODE_IP is a private address (a LAN-only
# server), so switching back to LAN-only also switches this off.
#
# Run from cron on the Docker host, e.g. every 5 minutes:
#   */5 * * * * /home/you/OpenVoxa/deploy/scripts/update-node-ip.sh >> $HOME/openvoxa-node-ip.log 2>&1
# The user needs to be able to run docker (docker group).

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
# Cloudflare's trace page answers with the address it sees, as "ip=...".
IP_URL="${OPENVOXA_IP_URL:-https://1.1.1.1/cdn-cgi/trace}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

is_ipv4() {
	[[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
	local o
	for o in "${BASH_REMATCH[@]:1}"; do ((o <= 255)) || return 1; done
}

is_private() {
	[[ $1 =~ ^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]
}

# One run at a time, if cron ever overlaps a slow docker restart.
exec 9>"${TMPDIR:-/tmp}/openvoxa-update-node-ip.lock"
flock -n 9 || exit 0

[[ -f $ENV_FILE ]] || { log "no $ENV_FILE"; exit 1; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '[:space:]"'"'"; }
current="$(env_get LIVEKIT_NODE_IP)"

if [[ -z $current ]] || ! is_ipv4 "$current" || is_private "$current"; then
	exit 0 # LAN-only (or not set): nothing to follow
fi

public="$(curl -fsS --max-time 10 "$IP_URL" | sed -n 's/^ip=//p' | tr -d '[:space:]')" || {
	log "could not look up the public IP"
	exit 1
}
if ! is_ipv4 "$public" || is_private "$public"; then
	log "lookup returned '$public', not a public IPv4 address; leaving .env alone"
	exit 1
fi

CF_API="https://api.cloudflare.com/client/v4"

# A Cloudflare API call. The token goes in on stdin, never on the command
# line, where other users could read it in the process list.
cf() {
	local method=$1 path=$2
	shift 2
	printf 'Authorization: Bearer %s\n' "$CF_TOKEN" |
		curl -fsS --max-time 15 -X "$method" -H @- "$@" "$CF_API$path"
}

# The first object's 32-hex "id" in a {"result":[{"id":...}]} answer.
first_id() { grep -o '"result":\[{"id":"[0-9a-f]\{32\}"' | grep -o '[0-9a-f]\{32\}' | head -n 1 || true; }

# Points the domain's existing A record at $1. Returns non-zero on failure.
update_dns() {
	local ip=$1 name=$OPENVOXA_DOMAIN zone="" zone_name=$OPENVOXA_DOMAIN answer record content count
	# The zone is the longest suffix of the domain Cloudflare knows.
	while [[ $zone_name == *.* ]]; do
		answer="$(cf GET "/zones?name=$zone_name")" || { log "dns: could not reach Cloudflare"; return 1; }
		zone="$(first_id <<<"$answer")"
		[[ -n $zone ]] && break
		zone_name="${zone_name#*.}"
	done
	[[ -n $zone ]] || { log "dns: the token can't see a zone for $name"; return 1; }

	answer="$(cf GET "/zones/$zone/dns_records?type=A&name=$name")" || { log "dns: could not read the A record for $name"; return 1; }
	count="$(grep -o '"total_count":[0-9]*' <<<"$answer" | grep -o '[0-9]*$' || true)"
	if [[ $count != 1 ]]; then
		# None: a server that isn't meant to be public (or not yet). Several:
		# set up by hand on purpose. Either way, not ours to change.
		[[ $count == 0 ]] && return 0
		log "dns: $name has ${count:-?} A records; leaving them alone"
		return 1
	fi
	record="$(first_id <<<"$answer")"
	content="$(grep -o '"content":"[^"]*"' <<<"$answer" | head -n 1 | sed 's/^"content":"//; s/"$//' || true)"
	[[ $content == "$ip" ]] && return 0

	cf PATCH "/zones/$zone/dns_records/$record" -H "Content-Type: application/json" \
		--data "{\"content\":\"$ip\"}" >/dev/null || { log "dns: updating $name failed"; return 1; }
	log "dns: $name A record $content -> $ip"
}

status=0
if [[ $public != "$current" ]]; then
	log "public IP changed: $current -> $public; updating .env and recreating livekit"
	sed -i "s/^LIVEKIT_NODE_IP=.*/LIVEKIT_NODE_IP=$public/" "$ENV_FILE"
	(cd "$DEPLOY_DIR" && docker compose up -d --no-deps --force-recreate livekit)
	log "done"
fi

CF_TOKEN="$(env_get CLOUDFLARE_API_TOKEN)"
OPENVOXA_DOMAIN="$(env_get OPENVOXA_DOMAIN)"
if [[ -n $CF_TOKEN && $OPENVOXA_DOMAIN == *.* ]]; then
	update_dns "$public" || status=1
fi
exit $status
