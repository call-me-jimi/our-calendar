#!/usr/bin/env bash
# restic against the backups' repository on the Storage Box (docs/runbooks/backup.md).
#   (server)  sudo /srv/wannpassts/current/infra/backup/restic.sh snapshots
#   (laptop)  the restore drill calls it with SECRETS=.local/secrets and STORAGE_BOX set
#
# The repository is `restic/` in the sub-account's home, which is its base directory
# (a relative path, so it doesn't depend on how the box shows that directory). The box's
# host key must match infra/backup/known_hosts.
# Overrides, for the laptop and the local test: SECRETS (dir with restic_password and
# backup_ssh_key), STORAGE_BOX (user@host), RESTIC_REPOSITORY (then no SSH at all).
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
srv=/srv/wannpassts
secrets=${SECRETS:-$srv/secrets}
args=()
if [[ -z ${RESTIC_REPOSITORY:-} ]]; then
	box=${STORAGE_BOX:-$(sed -n 's/^STORAGE_BOX=//p' "$srv/.env" 2>/dev/null | tail -1)}
	if [[ $box != ?*@?* ]]; then
		echo "STORAGE_BOX isn't set (user@host, in $srv/.env): make backup-init" >&2
		exit 1
	fi
	export RESTIC_REPOSITORY="sftp:$box:restic"
	args=(-o "sftp.command=ssh -p 23 -i $secrets/backup_ssh_key -o IdentitiesOnly=yes \
-o BatchMode=yes -o UserKnownHostsFile=$here/known_hosts -o StrictHostKeyChecking=yes \
-o ServerAliveInterval=60 $box -s sftp")
fi
export RESTIC_PASSWORD_FILE=${RESTIC_PASSWORD_FILE:-$secrets/restic_password}
exec restic "${args[@]}" "$@"
