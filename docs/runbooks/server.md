# Runbook: the server from nothing

The first setup, and a rebuild after losing the box (then restore the data:
[backup.md](backup.md#after-losing-the-server)). About 30 minutes. Commands run on the
laptop, in this repo, unless marked **(server)**. The laptop needs Docker, `uv` and an
SSH key.

## 1. Hetzner API token

The server lives in its **own Hetzner Cloud project**, so this token can't touch
your other servers.

1. https://console.hetzner.com → **+ New project** → name `wannpassts` → open it.
2. **Security** (left) → **API tokens** → **Generate API token** → description
   `wannpassts laptop`, permissions **Read & Write** → **Generate**.
3. Copy the token, then save it without echoing it (and keep it in the password manager):
   ```sh
   mkdir -p .local/secrets
   (umask 077; read -rsp 'token: ' t; printf %s "$t" > .local/secrets/hcloud_token)
   ```

## 2. Firewall and server

1. Create both:
   ```sh
   make server-create        # LOGIN_KEY=~/.ssh/other.pub if your key isn't id_rsa/id_ed25519
   ```
   - Cloud Firewall `wannpassts`, inbound only: TCP 22, 80, 443, UDP 443 (HTTP/3), ICMP.
     Docker's published ports bypass ufw, so this firewall is the one that counts.
   - Server `wannpassts-prod`: `cx23` (smallest shared x86), Ubuntu 26.04, Nuremberg
     (`nbg1`), `infra/server/cloud-init.yaml` as its cloud config. If Hetzner no longer
     offers the type, it stops before creating anything and lists the cheapest current
     ones: rerun with `SERVER_TYPE=<name>`.
   - It waits for cloud-init (a few minutes), then prints the IPv4, the sslip.io domain and
     the ssh command. Safe to rerun: an existing server is left alone; the firewall's rules
     are reset if someone changed them.
2. In this repo's `.env`, set the line it printed:
   ```sh
   DEPLOY_HOST=deploy@<IPv4>
   ```
3. Check the box:
   ```sh
   ssh deploy@<IPv4> 'cloud-init status; docker version --format {{.Server.Version}}'
   ssh root@<IPv4>                                                    # must be refused
   ssh -o PubkeyAuthentication=no deploy@<IPv4>                        # must be refused
   ```

## 3. Settings and first deploy

1. Write the server's settings:
   ```sh
   make server-init
   ```
   It copies `infra/server/env.example` to `/srv/wannpassts/.env` once, with
   `DOMAIN=<a-b-c-d>.sslip.io` from the server's IPv4, and prints it. Optional:
   `ACME_EMAIL` (Let's Encrypt's contact), `OPERATOR_NAME` (named on the privacy page) — edit with `make server-ssh`, then
   `nano .env` **(server)**.
2. Deploy (needs a clean `git status`):
   ```sh
   make deploy
   ```
   Caddy fetches the certificate on the first request; the deploy waits for it, then checks
   `/api/health` and the security headers. Details: [deploy.md](deploy.md).
3. Your admin account, then a sign-in link for it (production sends no mail):
   ```sh
   make server-cli ARGS='create-user --email you@example.com --name "Your Name" --admin'
   make server-signin-link EMAIL=you@example.com
   ```
   Open the printed link (24 h, single use) and set a password under **Account**; later
   sign-ins use it. Locked out: `make server-signin-link` again.
5. Inviting people: [invite.md](invite.md).
4. Backups: [backup.md](backup.md), "First setup". Do it before inviting anyone.

## Rebuild on a new box

1. Delete the old server in the console (or keep it until the new one runs; then rename it
   first, because `make server-create` looks for `wannpassts-prod`).
2. Sections 2 and 3 above. If the new box got the old IPv4, drop the old host key first:
   `ssh-keygen -R <IPv4>`.
3. Restore the data: [backup.md](backup.md#after-losing-the-server).

## A real domain later

1. At the registrar: `A` record → the server's IPv4 (and `AAAA` → its IPv6, from the
   console).
2. `make server-ssh`, then in `.env` **(server)**: `DOMAIN=<the domain>`, and
   `OLD_DOMAIN=<the name until now>` so old links and bookmarks redirect.
3. `make deploy SHA=$(git rev-parse --short HEAD)` (same release, new settings). Caddy gets
   the new certificate. Everyone signs in again (cookies belong to a host), and iCal feed
   URLs and invite links still name the old host, so hand out new ones.
