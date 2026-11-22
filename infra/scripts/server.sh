#!/usr/bin/env bash
# The server, driven from the laptop over SSH (P7, docs/runbooks/{server,deploy,backup}.md).
#
#   server.sh init           write /srv/wannpassts/.env from infra/server/env.example, once,
#                            with DOMAIN set to the server's sslip.io name
#   server.sh deploy         build the image of HEAD (or SHA=…) here, ship it and the
#                            commit's infra/ to releases/<sha>, start it, check it from here
#   server.sh cli ARGS…      the app's CLI (python -m wannpassts.cli) in the running container
#   server.sh logs [SERVICE] follow a service's logs (default app)
#   server.sh ssh            a shell in /srv/wannpassts
#   server.sh backup-init    keys and repository on the Storage Box, then the nightly timer
#   server.sh backup-now     run the backup now and show its log
#   server.sh backup-status  the timer, the last run, and the repository's snapshots
#   server.sh backup-secrets copy the restic password, the box's key and its address
#                            to .local/secrets/ (for the restore drill)
#
# DEPLOY_HOST (user@host) comes from the environment or this repo's .env.
# The remote scripts are single-quoted on purpose: they expand on the server.
# shellcheck disable=SC2016,SC2029
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

step=${1:?usage: server.sh init|deploy|cli|logs|ssh|backup-init|backup-now|backup-status|backup-secrets}
shift
host=${DEPLOY_HOST:-$(sed -n 's/^DEPLOY_HOST=//p' .env 2>/dev/null | tail -1)}
if [[ -z $host ]]; then
	echo "set DEPLOY_HOST=deploy@<server IPv4> in .env (make server-create prints it)" >&2
	exit 1
fi

# Prepended to every remote script. `dc` is Compose for the running release, always
# with GIT_SHA, so it never looks for (or builds) another image.
read -r -d '' lib <<'LIB' || true
set -euo pipefail
srv=/srv/wannpassts
setting() { sed -n "s/^$1=//p" "$srv/.env" | tail -1; }
dc() {
	local release
	release=$(readlink -f "$srv/current")
	GIT_SHA=$(basename "$release") docker compose --env-file "$srv/.env" -p wannpassts \
		-f "$release/infra/compose.yaml" -f "$release/infra/compose.prod.yaml" "$@"
}
need_release() {
	[[ -e $srv/current ]] || { echo "nothing deployed yet: make deploy" >&2; exit 1; }
}
LIB

