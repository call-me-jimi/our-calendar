# Runbook: deploy, roll back, logs

Commands run on the laptop unless marked **(server)**. `DEPLOY_HOST` comes from `.env`
([server.md](server.md)).

## Deploy

```sh
make deploy               # HEAD; refuses while `git status` shows changes
make deploy SHA=abc1234   # any commit (also a rollback)
```

What `infra/scripts/server.sh deploy` does:
1. If the server doesn't have `wannpassts:<sha>` yet: builds it here from `git archive <sha>`
   (exactly the commit, never the working tree), for `linux/amd64`, and streams it over:
   `docker save | gzip | ssh … docker load`. Nothing is built or pulled on the server.
2. Ships the commit's `infra/` to `/srv/wannpassts/releases/<sha>/`.
3. **(server)** `docker compose … up -d --wait` with `compose.yaml` + `compose.prod.yaml`
   and `/srv/wannpassts/.env`; returns once both healthchecks pass. Then points
   `/srv/wannpassts/current` at the release, appends the SHA to `releases/DEPLOYED`,
   refreshes the backup's systemd units, and deletes `wannpassts:*` images except this
   deploy's and the previous one's.
4. From the laptop: `https://$DOMAIN/api/health` and the headers (HSTS, CSP, `nosniff`,
   `Referrer-Policy: no-referrer`, `Permissions-Policy`, no `Server`). It fails loudly if one
   is missing.

The app restarts in a few seconds; Caddy is recreated too (its config path moves with the
release). Sessions live in SQLite and survive.

If `--wait` fails, the new containers are what's running but `current` still names the last
good release: look at the logs (below), then fix forward or roll back.

## Roll back

```sh
ssh deploy@<host> cat /srv/wannpassts/releases/DEPLOYED    # every deploy, newest last
make deploy SHA=<previous sha>
```
The previous deploy's image is still on the server, so this takes seconds. An older one is
rebuilt here from git and uploaded (a few minutes).

**Migrations don't roll back.** They only move forward (plain SQL, run at start). If the
release you're leaving changed the schema in a way the old code can't read, restore the
backup taken before it instead ([backup.md](backup.md#restore-one-night-on-the-server)). So:
before deploying a migration, run `make backup-now`.

## Logs and the app's CLI

```sh
make server-logs                    # app; SERVICE=caddy for Caddy
make server-cli ARGS='create-user --email a@example.com --name "A B"'
make server-signin-link EMAIL=a@example.com
make server-ssh
```
Caddy's access log (7 days, tokens in invite and feed URLs cut out) **(server)**:
```sh
docker exec wannpassts-caddy-1 tail -f /var/log/caddy/access.log
```

## Compose on the server

**(server)** — always from a release directory and with `GIT_SHA` set, so Compose never
looks for another image:
```sh
cd "$(readlink -f /srv/wannpassts/current)"
export GIT_SHA=$(basename "$PWD")
alias dc='docker compose --env-file /srv/wannpassts/.env -p wannpassts -f infra/compose.yaml -f infra/compose.prod.yaml'
dc ps
```

## Housekeeping

Old release directories are a few kB each. Now and then **(server)**:
```sh
cd /srv/wannpassts/releases && ls -t | grep -v DEPLOYED | tail -n +11 | xargs -r rm -r
```
A Caddy version bump leaves the old `caddy` image behind: `docker image prune -a` **(server)**.
