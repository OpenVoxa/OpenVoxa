#!/usr/bin/env bash
# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Backs up the account-key folder (the deploy_key-data volume) to a dated
# archive and prunes old ones. These keys are what make crypto-shredding
# work: deleting an account deletes its key. See deploy/README.md,
# "Account keys and backups".
#
# Two rules this script exists to enforce:
#   - SEPARATE from the database backups. Keep OPENVOXA_KEY_BACKUP_DIR
#     somewhere your database dumps do NOT also go, so one stolen location
#     is never both halves.
#   - SHORT-LIVED. An account deletion is only complete once the last key
#     backup holding that key is gone. Old archives are pruned after
#     OPENVOXA_KEY_BACKUP_DAYS days (default 7).
#
# If OPENVOXA_KEK is set, the keys in the archive are already wrapped
# under it; keep that key OUT of this archive, or you have recombined both
# halves.
#
# Run daily from cron on the Docker host, e.g. 03:30:
#   30 3 * * * /home/you/OpenVoxa/deploy/scripts/backup-keys.sh >> $HOME/openvoxa-key-backup.log 2>&1
# The user needs to be able to run docker (docker group).

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VOLUME="${OPENVOXA_KEY_VOLUME:-deploy_key-data}"
DEST="${OPENVOXA_KEY_BACKUP_DIR:-$HOME/openvoxa-key-backups}"
DAYS="${OPENVOXA_KEY_BACKUP_DAYS:-7}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# One run at a time, if cron ever overlaps.
exec 9>"${TMPDIR:-/tmp}/openvoxa-key-backup.lock"
flock -n 9 || exit 0

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
	log "volume $VOLUME not found; is the stack up and is OPENVOXA_KEY_VOLUME right?"
	exit 1
fi

mkdir -p "$DEST"
chmod 700 "$DEST"

NAME="openvoxa-keys-$(date +%F).tar.gz"
OWNER="$(id -u):$(id -g)"

# The container runs as root so it can read the key folder (mode 700,
# owned by UID 65532), then hands the archive back owned by this user at
# mode 600 so the prune below can manage it without root.
docker run --rm \
	-v "$VOLUME":/keys:ro \
	-v "$DEST":/out \
	alpine sh -c "set -e
		tar czf /out/'$NAME' -C /keys .
		chmod 600 /out/'$NAME'
		chown $OWNER /out/'$NAME'"

log "wrote $DEST/$NAME"

# Prune archives older than DAYS. An account deleted since an archive was
# taken stays recoverable (from that archive plus a database backup and
# the KEK) until the archive is gone, which is why this matters.
pruned="$(find "$DEST" -maxdepth 1 -name 'openvoxa-keys-*.tar.gz' -mtime "+$DAYS" -print -delete | wc -l)"
if [[ $pruned -gt 0 ]]; then
	log "pruned $pruned archive(s) older than $DAYS days"
fi