# remote [-t] SCRIPT [ARG…]: SCRIPT runs in bash on the server, with $1… = ARG….
remote() {
	local tty=()
	if [[ $1 == -t ]]; then
		tty=(-t)
		shift
	fi
	local script=$1
	shift
	local args=""
	if (($#)); then args=$(printf '%q ' "$@"); fi
	ssh "${tty[@]}" "$host" "bash -c $(printf %q "$lib"$'\n'"$script") _ $args"
}

# The headers spec §6.2 asks for, and /api/health, from outside.
check_site() {
	local domain=$1 ok=true headers
	echo "checking https://$domain"
	for _ in $(seq 30); do
		if curl -fsS -m 10 -o /dev/null "https://$domain/api/health" 2>/dev/null; then break; fi
		sleep 2
	done
	curl -fsS -m 10 "https://$domain/api/health" >/dev/null || {
		echo "  /api/health: no answer (first deploy? Caddy may still be fetching the certificate)" >&2
		return 1
	}
	echo "  /api/health: 200"
	headers=$(curl -fsSI -m 10 "https://$domain/" | tr -d '\r')
	for h in "strict-transport-security: max-age=31536000" "content-security-policy: default-src 'self'" \
		"x-content-type-options: nosniff" "referrer-policy: no-referrer" "permissions-policy:"; do
		if grep -qiF "$h" <<<"$headers"; then
			echo "  ok: $h"
		else
			echo "  MISSING: $h" >&2
			ok=false
		fi
	done
	if grep -qi '^server:' <<<"$headers"; then
		echo "  a Server header is sent" >&2
		ok=false
	fi
	$ok
}

deploy() {
	local sha
	if [[ -n ${SHA:-} ]]; then
		sha=$(git rev-parse --short=7 "$SHA^{commit}")
	else
		if [[ -n $(git status --porcelain) ]]; then
			git status --short >&2
			echo "uncommitted changes: commit or stash them first. A deploy builds the commit, not" >&2
			echo "the working tree, so they wouldn't go out (or SHA=… to deploy a commit anyway)." >&2
			exit 1
		fi
		sha=$(git rev-parse --short=7 HEAD)
	fi
	local image=wannpassts:$sha release=/srv/wannpassts/releases/$sha
	echo "deploy: $sha to $host"

	if remote 'docker image inspect "$1" >/dev/null 2>&1' "$image"; then
		echo "the server has $image already"
	else
		# From `git archive`, not the working tree: the image is exactly the commit. (A
		# local `make up` tags its image the same way but builds whatever is checked out.)
		git archive "$sha" | docker build --platform linux/amd64 -f infra/Dockerfile -t "$image" -
		echo "uploading $image"
		docker save "$image" | gzip | ssh "$host" docker load
	fi
	git archive "$sha" infra | ssh "$host" "mkdir -p $release && tar -x -C $release"

	remote '
[[ -f $srv/.env ]] || { echo "no $srv/.env: make server-init first" >&2; exit 1; }
sha=$1 release=$srv/releases/$1
# Before the containers, or Docker makes the bind mount as root (compose.prod.yaml).
sudo install -d -m 0700 -o 10001 -g 10001 "$srv/data" "$srv/backup"
cd "$release"
GIT_SHA=$sha docker compose --env-file "$srv/.env" -p wannpassts \
	-f infra/compose.yaml -f infra/compose.prod.yaml up -d --wait --no-build --remove-orphans
ln -sfn "$release" "$srv/current"
echo "$(date -u +%FT%TZ) $sha" >>"$srv/releases/DEPLOYED"
# The backup runs from `current`; its units come with the release (backup-init enables it).
sudo install -m 0644 infra/backup/wannpassts-backup.service infra/backup/wannpassts-backup.timer \
	/etc/systemd/system/
sudo systemctl daemon-reload
# Keep the images of this deploy and the previous one (a quick rollback), drop older ones.
keep=$(tac "$srv/releases/DEPLOYED" | awk "!seen[\$2]++ && n++ < 2 { print \$2 }" | paste -sd"|")
docker images --format "{{.Repository}}:{{.Tag}}" | grep "^wannpassts:" |
	grep -vE ":($keep)\$" | xargs -r docker rmi >/dev/null || true
docker image prune -f >/dev/null
dc ps --format "{{.Service}}: {{.Status}}"
' "$sha"
	check_site "$(remote 'setting DOMAIN')"
}

case $step in
init)
	remote '
if [[ -f $srv/.env ]]; then
	echo "$srv/.env exists, left as it is:"
else
	ip=$(ip -4 route get 1.1.1.1 | sed -n "s/.* src \([0-9.]*\).*/\1/p")
	(umask 077 && sed "s/^DOMAIN=.*/DOMAIN=${ip//./-}.sslip.io/" >"$srv/.env")
	echo "wrote $srv/.env:"
fi
grep -v "^#" "$srv/.env" | grep .
' <infra/server/env.example
	;;
deploy)
	deploy
	;;
cli)
	remote 'need_release; dc exec -T app python -m wannpassts.cli "$@"' "$@"
	;;
logs)
	remote -t 'need_release; dc logs -f --tail 100 "$1"' "${1:-app}"
	;;
ssh)
	exec ssh -t "$host" 'cd /srv/wannpassts && exec bash -l'
	;;
backup-init)
	remote -t '
need_release
box=$1
if [[ -n $box ]]; then
	if grep -q "^STORAGE_BOX=" "$srv/.env"; then
		sed -i "s|^STORAGE_BOX=.*|STORAGE_BOX=$box|" "$srv/.env"
	else
		echo "STORAGE_BOX=$box" >>"$srv/.env"
	fi
