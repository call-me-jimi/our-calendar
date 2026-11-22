# Wann passt's?

*"When suits?"* — a small, self-hosted web app where a group of friends (a band, a sports team, a family)
marks the days they can't make it, and sees at a glance which days suit everyone.

It is built for **one private instance per person or club**: there is no public sign-up, people join a group
through its invite link. The UI is in German and English.

## Features

- **Meine Tage** (my days): tap or drag across a month calendar to mark days as *busy* or *maybe*
  (everything else is *free*), with an optional note. Undo, keyboard support, multi-day selection on phones.
- **Gruppe** (the group): a calendar with one box per member per day, or a table with one row per member.
  Days everyone can make are green. **Passende Tage finden** lists runs of matching days by weekday and length.
- **Group events**: plan an event on a day or a range. Every member gets a personal **iCal feed** to
  subscribe to in their calendar app.
- **Holidays**: public and school holidays per group region, fetched daily from the
  [OpenHolidays API](https://openholidaysapi.org) (no key needed).
- **Roles**: member, group admin (invite links, members, settings), instance admin (groups, all accounts).
- **Sign-in** with email and password. Optional email magic links when SMTP is configured. Without mail,
  admins hand out single-use sign-in links (by messenger) to people who forgot their password.
- **Privacy**: no tracking, no third-party requests from the browser, a public privacy page, self-service
  account deletion.
- **Phone-friendly**: responsive, installable on the home screen (web app manifest), light and dark themes.

## Tech stack

| Part | What |
| --- | --- |
| Backend | Python 3.13, FastAPI, uvicorn, SQLite (stdlib `sqlite3`, WAL, plain SQL migrations), managed with [uv](https://docs.astral.sh/uv/) |
| Frontend | React 19, TypeScript, Vite, React Router, TanStack Query, plain CSS. No UI library |
| Serving | One Docker image (the API also serves the built SPA) behind [Caddy](https://caddyserver.com) (TLS, security headers) |
| Tests | pytest (including a permission matrix over every endpoint and role), vitest, Playwright end to end |
| Ops | Docker Compose, a Hetzner Cloud server set up by cloud-init, nightly [restic](https://restic.net) backups to a Hetzner Storage Box |

```
Browser (React SPA) ──HTTPS──▶ Caddy ──▶ app: FastAPI + uvicorn (1 worker)
                                          ├─ /api, /feed and the built SPA
                                          ├─ SQLite file on a volume
                                          ├─ daily holiday sync (in process)
                                          └─ SMTP (optional)
```

## Run it locally

Needs Docker, [uv](https://docs.astral.sh/uv/) and Node 24 (see `.node-version`).

```sh
make install                                  # backend and frontend dependencies
make up                                       # build and start; creates .env from .env.example on first run
make trust                                    # export Caddy's local root certificate; import it into your browser once
make create-admin EMAIL=you@example.com NAME=You
```

Open https://wann.localhost:8444 and sign in. The sign-in link arrives in Mailpit at http://127.0.0.1:8026.
Then set a password under **Account**, create a group under **Admin**, and invite people with a link from the
group's **Settings**.

| Command | What |
| --- | --- |
| `make help` | every target, with a short description |
| `make check` | ruff, mypy, pytest, ESLint, tsc, vitest, and the infra checks (what CI runs) |
| `make e2e` | Playwright against the running stack (run `npx playwright install chromium` in `frontend/` once) |
| `make dev-api` + `make dev-web` | API with reload on :8000, Vite on :5173 (proxies `/api`). Without `make up`, sign-in links go to the API's log |
| `make signin-link EMAIL=…` | print a sign-in link (24 h, single use) |
| `make sync-holidays` | fetch holidays now |
| `make logs SERVICE=caddy` | follow one service's logs |
| `make down` / `make nuke` | stop / stop and delete the data volumes |

## Configuration

The app reads its settings from the environment. With Compose they come from `.env` (local) or
`/srv/wannpassts/.env` (server, see `infra/server/env.example`). Secrets never go into these files.

| Variable | Default | What |
| --- | --- | --- |
| `BASE_URL` | `https://wann.localhost:8444` | The public address. Used in links and for the `Origin` check |
| `OPERATOR_NAME` | empty | Who runs this instance, named on the privacy page. Empty: no name shown |
| `SMTP_HOST` | empty | Set it to turn mail on. Empty means **link mode**: no mail at all |
| `SMTP_PORT`, `SMTP_USER`, `SMTP_STARTTLS` | `587`, empty, `true` | SMTP connection |
| `SMTP_PASSWORD_FILE` | empty | A file holding the SMTP password (`SMTP_PASSWORD` also works) |
| `MAIL_FROM` | `Wann passt's? <noreply@wann.localhost>` | Sender of sign-in emails |
| `HOLIDAY_SYNC` | `true` | Fetch holidays at start and daily at 04:00 Europe/Berlin |
| `DATA_DIR` | `data` (`/data` in the image) | Where the SQLite database lives |

On the server, Caddy also reads `DOMAIN`, `OLD_DOMAIN` (redirects a previous name) and `ACME_EMAIL`.

## Deploying your own instance

The repo includes everything to run it on a small Hetzner Cloud server at an [sslip.io](https://sslip.io) name
(no domain or DNS of your own needed), using `make` targets on your laptop:

```sh
make server-create        # firewall + server via the Hetzner API (token in .local/secrets/hcloud_token)
make server-init          # writes the server's .env with its DOMAIN
make deploy               # builds the image locally, ships it over SSH, starts it, checks health and headers
make backup-init STORAGE_BOX=…   # nightly restic backups to a Storage Box sub-account
```

Step-by-step runbooks:

- [docs/runbooks/server.md](docs/runbooks/server.md): the server from nothing, and moving to a real domain
- [docs/runbooks/deploy.md](docs/runbooks/deploy.md): deploy, roll back, logs
- [docs/runbooks/backup.md](docs/runbooks/backup.md): backups, the restore drill, recovery
- [docs/runbooks/invite.md](docs/runbooks/invite.md): getting people in, forgotten passwords

Any host that runs Docker Compose works too: `infra/compose.yaml` plus your own overlay modeled on
`infra/compose.prod.yaml` and `infra/caddy/Caddyfile.prod`.

## Security

- Server-side sessions in a `__Host-` cookie, an `Origin` check on every write, and rate limits on sign-in and
  joining.
- Passwords are hashed with scrypt, and the 100,000 most common passwords are refused. Tokens are random,
  and only their hashes are stored.
- Authorization goes through one dependency. A pytest matrix checks every endpoint against every role.
- A strict Content-Security-Policy, HSTS and `Referrer-Policy: no-referrer`. The container runs as non-root on a
  read-only filesystem.

Found a vulnerability? Please report it privately through GitHub's
[security advisories](../../security/advisories/new) rather than in a public issue.

## Repository layout

| Path | What |
| --- | --- |
| `backend/` | FastAPI app (`src/wannpassts/`), SQL migrations, CLI (`python -m wannpassts.cli`), tests |
| `frontend/` | React SPA (`src/`), Playwright tests (`e2e/`), PWA icons |
| `infra/` | Dockerfile, Compose files, Caddyfiles, cloud-init, deploy and backup scripts |
| `docs/spec.md` | What the app does: roles, screens, data model, API, security, operations |
| `docs/decisions.md` | Decisions of record, one line each |
| `docs/plan.md` | The implementation plan, phase by phase |

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified version for other people over a
network, you must offer them its source code.
