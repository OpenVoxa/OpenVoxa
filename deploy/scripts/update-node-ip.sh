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
current="$(sed -n 's/^LIVEKIT_NODE_IP=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]"'"'")"

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

[[ $public == "$current" ]] && exit 0

log "public IP changed: $current -> $public; updating .env and recreating livekit"
sed -i "s/^LIVEKIT_NODE_IP=.*/LIVEKIT_NODE_IP=$public/" "$ENV_FILE"
cd "$DEPLOY_DIR"
docker compose up -d --no-deps --force-recreate livekit
log "done"