fi
box=$(setting STORAGE_BOX)
if [[ $box != ?*@?*.your-storagebox.de ]]; then
	echo "make backup-init STORAGE_BOX=<sub-account>@<sub-account>.your-storagebox.de" >&2
	exit 1
fi
s=$srv/secrets pinned=$srv/current/infra/backup/known_hosts
if ! sudo test -s "$s/restic_password"; then
	sudo sh -c "umask 077 && head -c 32 /dev/urandom | base64 >$s/restic_password"
	echo "made $s/restic_password"
fi
if ! sudo test -s "$s/backup_ssh_key"; then
	sudo ssh-keygen -q -t ed25519 -N "" -C wannpassts-backup -f "$s/backup_ssh_key"
	echo "made $s/backup_ssh_key"
fi

echo "The Storage Box host keys, scanned now (compare with the pinned ones in infra/backup/known_hosts):"
scan=$(ssh-keyscan -p 23 -t ed25519,rsa "${box#*@}" 2>/dev/null)
[[ -n $scan ]] || { echo "no answer from ${box#*@} on port 23 (SSH support on?)" >&2; exit 1; }
ssh-keygen -lf - <<<"$scan"
while read -r host type key; do
	[[ $host == "#"* ]] && continue # OpenSSH 10 prints a "# host SSH-2.0-…" banner line
	if ! grep -qF "$type $key" "$pinned"; then
		echo "the box shows a $type key that is not pinned: stop, and find out why" >&2
		exit 1
	fi
done <<<"$scan"
echo "they match the pinned keys"

if sudo ssh -p 23 -i "$s/backup_ssh_key" -o IdentitiesOnly=yes -o BatchMode=yes \
	-o UserKnownHostsFile="$pinned" -o StrictHostKeyChecking=yes "$box" true 2>/dev/null; then
	echo "the key already works on $box"
else
	echo "installing the key on $box: type the sub-account password (from the Hetzner console)"
	sudo cat "$s/backup_ssh_key.pub" | ssh -p 23 -o PubkeyAuthentication=no \
		-o UserKnownHostsFile="$pinned" -o StrictHostKeyChecking=yes "$box" install-ssh-key
fi

rc=0
sudo "$srv/current/infra/backup/restic.sh" cat config >/dev/null 2>&1 || rc=$?
if ((rc == 10)); then
	sudo "$srv/current/infra/backup/restic.sh" init
elif ((rc != 0)); then
	echo "restic cannot open the repository (exit code $rc)" >&2
	exit 1
fi
sudo systemctl enable --now wannpassts-backup.timer
systemctl list-timers wannpassts-backup.timer --no-pager
echo
echo "Next: make backup-now, then make backup-secrets (docs/runbooks/backup.md)."
' "${STORAGE_BOX:-}"
	;;
backup-now)
	remote '
need_release
rc=0
sudo systemctl start wannpassts-backup.service || rc=$?
sudo journalctl -u wannpassts-backup.service -n 25 --no-pager -o cat
exit $rc
'
	;;
backup-status)
	remote '
systemctl list-timers wannpassts-backup.timer --no-pager
echo
systemctl status wannpassts-backup.service --no-pager -n 0 | sed -n "1,4p" || true
echo
sudo "$srv/current/infra/backup/restic.sh" snapshots --no-lock --compact
'
	;;
backup-secrets)
	mkdir -p .local/secrets
	(
		umask 077
		remote 'sudo cat "$srv/secrets/restic_password"' >.local/secrets/restic_password
		remote 'sudo cat "$srv/secrets/backup_ssh_key"' >.local/secrets/backup_ssh_key
		remote 'setting STORAGE_BOX' >.local/secrets/storage_box
	)
	echo "wrote .local/secrets/{restic_password,backup_ssh_key,storage_box}."
	echo "Put all three in the password manager too: without the password, the backups can't be read."
	;;
*)
	echo "unknown step $step" >&2
	exit 1
	;;
esac
