#!/usr/bin/env bash
# The nightly backup (spec §6.4, docs/runbooks/backup.md), run as root on the host by
# wannpassts-backup.service (03:30 Berlin), or now by `make backup-now`:
#   1. sqlite3 .backup: a consistent copy of the live database (WAL and all), as the
#      app's uid, so SQLite never leaves root-owned -wal/-shm files the app can't open;
#   2. restic backup of the copy, then forget --keep-daily 14 --keep-weekly 8
#      --keep-monthly 12 --prune;
#   3. restic check; on Sundays it also reads all the data back (the repository is small).
# Pings HEALTHCHECKS_URL (from /srv/wannpassts/.env) at start, and on success or /fail,
# if it's set. Overrides for the local test: DB, BACKUP_DIR, APP_UID, and restic.sh's.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
srv=/srv/wannpassts
db=${DB:-$srv/data/app.db}
copy=${BACKUP_DIR:-$srv/backup}/app.db
app_uid=${APP_UID:-10001}
restic=$here/restic.sh

ping_url=${HEALTHCHECKS_URL-$(sed -n 's/^HEALTHCHECKS_URL=//p' "$srv/.env" 2>/dev/null | tail -1)}
ping() {
	if [[ -n $ping_url ]]; then
		curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "$ping_url$1" || true
	fi
}
log=$(mktemp)
exec > >(tee "$log") 2>&1
# The failure ping carries the log's tail: counts and paths, never data.
trap 'rc=$?; if ((rc == 0)); then ping ""; else ping /fail "$(tail -c 10000 "$log")"; fi; rm -f "$log"' EXIT
ping /start

if [[ ! -s $db ]]; then
	echo "no database at $db" >&2
	exit 1
fi
as_app() { setpriv --reuid="$app_uid" --regid="$app_uid" --clear-groups "$@"; }
rm -f "$copy"
as_app sqlite3 "$db" ".backup '$copy'"
check=$(as_app sqlite3 "$copy" 'PRAGMA integrity_check')
if [[ $check != ok ]]; then
	echo "the copy fails its integrity check: $check" >&2
	exit 1
fi

# Exit code 10: no repository there yet, so this is the first run.
rc=0
err=$("$restic" cat config 2>&1 >/dev/null) || rc=$?
if ((rc == 10)); then
	"$restic" init
elif ((rc != 0)); then
	echo "$err"
	echo "the repository isn't reachable (restic exit code $rc)" >&2
	exit 1
fi

"$restic" backup --host wannpassts --tag nightly --no-scan "$copy"
"$restic" forget --host wannpassts --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
if [[ $(date +%u) == 7 ]]; then
	"$restic" check --read-data
else
	"$restic" check
fi
"$restic" snapshots --host wannpassts --latest 1 --compact
