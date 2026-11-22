#!/usr/bin/env bash
# The restore drill (spec §6.4, docs/runbooks/backup.md): `make restore-drill [EMAIL=…]`.
#
# Restores a snapshot (SNAPSHOT=…, default the latest) from the Storage Box to this laptop,
# straight from the keys in .local/secrets/ (no server involved, as after losing it), and
# runs the app on it at http://localhost:8090. With EMAIL=… it prints a sign-in link for
# that account. Enter stops it and deletes the restored copy: it's real personal data.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

secrets=${SECRETS:-$PWD/.local/secrets}
for f in restic_password backup_ssh_key storage_box; do
	if [[ ! -s $secrets/$f ]]; then
		echo "no .local/secrets/$f: docs/runbooks/backup.md, \"Keys on the laptop\"" >&2
		exit 1
	fi
done
chmod 0600 "$secrets/backup_ssh_key"

name=wannpassts-drill port=8090
drill=$PWD/.local/drill
cleanup() {
	docker rm -f "$name" >/dev/null 2>&1 || true
	rm -rf "$drill"
}
trap cleanup EXIT
cleanup
mkdir -p "$drill/data"

restic() {
	SECRETS=$secrets STORAGE_BOX=$(<"$secrets/storage_box") infra/backup/restic.sh "$@"
}
snapshot=${SNAPSHOT:-latest}
restic snapshots --no-lock --compact "$snapshot"
# --no-lock: the drill only reads, and never holds up the server's nightly run.
restic restore --no-lock "$snapshot" --target "$drill/restore" --include /srv/wannpassts/backup/app.db
mv "$drill/restore/srv/wannpassts/backup/app.db" "$drill/data/app.db"

# The image of this checkout's commit, built like `make deploy` builds it (quick when
# cached; a `make up` image of the same tag may hold uncommitted changes).
image=wannpassts:$(git rev-parse --short=7 HEAD)
git archive HEAD | docker build --platform linux/amd64 -q -f infra/Dockerfile -t "$image" - >/dev/null
# As this user, so the files stay ours; no holiday sync (no network needed).
docker run -d --name "$name" --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp \
	-p "127.0.0.1:$port:8000" -v "$drill/data:/data" \
	-e BASE_URL="http://localhost:$port" -e HOLIDAY_SYNC=false "$image" >/dev/null
for _ in $(seq 30); do
	if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null; then break; fi
	sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health" || {
	docker logs "$name" >&2
	echo "the app didn't come up on the restored database" >&2
	exit 1
}

echo
echo "restored $snapshot; the app runs on it at http://localhost:$port"
docker exec "$name" python -c '
import sqlite3
db = sqlite3.connect("/data/app.db")
for table in ("users", "groups", "memberships", "day_marks", "events"):
    print(f"  {table}:", db.execute("SELECT count(*) FROM " + table).fetchone()[0])
'
if [[ -n ${EMAIL:-} ]]; then
	echo
	echo "sign in (Chrome or Firefox: they allow the secure cookie on http://localhost):"
	docker exec "$name" python -m ourcalendar.cli signin-link --email "$EMAIL" || true
else
	echo "a sign-in link: docker exec $name python -m ourcalendar.cli signin-link --email <you>"
fi
echo
read -rp "Enter stops the app and deletes the restored copy. "
