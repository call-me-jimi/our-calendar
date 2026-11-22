# Laptop workflow. The server uses the same compose base with compose.prod.yaml (P7).

GIT_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
export GIT_SHA

COMPOSE := docker compose --env-file .env -p wannpassts \
	-f infra/compose.yaml -f infra/compose.dev.yaml

.PHONY: help up down nuke ps logs trust check lint test backend-check frontend-check e2e icons create-user create-admin signin-link sync-holidays dev-api dev-web install \
	infra-check server-create server-init deploy server-ssh server-logs server-cli server-signin-link \
	backup-init backup-now backup-status backup-secrets restore-drill

help:  ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

.env:
	cp .env.example .env

install:  ## install backend and frontend dependencies
	cd backend && uv sync
	cd frontend && npm ci --no-audit --no-fund

up: .env  ## build and start the stack at https://wann.localhost:8444 (Mailpit: http://127.0.0.1:8026)
	$(COMPOSE) up -d --build --wait

down:  ## stop the stack, keep data
	$(COMPOSE) down

nuke:  ## stop the stack and delete its data volumes
	$(COMPOSE) down -v

ps:
	$(COMPOSE) ps

logs:  ## make logs SERVICE=caddy
	$(COMPOSE) logs -f --tail 100 $(or $(SERVICE),app)

trust:  ## copy Caddy's local root certificate out, to import into the browser
	@mkdir -p .local
	$(COMPOSE) cp caddy:/data/caddy/pki/authorities/local/root.crt .local/caddy-root.crt
	@echo "Import .local/caddy-root.crt into your browser's certificate authorities."

create-admin:  ## make create-admin EMAIL=you@example.com NAME=You
	$(COMPOSE) exec -T app python -m wannpassts.cli create-user --email "$(EMAIL)" --name "$(NAME)" --admin

create-user:  ## make create-user EMAIL=… NAME=… (normally people join via an invite link)
	$(COMPOSE) exec -T app python -m wannpassts.cli create-user --email "$(EMAIL)" --name "$(NAME)"

signin-link:  ## make signin-link EMAIL=… (prints a sign-in link, 24 h, single use; e.g. for yourself without mail)
	$(COMPOSE) exec -T app python -m wannpassts.cli signin-link --email "$(EMAIL)"

sync-holidays:  ## fetch holidays from OpenHolidays now (the app also does this daily at 04:00)
	$(COMPOSE) exec -T app python -m wannpassts.cli sync-holidays

dev-api:  ## run the API with reload on :8000 (pair with dev-web)
	cd backend && DATA_DIR=../.local/dev-data BASE_URL=http://localhost:5173 \
		uv run uvicorn wannpassts.main:create_app --factory --reload --port 8000

dev-web:  ## run Vite on :5173, proxying /api to dev-api
	cd frontend && npm run dev

check: backend-check frontend-check infra-check  ## everything CI runs

backend-check:
	cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest

frontend-check:
	cd frontend && npm run lint && npm run typecheck && npm test

INFRA_SH := infra/scripts/server.sh infra/scripts/restore_drill.sh infra/backup/backup.sh infra/backup/restic.sh
infra-check:  # hetzner.py (with the backend's ruff, mypy, pytest) and the shell scripts
	cd backend && uv run ruff check --config pyproject.toml ../infra/scripts \
		&& uv run ruff format --config pyproject.toml --check ../infra/scripts \
		&& uv run mypy --strict ../infra/scripts/hetzner.py ../infra/scripts/tests \
		&& uv run pytest ../infra/scripts/tests
	@for f in $(INFRA_SH); do bash -n $$f || exit 1; done
	@if command -v shellcheck >/dev/null; then shellcheck -x $(INFRA_SH); \
		else echo "shellcheck isn't installed: bash -n only"; fi

e2e:  ## browser tests against the running stack (`make up` first)
	cd frontend && npm run e2e

ICON_SRC := frontend/icon-src
ICON_OUT := frontend/public
icons:  ## render the PWA icons in frontend/public from frontend/icon-src/*.svg (needs inkscape + magick)
	inkscape $(ICON_SRC)/icon.svg -w 192 -h 192 -o $(ICON_OUT)/icon-192.png
	inkscape $(ICON_SRC)/icon.svg -w 512 -h 512 -o $(ICON_OUT)/icon-512.png
	inkscape $(ICON_SRC)/icon.svg -w 32 -h 32 -o $(ICON_OUT)/favicon.png
	inkscape $(ICON_SRC)/icon-maskable.svg -w 512 -h 512 -o $(ICON_OUT)/icon-maskable-512.png
	inkscape $(ICON_SRC)/icon-maskable.svg -w 180 -h 180 -o $(ICON_OUT)/apple-touch-icon.png
	magick $(ICON_OUT)/apple-touch-icon.png -alpha off -strip $(ICON_OUT)/apple-touch-icon.png
	cp $(ICON_SRC)/icon.svg $(ICON_OUT)/favicon.svg

# The server (P7, docs/runbooks/server.md, deploy.md, backup.md), over SSH to DEPLOY_HOST
# from .env. Commands on the server run in the deployed release.
SERVER := DEPLOY_HOST=$(DEPLOY_HOST) infra/scripts/server.sh

server-create:  ## create the Hetzner firewall and server (idempotent; LOGIN_KEY=~/.ssh/x.pub, SERVER_TYPE=…)
	LOGIN_KEY=$(LOGIN_KEY) SERVER_TYPE=$(SERVER_TYPE) LOCATION=$(LOCATION) \
		uv run --no-project python infra/scripts/hetzner.py

server-init:  ## write the server's /srv/wannpassts/.env from infra/server/env.example (once)
	$(SERVER) init

deploy:  ## build HEAD (or SHA=abc1234), ship it, start it, check https://DOMAIN
	SHA=$(SHA) $(SERVER) deploy

server-ssh:  ## a shell on the server
	$(SERVER) ssh

server-logs:  ## make server-logs [SERVICE=caddy]
	$(SERVER) logs $(or $(SERVICE),app)

server-cli:  ## make server-cli ARGS="create-user --email … --name … --admin"
	$(SERVER) cli $(ARGS)

server-signin-link:  ## make server-signin-link EMAIL=… (a sign-in link on the server, 24 h, single use)
	$(SERVER) cli signin-link --email "$(EMAIL)"

backup-init:  ## make backup-init STORAGE_BOX=<sub>@<sub>.your-storagebox.de: keys, repository, nightly timer
	STORAGE_BOX=$(STORAGE_BOX) $(SERVER) backup-init

backup-now:  ## run the server's backup now
	$(SERVER) backup-now

backup-status:  ## the backup timer's last and next run, and the snapshots
	$(SERVER) backup-status

backup-secrets:  ## copy the backup's password, key and address to .local/secrets/ (for restore-drill)
	$(SERVER) backup-secrets

restore-drill:  ## restore the latest backup here and run the app on it (EMAIL=… prints a sign-in link)
	EMAIL=$(EMAIL) SNAPSHOT=$(SNAPSHOT) infra/scripts/restore_drill.sh
