#!/usr/bin/env bash
# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Backs up the database (accounts, channels, messages, settings) to a
# dated pg_dump archive and prunes old ones. See deploy/README.md,
# "Database backups".
#
# Keep OPENVOXA_DB_BACKUP_DIR apart from the account-key backups
# (backup-keys.sh): a database dump plus a key backup from the same day
# can still show the messages of an account deleted since. Database dumps
# alone are safe to keep for a long time: plaintext-channel content in
# them is sealed under account keys, and encrypted channels were never
# readable by the server. Defaults: ~/openvoxa-db-backups, 30 days.
#
# Run daily from cron on the Docker host, e.g. 03:00:
#   0 3 * * * /home/you/OpenVoxa/deploy/scripts/backup-db.sh >> $HOME/openvoxa-db-backup.log 2>&1
# The user needs to be able to run docker (docker group).

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${OPENVOXA_DB_BACKUP_DIR:-$HOME/openvoxa-db-backups}"
DAYS="${OPENVOXA_DB_BACKUP_DAYS:-30}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# One run at a time, if cron ever overlaps.
exec 9>"${TMPDIR:-/tmp}/openvoxa-db-backup.lock"
flock -n 9 || exit 0

mkdir -p "$DEST"
chmod 700 "$DEST"
umask 077

NAME="openvoxa-db-$(date +%F).dump"
# Written under a temporary name first, so a failed or interrupted dump
# never replaces a good one.
cd "$DEPLOY_DIR"
if ! docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$DEST/$NAME.tmp"; then
	rm -f "$DEST/$NAME.tmp"
	log "pg_dump failed; is the stack up?"
	exit 1
fi
mv "$DEST/$NAME.tmp" "$DEST/$NAME"
log "wrote $DEST/$NAME ($(du -h "$DEST/$NAME" | cut -f1))"

pruned="$(find "$DEST" -maxdepth 1 -name 'openvoxa-db-*.dump' -mtime "+$DAYS" -print -delete | wc -l)"
if [[ $pruned -gt 0 ]]; then
	log "pruned $pruned archive(s) older than $DAYS days"
fi
