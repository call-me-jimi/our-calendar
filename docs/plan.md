# Our Calendar — Implementation plan

Version 1 · 2026-11-18 · Implements `spec.md` (section numbers below refer to it).

Eight phases. Each one is a mergeable unit that leaves `make check` green. Every step ends with a
**check** whose output you can see. The order follows dependencies: sign-in before groups, groups before
calendar, data before the views that summarise it, and deployment last, once the open items (domain, SMTP) are settled.

| Phase | Delivers | Phase check |
| --- | --- | --- |
| P0 | Repo skeleton, tooling, local stack | `make check` green; `https://ourcalendar.localhost:8444` shows the SPA shell, `/api/health` 200 |
| P1 | Identity: magic link, sessions, admin bootstrap, i18n base | e2e: admin signs in via Mailpit; replayed cookie after logout → 401 |
| P2 | Groups, roles, invite links, join flow | permission matrix passes; e2e: invite → new member joins |
| P3 | Calendar tab: marking, undo, notes, admin marking for others | e2e: drag range (desktop) + tap range (phone) persist across reload |
| P4 | Overview tab: timeline, group result, polling, Find dates | e2e: second user sees marks ≤ 60 s; Find dates returns expected dates |
| P5 | Holidays + group events + iCal feed | stripes for BE/BB 2027 match fixture; event appears in subscribed feed |
| P6 | Account, privacy page, PWA, polish | delete account removes all personal rows; Lighthouse PWA installable |
| P7 | Deploy, backups, hardening | full e2e on the real domain; restore drill succeeds; headers present |
| P8 | Redesign: new look, "Meine Tage" / "Gruppe" tabs, select-then-choose marking, "Passende Tage finden" | `make check` + `make e2e` green; axe clean; matches the mockup in both themes |

---

## P0 — Skeleton

**Goal:** an empty app that builds, tests, runs locally behind Caddy, and has CI.

1. **Repo layout.** `git init`, `README.md`, `.gitignore`, `.env.example`, `Makefile`.
   ```
   backend/   pyproject.toml (uv), src/ourcalendar/{main.py, config.py, db.py}, tests/
   frontend/  package.json, vite.config.ts, src/{main.tsx, App.tsx}, index.html
   infra/     compose.yaml, compose.dev.yaml (Mailpit), Caddyfile, Caddyfile.dev, Dockerfile
   docs/      spec.md, plan.md, decisions.md
   ```
   - Check: `tree -L 2` matches.
2. **Backend base.** FastAPI app with `GET /api/health`, settings from env (`DATA_DIR`, `BASE_URL`, `SMTP_*`),
   SQLite connection helper (WAL, `foreign_keys=ON`, `busy_timeout`), a migration runner applying `migrations/NNN_*.sql`
   in order and recording them in `schema_version`.
   - Check: pytest: an empty DB migrates to the latest version, and a second run is a no-op.
3. **Frontend base.** Vite + React + TS, React Router with placeholder routes (`/signin`, `/auth/verify`, `/join/:token`,
   `/g/:gid/calendar`, `/g/:gid/overview`, `/g/:gid/settings`, `/me`, `/admin`, `/privacy`), TanStack Query client,
   CSS tokens (colours, light/dark), self-hosted font (or the system font stack).
   - Check: `npm run build` emits `dist/`, and vitest runs one smoke test.
