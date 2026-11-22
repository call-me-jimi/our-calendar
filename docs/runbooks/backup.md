# Runbook: backups and the restore drill

Every night at 03:30 Berlin time (plus up to 10 minutes), `wannpassts-backup.timer` on the
server runs `infra/backup/backup.sh` as root:
1. `sqlite3 /srv/wannpassts/data/app.db ".backup /srv/wannpassts/backup/app.db"` — a
   consistent copy of the live database (WAL included), run as the app's uid 10001 — then
   an integrity check of the copy;
2. `restic backup` of the copy to the Storage Box, then
   `restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune`;
3. `restic check` (on Sundays with `--read-data`: the repository is small).

Where: an existing Hetzner Storage Box (here `u123456`),
through a **sub-account of its own** whose base directory is `wannpassts`. It sees only
that directory; anything else on the box stays invisible to this server. The repository is
`restic/` inside it, encrypted by restic, so the box only holds ciphertext. The box's own
automatic snapshots, if enabled, cover this directory too: a hijacked server
could delete the repository over SFTP, but not those.

Secrets, all **(server)** in `/srv/wannpassts/secrets/` (root, 0600), and in the password
manager:
- `restic_password` — **without it the backups can't be read**;
- `backup_ssh_key` — the sub-account's SSH key.

The sub-account's address is `STORAGE_BOX` in `/srv/wannpassts/.env`.

## First setup (once)

1. **Sub-account** (browser): https://console.hetzner.com → the project holding the Storage
   Box → **Storage Boxes** → your box → **Sub-accounts** → **Create sub-account**:
   - base directory: `wannpassts`;
   - **SSH support: on**; Samba and WebDAV: off; read-only: off;
   - **External reachability: on** (the restore drill runs on the laptop, outside
     Hetzner);
   - a generated password: save it in the password manager (needed once, step 2);
   - note its username, e.g. `u123456-sub2`.
2. **Keys, repository, timer:**
   ```sh
   make backup-init STORAGE_BOX=u123456-sub2@u123456-sub2.your-storagebox.de
   ```
   It writes `STORAGE_BOX` to the server's `.env`, makes `restic_password` and
   `backup_ssh_key` if missing, scans the box's host keys and prints their fingerprints:
   they must match `infra/backup/known_hosts` (pinned from a scan on
   2026-10-29: ED25519 `SHA256:XqONwb1S0zuj5A1CDxpOSuD2hnAArV1A3wKY7Z3sdgM`), and it stops
   if not. Then it installs the public key on the sub-account with the box's
   `install-ssh-key` command: **type the sub-account password** when asked. Finally it
   creates the repository and enables the timer. Safe to rerun.
3. **First backup:**
   ```sh
   make backup-now
   ```
4. **Keys on the laptop** (for the restore drill), and in the password manager:
   ```sh
   make backup-secrets       # writes .local/secrets/{restic_password,backup_ssh_key,storage_box}
   ```
   Put all three in the password manager (entry "wannpassts backups"), together with the
   sub-account password.
5. **Restore drill:** `make restore-drill` (below). Do it now, before inviting anyone.
6. Optional, **alerts**: on healthchecks.io a check with period 1 day, grace 2 hours. Put
   its ping URL in the server's `.env` (`make server-ssh`, `nano .env`):
   `HEALTHCHECKS_URL=https://hc-ping.com/…`. The job pings at start, on success, and on
   failure with the log's tail. Empty: no pings.

## Day to day

```sh
make backup-status        # the timer's last and next run, the last result, the snapshots
make backup-now           # a backup now (e.g. before deploying a migration), with its log
```
By hand **(server)**:
```sh
sudo journalctl -u wannpassts-backup -n 50
sudo /srv/wannpassts/current/infra/backup/restic.sh snapshots
```

## Restore drill

```sh
make restore-drill EMAIL=you@example.com
```
`infra/scripts/restore_drill.sh`, on the laptop only, with the keys from
`.local/secrets/` (as after losing the server):
1. restores the latest snapshot (`SNAPSHOT=<id>` for another) into `.local/drill/`;
2. builds the image of the checked-out commit and runs it on the copy at
   http://localhost:8090 (no holiday sync, nothing published beyond 127.0.0.1);
3. prints the row counts and, with `EMAIL`, a sign-in link: open it in Chrome or Firefox
   and check that your groups are there;
4. **Enter** stops the app and deletes the copy: it's real personal data.

Run it once before inviting people, and again whenever the schema changes.

## Restore one night on the server

**(server)**, `dc` as in [deploy.md](deploy.md#compose-on-the-server):
```sh
sudo /srv/wannpassts/current/infra/backup/restic.sh snapshots              # pick one, or latest
dc stop caddy app
sudo /srv/wannpassts/current/infra/backup/restic.sh restore <id> --target /tmp/restore \
  --include /srv/wannpassts/backup/app.db
sudo rm -f /srv/wannpassts/data/app.db /srv/wannpassts/data/app.db-wal /srv/wannpassts/data/app.db-shm
sudo install -o 10001 -g 10001 -m 0600 /tmp/restore/srv/wannpassts/backup/app.db /srv/wannpassts/data/app.db
sudo rm -rf /tmp/restore
dc up -d --wait
```
Everything written after that night is gone; take a `make backup-now` first if the current
state might still be needed.

## After losing the server

1. A new box: [server.md](server.md) sections 2 and 3 (an empty database is created).
2. The keys from the password manager to the new box (laptop):
   ```sh
   for f in restic_password backup_ssh_key; do
     ssh deploy@<host> "sudo install -m 0600 /dev/stdin /srv/wannpassts/secrets/$f" < .local/secrets/$f
   done
   ssh deploy@<host> 'sudo sh -c "ssh-keygen -y -f /srv/wannpassts/secrets/backup_ssh_key > /srv/wannpassts/secrets/backup_ssh_key.pub"'
   make backup-init STORAGE_BOX=$(cat .local/secrets/storage_box)
   ```
   The key already works on the box and the repository exists, so it only re-enables the
   timer.
3. "Restore one night on the server", above, with `latest`.