4. **Image and local stack.** A multi-stage Dockerfile (node build → python slim, non-root). FastAPI serves `dist/` with
   an SPA fallback to `index.html` for non-`/api` paths. The compose files cover `app` and `caddy` (+ `mailpit` in dev).
   `make up`, `make down`, `make logs`, `make trust` (export Caddy's local root cert).
   - Check: `https://ourcalendar.localhost:8444` shows the shell and `curl -k …/api/health` returns `{"ok":true}`.
5. **Quality gates.** `make check` = ruff, mypy --strict, pytest, ESLint, tsc --noEmit, vitest. GitHub Actions (or the CI of
   choice) runs `make check` on push.
   - Check: CI green on the first commit.

## P1 — Identity (spec §3.1, §3.13, §6.2)

**Goal:** people with accounts sign in by magic link, and sessions are server-side.

1. **Migration 001:** `users`, `sessions`, `login_tokens`, `rate_events`.
2. **Tokens and sessions module.** Random tokens (`secrets.token_urlsafe(32)`), SHA-256 hashes, 15-minute single-use login
   tokens, 90-day sliding sessions, and a dependency `current_user` that reads `__Host-session`.
   - Check: pytest covers expiry, single use, sliding renewal, and a replayed cookie after logout → 401.
3. **Mailer.** SMTP via `smtplib` in a thread pool. DE/EN plain-text + simple HTML template with the link
   `BASE_URL/auth/verify#t=…`. Locally it goes to Mailpit.
   - Check: requesting a link locally makes an email appear in Mailpit with the right language.
4. **Endpoints:** `POST /api/auth/request` (always 202), `POST /api/auth/verify`, `POST /api/auth/logout`, `logout-all`,
   `GET/PATCH /api/me`. Rate limits (5/address/h, 20/IP/h; client IP from Caddy's `X-Forwarded-For`, trusted only from Caddy).
   An **Origin check** middleware runs on all non-GET requests.
   - Check: pytest covers an unknown email getting the same 202 and timing within tolerance and no email sent, the 6th request in an hour being
     refused silently (still 202, no email), and a missing or foreign Origin → 403.
5. **Admin bootstrap.** `make create-admin EMAIL=… NAME=…` (CLI `python -m ourcalendar.cli create-admin`) creates or flags the
   instance admin.
   - Check: running it twice is idempotent.
6. **Frontend.** `/signin` (email form, "check your inbox" state), `/auth/verify` (reads the fragment, shows a "Sign in" button, POSTs,
   clears the fragment), `/me` (name, language, sign out, sign out everywhere). Route guard: unauthenticated users go to `/signin`.
   **i18n base:** a `t()` helper, `de.json`/`en.json`, browser default, "DE · EN" switch in the header, stored on the user.
   - Check (phase): Playwright signs in the admin through Mailpit, signs out, and replaying the old cookie with `curl` → 401.

### P1 results (2026-11-18)

Done on branch `p1-identity`. `make check`: 32 backend tests (token single use and expiry, hashed storage,
cookie flags, sliding renewal, logout and logout-all with replayed cookies, both rate limits, Origin check,
`/me` validation, CLI idempotence) and 5 frontend tests (i18n key parity, guard, verify without token).
`make e2e`: sign-in through Mailpit, a reused link refused, sign-out, and the old cookie answers 401;
an unknown address gets the same answer and no mail. Deviations: see `decisions.md` (P1 rows).

## P2 — Groups, roles, invites (spec §2, §3.2, §3.3, §3.12)

**Goal:** the admin creates a group and members join through an invite link, with every permission enforced in one place.

1. **Migration 002:** `groups`, `memberships`, `invites`; `login_tokens.invite_id`.
2. **Authorisation dependency.** `group_role(user, group_id) → 'admin' | 'member' | None`, where the instance admin counts as `'admin'`.
   Helpers `require_member`, `require_group_admin`, `require_instance_admin`.
3. **Endpoints:** groups CRUD (§5), members PATCH/DELETE with the **last-admin rule**, invites list/create/revoke,
   `GET /api/join/{token}`, `POST /api/join/{token}/request`, `POST /api/join/{token}`. On redeeming a `join` token: re-check the
   invite, upsert the user (keep an existing name), add the membership, increment `use_count`, create a session.
   - Check: pytest **permission matrix**, parametrised over each endpoint × {anonymous, non-member, member, group admin, instance
     admin, removed member}, plus the expected status codes. Also: an expired/revoked invite → 404 at both request and redeem time,
     and the last admin can't leave or demote themselves.
4. **Frontend.** Group switcher in the header and `/` redirect logic (0 / 1 / many groups). `/join/:token` (both states).
   **Settings** tab: rename, regions (checkboxes BE/BB, more later), members with promote/demote/remove, invite links with
   copy, expiry and use count, revoke. "Leave group" in the group menu. `/admin`: group list, create, delete.
   - Check (phase): Playwright: the admin creates "Band", copies the invite, and a second browser context joins as "Anna" via Mailpit, then sees
     "Band". The admin revokes the link, and a third context gets "no longer valid".

### P2 results (2026-11-18)

Done on branch `p2-groups`. `make check`: 124 backend tests, among them the **permission matrix** (12 endpoints
× anonymous, outsider, removed member, member, group admin, instance admin = 72 cases), the last-admin rule, invite
expiry/revocation at request and at redeem time, join for new and existing accounts, and use counting.
`make e2e`: the phase check passes (admin creates a group and a link, a new person joins via Mailpit and lands in
the group without a Settings tab, the admin sees one use and revokes, a third visitor gets "no longer valid"), plus
the last admin trying to leave.

Found on the way: P1's two "replayed cookie" tests set the cookie with `domain="testserver"`, which the test client
never sends, so they passed without testing anything. Fixed; both now first prove the copied cookie works.

## P3 — Calendar tab and marking (spec §3.4, §3.5)

**Goal:** the core interaction: fast, saved immediately, undoable.

1. **Migration 003:** `day_marks`.
2. **Endpoints:** `GET /api/groups/{g}/marks?from&to` (members' marks only; a removed member's marks are never returned),
   `PUT /api/marks` (batch ≤ 400; editable-window check in Europe/Berlin; returns the previous values; sets
   `availability_updated_at`; `set_by`). A group admin may write for `user_id` only with a `group_id` they administer and that
   user belongs to.
   - Check: pytest covers past days → 422, today + 12 months + 1 day → 422, an admin writing for a member of another group → 403,
     and the returned previous values reproducing the old state.
3. **Pure logic (frontend `lib/`, unit-tested):** `expandRange(a, b)` (order-independent, across months), `applyBrush(days,
   brush, current)` (single-day toggle-to-free), `undoPayload(previous)`, month-grid generation (Monday first, padding days).
   - Check: vitest covers a range across a month boundary, a reversed range, toggling, and the 29 Feb 2028 grid.
4. **Calendar UI.** Month grid component (1 month < 720 px, 3 months ≥ 720 px), navigation (past read-only, forward stops
   at the window end), brush picker, **pointer events** for press-drag-release with preview, tap-start/tap-end on touch,
   long-press-drag, and long-press-release/hover/right-click → day details. Optimistic update via TanStack Query with
   rollback on error. Toast with **Undo** and **Add note…**. Note popover (≤ 80). "Marking for: ▾" picker for group admins.
   Group result tint is a placeholder until P4.
   - Check (phase): Playwright, desktop viewport: drag 3 → 10 May, reload, 8 days busy. Phone viewport (touch): tap 12, tap 14,
     maybe ×3. Undo restores. A note shows in day details. A member viewport has no "Marking for" picker.

### P3 results (2026-11-18)

Done on branch `p3-calendar`, partly by parallel subagents (backend marks API; day/brush logic; and P4's pure
`groupResult`/`findDates` logic, built early since the calendar colours need it). `make check`: 166 backend tests
(marks API, editable window incl. month-end clamping, permission matrix extended to the two marks endpoints) and
64 frontend tests (dates and brush rules, group result, Find dates). `make e2e` (8 tests): desktop drag 8 days → reload
→ click-to-clear → Undo → maybe with note visible in day details; phone viewport tap start/tap end and a double tap for
one day, persisted across reload; a group admin marks a day for a member, who sees "set by".

Not covered by e2e: touch long-press-and-drag (Playwright can't hold a touch). Step 4 of P4 (Find dates UI) and the
Overview remain; P4 step 1 (pure logic) is done.

## P4 — Overview, group result, Find dates (spec §3.6, §3.7, §3.14)

**Goal:** answer "when can everyone?" at a glance and on demand.

1. **Pure logic (unit-tested):** `groupResult(day, marks, members, events)` → `event | busy(n) | maybe | free`;
   `findDates(params, marks, members, events)` per §3.7 (length, weekdays / weekends-only pairs, period, optional members,
   at most *k* missing, maybe toggle, event days excluded, ranking, top 20).
   - Check: vitest with a table of hand-made cases, including a weekend split by a busy Sunday, an optional member being
     busy, maybe-as-free on/off, and an event day in the window.
2. **Group result in the Calendar** background tint and the busy count. Colour + pattern tokens, light/dark, checked
   with a colour-blindness simulator (e.g. Chrome DevTools "Emulate vision deficiencies").
3. **Overview tab.** Timeline table (sticky name column, horizontal scroll on phones), summary row, note dots, hover/tap
   details, "updated *n* ago" per member, month navigation.
4. **Find dates panel.** Form → result list → click jumps to the month and opens "Plan event here" (P5 wires the
   dialog; until then it only jumps and highlights).
5. **Polling.** TanStack Query `refetchOnWindowFocus` + `refetchInterval: 60_000` only while `document.visibilityState === 'visible'`.
   - Check (phase): Playwright with two contexts: Anna marks a range, and the admin's Overview shows it within 60 s without reload.
     Find dates (weekends, next 3 months) lists the expected first three weekends.

### P4 results (2026-11-18)

Done on branch `p4-overview`. Step 1 (pure logic) and step 2 (group result in the Calendar) were already done in P3;
`useGroupMarks` already polled. New: the Overview tab (timeline, summary row, "updated *n* ago", day details on tap,
today's column scrolled into view on phones), the Find dates panel, and polling of the group query. `make check`: 166
backend tests, 72 frontend tests (+ member order and "updated *n* ago"). `make e2e` (10 tests), incl. the phase checks:
Anna's marks appear in Ivo's open Overview without reload (poll ≤ 60 s); Find dates (weekends, next 3 months) lists the
expected first three weekends, skips a weekend split by a busy Sunday, brings it back with "at most 1 missing", drops
a maybe weekend when maybe counts as not free, and a click outlines the result's days. Colour check: Chrome's deuteranopia
and protanopia emulation; busy/maybe/free stay apart by fill, hatch, dots and the busy count.

## P5 — Holidays, group events, iCal (spec §3.8, §3.9, §3.10)

**Goal:** context in the calendar and a way to fix a date once it's found.

1. **Migration 004:** `holidays`, `holiday_syncs`, `events`, `feed_tokens`.
2. **Holiday sync.** `httpx` client for `/PublicHolidays` and `/SchoolHolidays` (DE-BE, DE-BB; current + next 2 years;
   all languages), mapping to rows (`nationwide` → subdivision `DE`), upsert, `holiday_syncs` row. Runs at startup and daily at
   04:00 Europe/Berlin (an asyncio task; one uvicorn worker). CLI `sync-holidays` for manual runs.
   `GET /api/holidays`.
   - Check: pytest against **recorded fixtures** of the real 2027 responses (Reformationstag BB-only, Ostersonntag BB-only,
     Frauentag BE-only, single "Unterrichtsfreier Tag"). A simulated API failure keeps the old rows and logs `ok=0`.
3. **Holiday display.** Stripes (school BE, school BB, bank holiday marker) in the Calendar and the Overview header, with names in
   details, filtered by group regions.
4. **Events.** Endpoints (any member; ≤ 31 days; field limits). An event dialog used by "+ Event", by "Plan event here" from an
   Overview selection, and by Find dates results. Blue bars spanning days, wrapping across week rows. Events are excluded from green in the
   group result and in Find dates (already in the P4 logic).
   - Check: pytest covers a member creating, a non-member → 403, and a removed member's feed → 404.
5. **iCal feed.** `POST /api/groups/{g}/feed-token` (shows the URL once, replaces the old one) and `GET /feed/{token}.ics` with all-day events,
   exclusive DTEND, stable `UID` (`event-<id>@<domain>`), `X-WR-CALNAME`. Feed tokens are deleted on leave/remove.
   - Check (phase): the generated `.ics` validates (e.g. `icalendar` round-trip + an online validator once) and a
     subscription in a desktop calendar app shows the test gig. The BE/BB 2027 stripes match the fixture dates.

### P5 results (2026-11-18)

Done on branch `p5-holidays-events`, by three parallel subagents (holidays backend; events + feed backend; frontend)
after migration 004, the new dependencies (`httpx`, `icalendar`) and the API contract were fixed up front. `make check`:
283 backend tests (holiday mapping against recorded real 2027 OpenHolidays responses — Reformationstag and Ostersonntag
BB-only, Frauentag BE-only, Tag der Deutschen Einheit once as `DE`, the BE "Unterrichtsfreier Tag" 2027-05-07 —
idempotent re-sync, failure keeps old rows with `ok=0`, next 04:00 across both DST days; events CRUD and limits; feed
round-trip with exclusive DTEND and stable UID, regenerate/leave/remove → 404; permission matrix extended) and 85
frontend tests. `make e2e` (15 tests): event create → bars in both tabs → excluded from Find dates → edit → delete;
"Plan event here" from a Find dates result and from a header drag; the feed URL serves `text/calendar` with the event
and a regenerated link kills the old one; October 2027 with BE + BB shows the bank-holiday markers on 3 and 31 Oct
(the latter titled with Brandenburg) and both school stripes. The local stack syncs 113 holidays for 2026–2028 at start.

Not done: the online iCal validator and a real calendar-app subscription (needs a public URL; P7).

## P6 — Account, privacy, PWA, polish (spec §3.11, §3.14, §3.15)

**Goal:** everything a member needs besides the calendar itself.

1. **Delete account.** `DELETE /api/me` with typed-name confirmation in the UI. A single transaction removes the user (cascades),
   and `set_by`/`created_by` become NULL ("former member").
   - Check: pytest: afterwards no row references the user id, except NULLed `set_by`/`created_by`.
2. **Privacy page** `/privacy` in DE/EN (content per §3.15), linked in the footer and on `/signin`.
3. **PWA.** `manifest.webmanifest` (name, short name, `display: standalone`, theme colour), icons 192/512 + maskable,
   `apple-touch-icon`. No service worker.
   - Check: "Add to home screen" on Android Chrome and iOS Safari opens full-screen. The Chrome DevTools manifest pane has no errors.
4. **Polish pass.** Empty states, error toasts, keyboard support in the calendar (arrow keys + Space/Shift for ranges),
   focus styles, `aria-label`s on day cells ("Tue 3 Mar, you: busy, group: 2 busy"), and complete translation (a CI check that both JSON files
   have the same keys).
   - Check (phase): an axe scan in Playwright has no serious violations on Calendar and Overview, and the key-parity test passes.

### P6 results (2026-11-18)

Done on branch `p6-account-privacy-pwa`, by three parallel subagents (account deletion + privacy page; installable app
+ i18n check; polish + accessibility). `make check`: 307 backend tests (deleting an account leaves no row referencing
the user except NULLed `set_by`/`created_by`/`updated_by`; last group admin / last instance admin refused with 409;
`set_by_former` marks days set by a deleted person) and 112 frontend tests (keyboard logic, Calendar against a fake
API, DE/EN key and placeholder parity). `make e2e` (21 tests): a member deletes their account by typing their name, can't
sign in again, and the admin sees "former member"; `/privacy` is public in DE/EN and linked from the footer and sign-in;
manifest and icons are served with the right types and sizes; axe finds no serious/critical WCAG 2.1 AA violations on
Calendar and Overview (desktop + phone, light + dark, day details open); keyboard marking, ranges, Escape and Ctrl+Z.
Integration fix: the busy count is drawn by CSS so a day cell's visible text matches its label (axe
`label-content-name-mismatch`).

Not done: "Add to home screen" on a real Android and iPhone (needs the real domain; P7). The contact address on the
privacy page comes from `CONTACT_EMAIL` and must be set before inviting people.

## P7 — Deploy, backups, hardening (spec §6.3, §6.4, §7)

**Changed 2026-11-18 (owner):** no domain and no SMTP provider. The app runs at an sslip.io name of the server's
IP and signs people in with links instead of email (spec §3.1–3.2, decisions P7). Step 3 (mail) is
dropped; the cloud-init file is `infra/server/cloud-init.yaml`. Runbooks: `docs/runbooks/{server,deploy,backup}.md`.

1. **Server.** Create the Hetzner server (smallest current type) with `infra/cloud-init.yaml` (Docker, deploy user, SSH key only,
   unattended-upgrades, ufw/Hetzner firewall 22/80/443). DNS A/AAAA records for the domain.
   - Check: `ssh deploy@<host> docker version` works and password login is refused.
2. **Deploy.** `make deploy` (build, `docker save | ssh docker load`, copy compose + Caddyfile + secrets file, `up -d`,
   health check). Caddy obtains the certificate, and access log rotation keeps 7 days.
   - Check: `curl -I https://<domain>` shows HSTS, CSP, `nosniff`, `Referrer-Policy: no-referrer`, and `/api/health` returns 200.
3. **Mail.** Configure the SMTP provider and sender, plus SPF/DKIM (and DMARC) for the sender domain.
   The app's network is `internal: true` (no route out); give it an egress path for SMTP and
   OpenHolidays (e.g. a second, non-internal network for `app` only).
   - Check: a magic link reaches a Gmail and a GMX inbox, not spam.
4. **Backups.** systemd timer: `sqlite3 .backup` → `restic backup` to the Storage Box, with `forget --keep-daily 14 --keep-weekly 8
   --keep-monthly 12 --prune`. Keys in the password manager.
   - Check: `restic snapshots` lists last night's snapshot.
5. **Restore drill.** `make restore-drill` restores the latest snapshot locally and runs the app on it.
   - Check: the admin signs in locally on the restored DB and sees the groups.
6. **Production e2e.** Run the P2–P5 Playwright journey against the real domain with throwaway accounts, then delete them.
   - Check (phase = v1 done): passes. Then create the real group and share the invite link.

---

### P7 status (2026-11-18)

Built on branch `p7-deploy` by two parallel subagents (sign-in without email; Hetzner server, deploy, backups). `make
check` (now incl. `infra-check`): 347 backend, 117 frontend and 11 server-script tests; `make e2e`: 23 tests incl. sign-in
links made by an admin and for one's own other device. Validated locally: compose prod config, `caddy validate` + a live
header check, `cloud-init schema`, shellcheck, a backup/restore dry run with restic against a local repo, and the restore
drill. Not yet done (needs the owner's Hetzner token and Storage Box sub-account): steps 1, 2, 4–6 on the real server.

## P8 — Redesign (spec §3.3, §3.5–3.7, §6.1)

Added 2026-11-20. The owner found the v1 UI hard to read and hard for newcomers. The target is the clickable mockup
`docs/design/redesign-mockup.html` (sample data, no backend; open it in a browser). It is the reference for look,
wording and behaviour; where this plan and the mockup differ, the plan wins.

**Owner's decisions (2026-11-20):**

- Look: "warm & friendly". Warm neutral colours, rounded cells, Bricolage Grotesque for headings, Nunito for text, both
  self-hosted. Dark mode follows the system.
- Tabs: **Meine Tage** (mark your own days), **Gruppe** (find a date), **Einstellungen** (admins). Übersicht is no
  longer a tab; it becomes the "Tabelle" layout of Gruppe.
- Marking is select-then-choose. Tap days to select them (a mouse can also drag a range), then a sheet asks what applies.
  It offers only the states that change something: unmarked → Belegt / Vielleicht; belegt → Vielleicht / Wieder frei;
  vielleicht → Belegt / Wieder frei; mixed → all three. It has an optional note field. The brush picker is removed.
- Meine Tage shows only your own days, plus holidays and group events. Nothing about other members.
- Gruppe has a "Kalender | Tabelle" switch. In Kalender, each day has one small box per member, always in the same
  order (you first, then by name): empty = can, amber = maybe, red = can't. Tapping a day opens a day summary listing
  the members in that same order; dragging over days gives the summary for that range.
- "Passende Tage finden" (in Gruppe): period (1/3/6/12 months or a custom from–to), "Tage am Stück" (1–14), weekdays
  (tick chips + Alle / Wochenende / Mo–Fr), "Vielleicht zählt als frei". **Everyone** must be free; there is no member
  filter and no "at most *k* missing". The result lists **all** matching runs in date order, grouped by month. Days
  outside the filters fade in both layouts. The filter choice is per person, remembered in the browser.
- "+ Termin" exists only in Gruppe.
- Guidance: a hint line above the calendar that follows what you do; a "So funktioniert's" card on the first visit; a
  "?" button that brings it back with the keyboard help; legends in plain language.
- The whole app gets the new look (sign-in, join, account, admin, settings, privacy), with no change in behaviour there.

**Phase check:** `make check` and `make e2e` are green with the rewritten tests below; axe has no serious violations;
side-by-side screenshots of the app and the mockup (desktop + phone, light + dark) match in layout, type and colour.
Work on branch `p8-redesign`.

1. **Spec and decisions.** Rewrite spec §3.3 (tabs), §3.5 (Meine Tage: selection, sheet, keyboard; no brush, no
   long press, no day details), §3.6 (Gruppe colours and member boxes), §3.7 (Gruppe: layouts, day summary, Passende
   Tage finden; drop optional members, "at most *k* missing", ranking and the top 20), and §6.1 (fonts). Add the
   decisions above to `docs/decisions.md`.
   - Check: re-read both. Every bullet above appears in the spec, and nothing in the spec still mentions the brush, the
     Overview tab or Find dates.
2. **Tokens, fonts, shell.** Replace the tokens in `styles.css` with the mockup's (light + dark, including `--holiday`
   and `--school`). Add `@fontsource-variable/bricolage-grotesque` and `@fontsource/nunito` (400–800, latin), exact versions
   pinned. These are served from `'self'`, so the CSP stays as it is. Shared pieces: buttons, segmented control, tick
   chips, switch, stepper, bottom sheet, popover, toast. Restyle the app header (logo mark, DE/EN pill, avatar → Konto)
   and the group header (name, member faces and count, pill tabs, ⋯ menu).
   - Check: `npm run build` emits the font files into `dist/`; the browser console shows no CSP errors on
     `https://ourcalendar.localhost:8444`; header screenshots match the mockup in both themes.
3. **Routes.** Add `/g/:gid/days` (Meine Tage) and `/g/:gid/group` (Gruppe; `?layout=table` for the table,
   `?day=YYYY-MM-DD` to open a day). The index route and the old `/calendar` and `/overview` URLs redirect there (old links
   and installed apps keep working). Update the links in Home, Join, Verify, Admin and the group switcher.
   - Check: vitest for the redirects; e2e opens `/g/:gid/calendar` and lands on Meine Tage.
4. **Selection logic (pure, `lib/selection.ts`).** Toggle a day; add a range (order-independent, editable days only);
   `choicesFor(selected, own)` → the states to offer; `changesFor(selected, state, note)` → `DayChange[]` (a note is kept
   when none is typed; "Wieder frei" removes the note). This replaces `applyBrush`; remove it and its tests. Keyboard in
   `calendarKeys.ts`: arrows move, Space toggles the day, Shift+arrows select a range, B / V / Entf apply Belegt /
   Vielleicht / Wieder frei to the selection, Esc clears it, Ctrl+Z undoes.
   - Check: vitest table: unmarked/belegt/vielleicht/mixed → the offered choices; a reversed range across a month boundary;
     past days are never selected; a kept note vs a new note; each key → its action.
5. **Meine Tage.** Month grid (3 months ≥ 720 px, 1 below) showing only your own state, the note icon, holidays (✦ and
   an orange day number), the Schulferien ribbon and event bars. Selection by tap (touch never drags, so the page still
   scrolls) and by mouse drag; the selection ring. The sheet shows the date (or "*n* Tage ausgewählt" with date chips),
   "Bisher: …", "set by …" when an admin set it, holiday and event, the question, the choices and the note field (Enter
   on a marked day saves just the note). Toast with Undo, as now. "Markieren für: ▾" for group admins stays above the grid.
   Remove `DayDetails`; its parts move into the sheet and the Gruppe summary.
   - Check: rewrite `e2e/calendar.spec.ts`. Desktop: drag 3 → 10 May, choose Belegt, reload, 8 days busy; select a busy day,
     only Vielleicht / Wieder frei are offered. Phone: tap 12, 13 and 14, choose Vielleicht with a note; the note icon shows.
     Undo restores. An admin marks for a member, who sees "set by".
6. **Finding dates (pure).** Replace `findDates` with `matchingRuns({ from, to, length, weekdays, maybeCountsAsFree },
   index, members, events)`. It returns every run of `length` days inside the period where each day is a chosen weekday,
   has no group event, and every member is free (or maybe, if that counts as free). The result is in date order with no limit.
   Remove the optional / max-missing / ranking code and its tests. Remember `weekdays`, `length` and the maybe switch
   in `localStorage` per group, wrapped in try/catch. The period always starts as "12 Monate"; a custom from–to would go stale.
   - Check: vitest table: Fr+Sa runs of 2 skip a week where Saturday is busy; length 3 never crosses an unchosen weekday;
     maybe on/off; an event day breaks a run; the period end cuts a run; a custom period is clamped to the editable window.
7. **Gruppe, Kalender layout.** Cells coloured by the group result (all free / free with maybes / someone can't / event)
   with the member boxes, faded outside the filters. "Passende Tage finden" panel above the grid, with the result list
   (click → jump to the month, select the run, open its summary). Day summary: a popover next to the day on desktop, a
   bottom sheet on phones. It shows a status pill, the members in fixed order with state, note and "set by", holidays and
   events (an event opens the event dialog), **Termin planen** (event dialog prefilled with the day or range) and **Meinen
   Eintrag ändern** (→ Meine Tage with `?day=`). "+ Termin" in the toolbar. Remove `FindDates.tsx`.
   - Check: rewrite the Find dates e2e tests: Fr + Sa, 2 days, next 3 months → the expected runs; switching maybe changes
     the list; a result click opens the summary and "Termin planen" opens the dialog with those dates.
8. **Gruppe, Tabelle layout** (the former Overview, restyled). One month from the shared month navigation; a sticky name
   column with "aktualisiert vor …"; a "Gruppe" row on top whose cells open the same summary; a header drag selects a range
   for the summary; filtered-out columns fade. Polling is unchanged.
   - Check: the existing polling e2e (Anna's marks show within 60 s) passes against the table; "plan event from a header
     drag" passes.
9. **Guidance and words.** Step hint line (Meine Tage: nothing selected / *n* selected; Gruppe: per layout). First-visit
   card (three steps, "Verstanden", remembered in `localStorage`), and the "?" button that shows it again with the
   keyboard help. Legends per tab and layout, in plain words. All new strings in `de.json` and `en.json`; remove keys
   nothing uses any more.
   - Check: the key parity test passes; e2e: the card shows on the first visit only, and "?" brings it back.
10. **Other pages.** Sign-in, verify, join, account, admin, group settings, privacy and 404 use the new tokens and
    components. No behaviour change.
    - Check: screenshots of each page (desktop + phone, light + dark); their e2e tests pass unchanged.
11. **Accessibility and the phase check.** Day cells: `aria-pressed` for the selection, labels as now ("Di 3. Mär, du:
    belegt" / "…, Gruppe: 2 können nicht"). The sheet and popover are dialogs that take focus and return it. Colour check
    with Chrome's deuteranopia and protanopia emulation: the boxes, hatch and outline keep the states apart without hue.
    - Check: extend `e2e/a11y.spec.ts` to both tabs, both Gruppe layouts, sheet and popover open, desktop + phone,
      light + dark; rewrite the keyboard test for the new keys; then the phase check above. Deploy only after the owner
      has looked at it locally.

## Decisions to record in `docs/decisions.md` at P0

One line each, dated 2026-11-18, all from the brainstorm (Q1–Q21): private instance; whole days with busy/maybe/free;
roles; magic link (no Zitadel); two tabs + colours; brush and drag; notes per day; OpenHolidays BE/BB separate; availability per
user; events group-local; multi-use invite links; no notifications; iCal export only; DE + EN; FastAPI + SQLite + React;
own Hetzner server; keep data forever; security defaults; Find dates; polling + PWA; name "Our Calendar".
Plus the details decided while writing the spec (not discussed separately):

- magic-link token in the URL fragment;
- day details via hover/right-click/long-press-release;
- the instance admin auto-joins groups they create;
- plain SQL migrations;
- one uvicorn worker with an in-process holiday scheduler;
- events up to 31 days.
