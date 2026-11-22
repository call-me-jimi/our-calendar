# Wann passt's? — Specification

Version 1 · 2026-11-18, redesign (P8) 2026-11-20 · Source of every decision:
`../../brainstorms/2026-11-18-group-scheduling-app.md` (Q-numbers below refer to that file). The P8 redesign
follows the owner's decisions of 2026-11-20 (`decisions.md`) and the mockup `design/redesign-mockup.html`, which
also has the exact German wording.

## 1. Purpose and scope

A small private web app where a group of friends (e.g. a band) marks the days they are busy
and sees at a glance which days suit everyone.

- **Private instance** for the owner's own groups. No public sign-up; people join via a
  group's invite link. (Q1)
- Availability is per **whole day**: `busy`, `maybe` or `free` (the default). (Q2)
- German and English UI. (Q14)

**Not in v1:** passkeys, TOTP, notifications/reminders, calendar import, RSVP, recurring or
tentative events, a cross-group personal overview, member colours, printing/export of the
Gruppe table, data import, offline mode, push. (Q4, Q10, Q12, Q13, Q20, Q21)

## 2. Roles and permissions (Q3)

| Action | Member | Group admin | Instance admin |
| --- | --- | --- | --- |
| See all members' days, notes and events of the group | ✓ | ✓ | ✓ (any group) |
| Mark own days, write own notes | ✓ | ✓ | ✓ |
| Mark another member's days (shown "set by <name>", Q21) | — | ✓ (own group's members) | ✓ |
| Create / edit / delete group events | ✓ | ✓ | ✓ |
| Rename group, change holiday regions | — | ✓ | ✓ |
| Create / revoke invite links | — | ✓ | ✓ |
| Remove members, promote/demote admins | — | ✓ | ✓ |
| Leave the group | ✓ | ✓ (unless last admin) | ✓ (if a member) |
| Create / delete groups | — | — | ✓ |

- The group's creator becomes its first group admin. A group always keeps at least one
  group admin: the last one can't leave or demote themselves; the instance admin can always step in.
- The instance admin acts as group admin in every group **without being listed as a member**
  (unless they also joined it).
- Group creation is instance-admin only.

## 3. Functional specification

### 3.1 Sign-in (Q4, Q18)

- **Email and password** is the normal way in (2026-11-21). The password is set when joining (§3.2) or on `/me`
  (§3.11); accounts from before, and accounts the CLI creates, have none until then. `POST /api/auth/login` answers
  one 401 `invalid_credentials` for an unknown address, an account without a password and a wrong password, and
  does the same hashing work in each case. Stored as **scrypt** (n=2¹⁵, r=8, p=1, 16-byte salt). At least **8**,
  at most 200 characters, and not one of the **100,000 most common** (the NCSC's list from Have I Been Pwned,
  compared ignoring case): 422 `common_password`. No rules for capitals, digits or symbols. Checked when a
  password is set, never at sign-in. Every password field has a Show/Hide button (no "repeat password" field).
- Rate limit: **10 password attempts per address per hour**, **30 per IP per hour** (right ones count too), then
  429 `rate_limited`. Joining with an existing account's password (§3.2) counts against the same limits.
- **Forgotten password:** sign in by a link (below), then set a new one on `/me`. Setting it needs only the
  session (no current password, or this reset wouldn't work) and signs out every other session.
- **Email magic link** (with mail, from "email me a link instead" on `/signin`). `/signin` asks for an email. If an account exists, an email with a link
  is sent; the response is identical either way (no account enumeration).
- The link is `https://<domain>/auth/verify#t=<token>`. The token is in the URL **fragment**, so
  it never appears in server logs. The page shows a **"Sign in" button**; only the click POSTs
  the token. This stops mail scanners from using the link up.
- Token: 32 random bytes, stored as SHA-256 hash, **valid 15 minutes, single use** (links handed out by an admin: 24 hours, below).
- On success: a new session and the cookie `__Host-session` (HttpOnly, Secure, SameSite=Lax,
  Path=/). **90 days, sliding** (renewed when used and more than a day old).
- **Sign out** deletes the session row. To end the other sessions (e.g. a lost phone), set a new password (§3.11).
- Rate limits: **5 emails per address per hour**, **20 per IP per hour**, plus a general API
  limit (e.g. 300 requests/min per session).
- The tables allow adding passkeys later (a separate `credentials` table), with no change to the existing ones.
- **Mail is optional** ("link mode"). Mail is enabled exactly when `SMTP_HOST` is set; `GET /api/info` tells the pages
  `{mail_enabled}`. Without mail, `/signin` shows only the password form and explains where links come from (below), and
  `POST /api/auth/request` sends nothing (still 202). Production currently runs without mail.
- **Handed-out sign-in links** (both modes). Each is a single-use `login` token redeemed by the same verify page:
  - A **group admin** creates one for a member of their group in the group settings, to send by messenger:
    **valid 24 hours**. Not for themselves, never for an instance admin, and — unless the caller is the instance
    admin — not for anyone who is an admin of any group (whoever opens the link *is* that person, so this would
    hand over their admin rights). Logged with the ids of creator and target.
  - **CLI** `signin-link --email …` (`make signin-link EMAIL=…`): 24 hours, any user; how the instance admin
    signs in without mail.
  - Rate limit: 20 links per creating user per hour.

### 3.2 Invite links and joining (Q11)

- A group admin creates a link: `https://<domain>/join/<token>`. It is **multi-use**,
  **expires after 7 days** and can be **revoked**. The group settings list active links with
  their expiry, use count and the link itself to **copy again** while it is valid (2026-11-21: the token is kept
  besides its hash, and dropped on revoke; links from before can't be shown again).
- **Not signed in:** the join page shows "Join *<group>*" and asks for **display name**, **email** and
  **password**, with or without mail (2026-11-21; before, mail mode sent a `join` magic link first). The form joins
  **directly** (201) and signs the person in, going straight to the group (Meine Tage). The invite link is the
  only gate for a new account (validity, 20 attempts per IP per hour). The email isn't checked: it is the
  account's identifier and lets mail be added later.
- **An address that already has an account** joins only with **that account's password** (else anyone with the
  invite link could take the account over); it keeps its name and language. A wrong password: 401
  `invalid_credentials`. An account **without a password** yet: 409 `account_exists`, and the page says to sign in
  first (by a link from the admin) and open the invite link again. Nothing else happens in either case.
- **Signed in:** one "Join" button.
- An invalid, expired or revoked link shows one neutral message, "This link is no longer valid".
- **Leave group:** the member's days stay in their account but are no longer visible to that group.
  A **removed** member is treated the same way.

### 3.3 Groups and tabs (Q5; P8)

- A group has a **name** (≤ 60 chars) and **holiday regions** (default `DE-BE`, `DE-BB`; Q8).
- Header: a group switcher if the user is in more than one group. With exactly one group, `/` opens it directly.
- A user with no groups sees "You're not in a group yet; ask for an invite link."
- Group header: the group's name, the members' initials and count, the tabs, and a ⋯ menu. Every member can leave
  via that menu.
- Per group, tabs **Meine Tage** (mark your own days, §3.5) and **Gruppe** (see when everyone can, plan events, §3.7),
  plus **Einstellungen** for group admins. There is no separate overview tab: the member timeline is the **Tabelle**
  layout of Gruppe.
- URLs: `/g/:gid/days` (Meine Tage; `?day=YYYY-MM-DD` shows that day selected) and `/g/:gid/group` (Gruppe;
  `?layout=table` for Tabelle, `?day=YYYY-MM-DD` opens that day's summary). `/g/:gid` and the old `/g/:gid/calendar`
  lead to Meine Tage, `/g/:gid/overview` to Gruppe's Tabelle, so old links and installed apps keep working.
- **Guidance** (both tabs):
  - A **hint line** above the calendar says what to do and follows what you do. Meine Tage: how to select days while
    nothing is selected; "*n* Tage ausgewählt …" (highlighted) while days are selected. Gruppe: what green and the
    boxes mean (Kalender), or what the rows mean (Tabelle). On both pages × on its right closes it, leaving an "i" in
    the toolbar above the calendar that opens it again; remembered per page in the browser. A step of what you're doing
    ("*n* Tage ausgewählt …", "now pick the last day") has no ×. A closed hint stays closed during a step (appearing
    would push the calendar down mid-drag); screen readers still get the text (2026-11-21).
  - A **"So funktioniert's"** card on the first visit to Meine Tage: three steps (tap the days you can't; say what
    applies, optionally with a note; find matching days under Gruppe) and a **Verstanden** button. Dismissing it is
    remembered in the browser (`localStorage`).
  - A **"?"** button in the toolbar shows the card again together with the keyboard help (§3.5); pressing it again
    hides the help.
  - A **legend** below the calendar for each tab and layout, in plain words ("Ich kann nicht", "Alle können", "Ein
    Kästchen pro Person (Du, Anna, …): leer = kann, gelb = vielleicht, rot = kann nicht", …).

### 3.4 Availability data (Q2, Q9)

- One state per **user and calendar day**: `busy` or `maybe`. `free` = no row.
- Availability belongs to the **user** and is shown in every group they are in. A group never learns
  which other groups exist.
- Days are plain calendar dates (`YYYY-MM-DD`), no times, no time zones. "Today" is the date in
  **Europe/Berlin**.
- **Editable window:** today … today + 12 months. Earlier days can be viewed but not edited.
  **Data is kept forever** (Q17).
- Every row stores **set_by** (who wrote it) and **updated_at**. Each user also has
  `availability_updated_at`, shown as **"updated 3 weeks ago"** (Q12).
- Concurrency: the last write per day wins (Q20).

### 3.5 Meine Tage — marking (Q6, Q7; P8)

Meine Tage shows **only your own days**, plus holidays (§3.8) and group events (§3.9). Nothing about other members.

- Month grid with 7 columns, **Monday first**. **Desktop: 3 months** side by side, **phone:
  1 month** (breakpoint ~ 720 px). Arrows to move by one month, plus "Heute". From the editable
  window's last month the forward arrow is disabled. Backwards is unlimited (past is read-only).
- **Day cells:** your state (busy = solid red, maybe = amber hatch with an amber outline, free = plain), a note icon
  when the day has a note, holidays and the Schulferien ribbon (§3.6), and a bar on top for a group event. Today's
  number sits on a dark round badge. Past days are faded and can't be selected. The cell's tooltip names the date,
  holiday, school holidays, event, and your state and note. There is no day-details panel: no hover card, no
  right-click, no long press.
- **Select, then choose.** You first select days, then say what applies to them.
  - A **tap/click** adds a day to the selection or takes it out again. Taps add up, also across the months shown.
  - A **mouse drag** adds every day from start to end in **date order** (across week rows and months) to the
    selection. Only editable days are selected. On touch a swipe scrolls the page; **holding a day still for 350 ms,
    then dragging**, selects the same way (a short vibration where supported), and the page doesn't scroll meanwhile.
    During any drag the hint keeps its text and, on phones, the day panel waits for the finger to lift, so the weeks
    don't move under the pointer (2026-11-21).
  - Selected days get a ring; the hint line counts them (§3.3). Esc or ✕ clears the selection.
- **Sheet:** while days are selected, a sheet at the bottom of the screen (on phones: inside the calendar, right
  under the week of the first day tapped, so it covers no day and stays put while more days are added; 2026-11-21) shows
  - for one day: the full date, "Bisher: frei / belegt / vielleicht", "set by <name>" when someone else set it, and
    the day's holiday, school holidays and event; for several days: "*n* Tage ausgewählt" with date chips (the
    first 8, then "+*k*");
  - a question: "Kannst du an diesem Tag / diesen Tagen nicht?" (all unmarked), "Diese Markierung(en) ändern?" (all
    in the same state), "Was gilt für diese Tage?" (mixed);
  - only the choices that change something:

    | Selection | Choices |
    | --- | --- |
    | all unmarked | Belegt · Vielleicht |
    | all busy | Vielleicht · Wieder frei |
    | all maybe | Belegt · Wieder frei |
    | mixed | Belegt · Vielleicht · Wieder frei |

  - an optional **note** field (≤ 80 chars), prefilled with the note of a single selected day.
- A choice **saves immediately** and clears the selection. Belegt / Vielleicht store the typed note on **each**
  selected day; when no note is typed, a day keeps its note. Wieder frei removes the mark and its note. **Enter** in
  the note field, when the selection has marked days, saves just the note on those days.
- A toast says what happened ("3 Tage als belegt markiert") with **Rückgängig**. Undo restores the previous state and
  note of exactly those days. Only the last action can be undone.
- **Keyboard:** the grid is one tab stop. Arrows move, Space toggles the focused day, Shift+arrows select a range,
  **B** / **V** / **Entf** apply Belegt / Vielleicht / Wieder frei to the selection, Esc clears it, Ctrl/Cmd+Z undoes.
- A **group admin** gets a member picker "Markieren für: ich ▾" above the grid. Days set for someone else show
  "set by <name>" in the sheet and in the Gruppe summary (§3.7).
- Day cells are buttons with `aria-pressed` for the selection and a label such as "Di 3. Mär, du: belegt". The sheet
  is a dialog that takes focus and gives it back.

### 3.6 Group result and colours (Q5; P8)

The **group result** per day, over the group's current members, colours the days in Gruppe (both layouts). It
follows the "Vielleicht zählt als frei" switch (§3.7), which is off by default:

| Result | Condition | Look |
| --- | --- | --- |
| Event | a group event covers the day | plain cell with the event bar; never green |
| Someone can't | ≥ 1 busy, or ≥ 1 maybe while maybe doesn't count as free | plain grey cell, muted day number; in Tabelle the number of members who can't |
| All can, some maybe | 0 busy, ≥ 1 maybe, maybe counts as free | light green, hatched |
| All can | everyone free | green |

- **Member boxes** (Gruppe, Kalender): each day shows one small box per member, always in the same order: you first,
  then the others by name. Empty (outlined) = can, amber = maybe, red = can't. The legend names the order.
- **Holiday (Feiertag):** a ✦ in the top corner of the day and an orange day number.
- **School holidays (Schulferien):** one ribbon under the days that bridges the gaps between them, rounded where a
  stretch (or a week row) starts or ends.
- **Group event:** a bar along the top of the day.
- Colours need to stay distinct for colour-blind users: solid red, amber hatch with outline, empty outlined boxes,
  the count in Tabelle and the ✦ carry the meaning too, not just hue. Dark mode follows the system setting.

### 3.7 Gruppe tab (Q5, Q19; P8)

- **Toolbar:** **+ Termin** (§3.9; only in Gruppe) and "?" (§3.3). The **Kalender | Tabelle** switch, the month
  arrows and "Heute" (shared by both layouts) sit right above the calendar, below "Passende Tage finden" (2026-11-21).
- **Kalender** layout: month grids as in §3.5 (3 months on desktop, 1 on phones), coloured by the group result with
  the member boxes (§3.6). The cell's tooltip names who can't and who might not.
- **Day summary.** Tapping a day opens its summary; tapping it again, ✕, or a tap elsewhere closes it. A mouse drag over
  days gives the summary for that range. Changing the month or the layout closes it. On desktop it is a popover next to
  the day, on phones full width right under the tapped day, scrolled into view (2026-11-21); either is a dialog that takes focus and gives it back. It shows:
  - the date (or "from – to") and a status pill: "Alle können" / "Alle können, *n* nur vielleicht" / "*n* können
    nicht" (for a range prefixed "*n* Tage ·"), following the maybe switch;
  - the members in the same fixed order (you first, then by name), each with their state ("kann" / "vielleicht" /
    "kann nicht"; for a range "kann an allen Tagen" / "an *x* von *n* Tagen vielleicht" / "an *x* von *n* Tagen
    nicht"), and for a single day their note and "set by <name>";
  - holidays, school holidays and events; an event opens the event dialog (§3.9);
  - **Termin planen**: the event dialog, prefilled with the day or range;
  - **Meinen Eintrag ändern** (a single editable day): Meine Tage with that day selected (`?day=`, §3.3).
- **Passende Tage finden** panel above the calendar (both layouts), computed in the browser on the loaded data. The
  filters are questions:
  - **Zeitraum:** 1 / 3 / 6 / 12 Monate from today, or **Eigener** from–to. Always inside the editable window
    (a custom date outside it is clamped).
  - **Tage am Stück:** 1–14 (a stepper).
  - **Wochentage:** tick chips Mo … So, plus presets **Alle / Wochenende / Mo–Fr**. At least one stays ticked.
  - **"Vielleicht" zählt als frei:** a switch.
  - Defaults: 12 Monate, 1 Tag, all weekdays, switch off. "Filter zurücksetzen" appears when a filter differs.
- **Matching.** A run is *n* consecutive days ("Tage am Stück") inside the period where every day is a ticked
  weekday, has no group event, and **everyone** is free (or maybe, when maybe counts as free). There is no member
  filter and no "at most *k* missing".
- **Result:** the number of matches, then **all** matching runs in date order, grouped by month, as chips. No
  ranking and no limit. Runs may overlap (one per start day). With no match, a line suggests a longer period, more
  weekdays or letting maybe count as free. Clicking a run jumps to its month, selects it and opens its summary.
- Days on unticked weekdays or outside the period **fade** in both layouts.
- Weekdays, Tage am Stück and the maybe switch are remembered **per person and group** in the browser
  (`localStorage`; if storage fails, the defaults apply). The period always starts at 12 Monate.
- **Tabelle** layout (the former overview timeline): one month at a time, the first month of the navigation.
  - **Rows = members** in the same fixed order, **columns = days**. The name column stays fixed (also when the days
    scroll horizontally on phones) and shows "aktualisiert vor …" (§3.4).
  - Day headers show weekday and number, the ✦ and orange number for holidays, the Schulferien ribbon and event bars.
  - Member cells: busy / maybe / free plus a note icon; the tooltip gives state and note.
  - A **Gruppe** row on top shows the group result (§3.6; the number of members who can't). Tapping one of its cells
    opens the same day summary; dragging over the day headers selects a range and opens its summary.
  - Past columns are faded, and so are columns outside the filters.
  - Data is fetched again on focus and every 60 s (§3.14), so "aktualisiert vor …" and other members' marks stay
    current.

### 3.8 Holidays (Q8)

- Source: **OpenHolidays API** (`https://openholidaysapi.org`), no key. Endpoints
  `GET /PublicHolidays` and `GET /SchoolHolidays` with `countryIsoCode=DE`,
  `subdivisionCode=DE-BE|DE-BB`, `validFrom`, `validTo`. Names come in DE and EN.
  - Verified 2026-11-18. Public holidays carry `nationwide` and `subdivisions` (e.g. BB: Ostersonntag,
    Pfingstsonntag, Reformationstag; BE: Frauentag). School holidays include single "unterrichtsfreie
    Tage", which are shown like school holidays.
- **Sync:** at app start and daily at 04:00 Europe/Berlin, for the current year and the next two. Rows are upserted and
  never deleted, so past years stay. If the API fails, the last data is kept, a warning is logged and the instance admin page shows the last
  successful sync.
- **Display:** bank holidays get the ✦ and an orange day number, school holidays the Schulferien ribbon (§3.6). The
  names (with the region for regional ones, e.g. "Schulferien Berlin") appear in the tooltip, the Meine Tage sheet and
  the Gruppe day summary.
- Only the group's regions are shown. Holidays are **information only**.

### 3.9 Group events (Q10)

- Fields: **title** (≤ 80), **start/end date** (whole days, ≤ 31 days long), optional **time &
  place** (free text ≤ 120), optional **note** (≤ 500).
- Any member creates, edits and deletes them in Gruppe: via **+ Termin**, or **Termin planen** in a day summary
  (a day, a range, a Tabelle header drag or a Passende Tage result; §3.7). An event in a summary opens it for editing.
- Shown as a bar along the top of the day in both tabs; the title is in the tooltip, the sheet and the summary.
  Events exist **only in their group**: they never change anyone's availability or show up in other groups.
- Each event stores created_by/updated_by. If the creator deletes their account the event stays, with
  creator shown as "former member".

### 3.10 iCal feed (Q13)

- In a group's tab: "Termine abonnieren" ("Subscribe to events"). This generates a personal feed URL
  `https://<domain>/feed/<token>.ics` (token **per user per group**, 32 random bytes, hash stored).
  The URL is shown once with a copy button. "Regenerate" invalidates the old one.
- The feed has the group's events as all-day `VEVENT`s (DTEND exclusive), with time & place in `LOCATION`/`DESCRIPTION`.
  It contains all events from one year ago onwards. No availability data is included.
- The feed stops working when the user leaves or is removed from the group, or deletes their account.

### 3.11 Account (Q17)

- The **avatar** in the header opens a menu: name and email, a link to `/me`, and **sign out**.
- `/me`: display name (≤ 40), language, **password** (set or change, §3.1), **delete account**. "Save" and
  "Set/Change password" are active only once something was changed. (2026-11-21: "sign out everywhere" and "sign in
  on another device" are gone; a new password ends the other sessions, and another device signs in with the password.)
- While a signed-in user has no password, every page but `/me` shows a reminder linking to it.
- Deleting asks for confirmation by typing the display name. It deletes the user, their days and notes, sessions, memberships,
  feed tokens and pending login tokens immediately. Events they created stay. "set by" on days of others they edited shows
  "former member".
- Backups keep deleted data until the backup retention has passed (see 6.4). The privacy note says so.

### 3.12 Instance admin page

`/admin` (instance admin only): list of all groups with member counts. It has "create group" (name; the
instance admin becomes its first member and group admin, Q3) and "delete group" (typed
confirmation). It lists **all accounts** (name, email, groups, "instance admin", "no password") and can **delete**
any account but its own and other instance admins' — typed confirmation of the name, same effect as "delete account"
(§3.11), and the same last-admin rule (409 `last_admin`). Removing someone from a group only ends the membership; this
deletes the account. It also shows the last holiday sync and its result.

### 3.13 Language (Q14)

- DE ("du") and EN, switched with "DE · EN" in the header. The default is the browser language and the choice is stored on the
  user (and in `localStorage` before sign-in).
- Dates are formatted with `Intl.DateTimeFormat` (`3. Mai` / `3 May`). Monday is the first day of the week in both languages.
- Magic-link emails use the recipient's stored language, or the language of the page that requested it.

### 3.14 Live updates and phone (Q20)

- No WebSockets. Group data is fetched again when the tab gets focus and every 60 s while the tab is visible.
- Responsive. A web app manifest + icons (name "Wann passt's?", `display: standalone`) lets people add it to the home screen. No
  service worker for offline use.

### 3.15 Privacy note (Q17)

A public page `/privacy` (DE/EN) that says:
- what is stored (email, display name, days, notes, events, sessions, rate-limit counters) and why;
- who sees it (the members of your groups and the instance admin);
- that data is kept until you delete it or your account;
- that backups exist and how long they are kept;
- that there is no tracking and no third-party requests, and that holidays are fetched server-side;
- who to contact: the person who runs this instance (named by `OPERATOR_NAME`, if set), or the person who invited you (plain text, no address).

Whether an Impressum/privacy policy is legally needed is open (§9).

## 4. Data model (SQLite, WAL)

All ids are integers unless noted. Timestamps are UTC ISO-8601 text. Days are `YYYY-MM-DD` text. `PRAGMA foreign_keys=ON`.

```
users(id PK, email UNIQUE NOT NULL  -- lower-cased
      , display_name NOT NULL, locale CHECK IN ('de','en')
      , is_instance_admin BOOL DEFAULT 0, availability_updated_at
      , password_hash NULL  -- scrypt$n$r$p$salt$hash; NULL: no password yet (§3.1)
      , created_at)

sessions(id_hash PK  -- sha256 of cookie value
      , user_id → users ON DELETE CASCADE, created_at, last_used_at, expires_at, user_agent)

login_tokens(id PK, token_hash UNIQUE, email, purpose CHECK IN ('login','join')
      , invite_id → invites NULL, display_name NULL, locale
      , expires_at, used_at NULL, created_at)

groups(id PK, name, regions TEXT  -- comma list, e.g. 'DE-BE,DE-BB'
      , created_at)

memberships(group_id → groups CASCADE, user_id → users CASCADE
      , role CHECK IN ('member','admin'), joined_at, PRIMARY KEY(group_id, user_id))

invites(id PK, group_id → groups CASCADE, token_hash UNIQUE, token NULL, created_by → users SET NULL
      , created_at, expires_at, revoked_at NULL, use_count DEFAULT 0)

day_marks(user_id → users CASCADE, day TEXT, state CHECK IN ('busy','maybe')
      , note TEXT NULL CHECK(length(note) <= 80)
      , set_by → users SET NULL, updated_at, PRIMARY KEY(user_id, day))

events(id PK, group_id → groups CASCADE, title, start_day, end_day CHECK(end_day >= start_day)
      , time_place NULL, note NULL, created_by → users SET NULL, updated_by → users SET NULL
      , created_at, updated_at)
      INDEX(group_id, start_day)

feed_tokens(token_hash PK, group_id → groups CASCADE, user_id → users CASCADE, created_at
      , UNIQUE(group_id, user_id))

holidays(id PK, kind CHECK IN ('public','school'), subdivision TEXT  -- 'DE' for nationwide
      , start_day, end_day, name_de, name_en, source_id TEXT, UNIQUE(kind, subdivision, start_day, name_de))

holiday_syncs(id PK, started_at, finished_at, ok BOOL, message)

rate_events(key TEXT, at TEXT)  INDEX(key, at)   -- pruned hourly
```

- The feed token is removed when a membership ends (application logic in the leave/remove path).
- Migrations: Alembic or plain numbered SQL files run at startup. **Plain SQL files** are preferred: fewer moving parts.

## 5. HTTP API

JSON under `/api`. Every route except `auth/*`, `join/*` (GET/request), `health`, `info` and `/feed/*` needs a session.
State-changing requests need a same-origin `Origin` header (else 403). Errors use `{ "error": "<code>" }`.

| Method & path | Who | Purpose |
| --- | --- | --- |
| `POST /api/auth/request` `{email, locale}` | anyone | send a login link if the account exists; always 202 (without mail: sends nothing) |
| `POST /api/auth/login` `{email, password}` | anyone | → session cookie + profile; 401 `invalid_credentials`; 429 `rate_limited` |
| `POST /api/auth/verify` `{token}` | anyone | redeem a login token → session cookie |
| `POST /api/auth/logout` | user | end this session |
| `GET /api/me` · `PATCH /api/me` `{display_name, locale}` · `DELETE /api/me` | user | profile (with `has_password`), delete account |
| `GET /api/admin/users` | instance admin | every account: `{id, email, display_name, is_instance_admin, has_password, created_at, groups: [name]}` |
| `DELETE /api/admin/users/{u}` | instance admin | 204; delete the account as in §3.11; 403 `target_is_self` / `target_is_instance_admin`; 409 `last_admin`; 404 |
| `PUT /api/me/password` `{password}` | user | 204; set or change the password, ends the other sessions; 422 if < 8 or > 200 characters, 422 `common_password` |
| `GET /api/join/{token}` | anyone | `{group_name}` or 404 |
| `POST /api/join/{token}/request` `{email, display_name, password, locale}` | anyone | join and sign in, 201 `{joined, group_id}` + cookie; existing address: 401 `invalid_credentials` (wrong password), 409 `account_exists` (no password yet); new address: 422 `common_password`; 429 `rate_limited` |
| `POST /api/join/{token}` | user | join directly when signed in |
| `GET /api/groups` | user | my groups (all for instance admin) |
| `POST /api/groups` `{name}` · `DELETE /api/groups/{g}` | instance admin | create / delete group |
| `GET /api/groups/{g}` | member | name, regions, members `{id, name, role, availability_updated_at, is_instance_admin}`, my role |
| `PATCH /api/groups/{g}` `{name?, regions?}` | group admin | settings |
| `PATCH /api/groups/{g}/members/{u}` `{role}` | group admin | promote/demote |
| `DELETE /api/groups/{g}/members/{u}` | group admin, or self | remove / leave |
| `POST /api/groups/{g}/members/{u}/signin-link` | group admin | 201 `{url, expires_at}`: sign-in link for member `u`, 24 h (§3.1); 404 if `u` isn't a member; 403 `target_is_self` / `target_is_instance_admin` / `target_is_admin` (an admin of any group, unless the caller is instance admin); 429 `rate_limited` |
| `GET/POST /api/groups/{g}/invites` · `DELETE …/invites/{i}` | group admin | list / create / revoke |
| `GET /api/groups/{g}/marks?from&to` | member | all members' marks in range |
| `PUT /api/marks` `{user_id, group_id?, days:[{day, state:'busy'\|'maybe'\|'free', note?}]}` | self, or group admin of `group_id` that contains `user_id` | batch write (≤ 400 days); returns previous values for undo |
| `GET /api/groups/{g}/events?from&to` · `POST` · `PATCH/DELETE …/events/{e}` | member | events |
| `GET /api/holidays?from&to&regions=DE-BE,DE-BB` | user | holidays overlapping the range |
| `POST /api/groups/{g}/feed-token` | member | new feed URL (shown once) |
| `GET /feed/{token}.ics` | token holder | iCal feed |
| `GET /api/admin/status` | instance admin | holiday sync status |
| `GET /api/health` | anyone | liveness |
| `GET /api/info` | anyone | `{mail_enabled, operator_name}`: whether sign-in and joining use mail (§3.1); who runs the instance (§3.15) |

- Range writes are expanded **in the browser** (it knows the range). The server only validates each day:
  inside the editable window, no duplicates, ≤ 400 per call.
- `PUT /api/marks` sets `users.availability_updated_at` of the target user.

## 6. Architecture and operations

### 6.1 Components (Q15)

```
Browser (React SPA) ──HTTPS──▶ Caddy (TLS, headers, static cache) ──▶ app: FastAPI + uvicorn (1 worker)
                                                                      ├─ serves /api, /feed, and the built SPA
                                                                      ├─ SQLite file on a Docker volume
                                                                      ├─ in-process daily holiday sync
                                                                      └─ SMTP → mail provider
```

- **Backend:** Python 3.13, FastAPI, uvicorn (one worker, so the in-process scheduler runs once), stdlib `sqlite3`
  via a thin repository layer (no ORM), `httpx` for OpenHolidays, `smtplib` via thread pool, `icalendar`.
  Tooling: uv, ruff, mypy (strict), pytest.
- **Frontend:** React 19 + TypeScript + Vite, React Router, TanStack Query (focus refetch + 60 s interval),
  date-fns, plain CSS with custom properties. No UI library. Own small `t()` with `de.json`/`en.json`.
  Tooling: ESLint, tsc, vitest, Playwright for end-to-end.
- **Look** ("warm & friendly", P8): warm neutral colours, rounded cells and cards, light and dark tokens as CSS custom
  properties; dark mode follows the system (`prefers-color-scheme`). Headings in **Bricolage Grotesque**, text in
  **Nunito**, self-hosted via `@fontsource-variable/bricolage-grotesque` and `@fontsource/nunito` (400–800, latin;
  exact versions pinned). They are served from `'self'`, so the CSP (§6.2) is unchanged. Every page uses this look
  (sign-in, join, account, admin, settings, privacy), with no change in behaviour there.
- **One Docker image**, multi-stage (node builds the SPA, python runtime serves it), non-root user, read-only root FS
  apart from the data volume.

### 6.2 Security (Q18)

- Server-side sessions, `__Host-` cookie, Origin check, rate limits, hashed tokens, scrypt password hashes (§3.1).
- **Authorisation in one place:** every group route resolves `(user, group) → role | None` through one dependency.
  A **pytest permission matrix** covers each endpoint × {anonymous, non-member, member, group admin, instance
  admin, removed member}.
- Caddy headers: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self';
  connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, HSTS, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` (keeps tokens in URLs from leaking), `Permissions-Policy` minimal.
- All user text is rendered as text (React escaping). No HTML in notes or event fields.
- Caddy access logs are kept 7 days. Request bodies are never logged.

### 6.3 Hosting and deploy (Q16)

- Its own small Hetzner Cloud server (the smallest current shared x86 or ARM type, about €4–5/month), Ubuntu LTS,
  provisioned by `cloud-init` (Docker, a non-root deploy user, SSH key only, unattended-upgrades). Hetzner firewall: 22 (from
  own IP, if practical), 80, 443.
- `docker compose` with `caddy` and `app`. Let's Encrypt via Caddy.
- `make deploy`: build the image locally, `docker save | ssh … docker load`, copy compose/Caddyfile, `docker compose up -d`,
  then check `/api/health`.
- Secrets (SMTP password) live in a file on the server, mounted as a Docker secret, never in the image.
- Local: `make up` runs the same compose plus **Mailpit**, at `https://wann.localhost:8444` with Caddy's local CA.

### 6.4 Backup

- A nightly systemd timer on the host runs `sqlite3 /data/app.db ".backup /backup/app.db"`, then `restic backup` to a **Hetzner
  Storage Box**. Retention: keep 14 daily, 8 weekly, 12 monthly. A healthchecks.io ping is optional.
- `make restore-drill`: restore the latest snapshot into a local container and open it. Run once before
  inviting people, then whenever the schema changes.

## 7. Testing and acceptance

- **Backend:** unit tests for the token/session lifecycle, rate limits, the editable window, the holiday parser (fixture of real API
  responses), the iCal output, and the permission matrix.
- **Frontend (vitest):** selection (toggle, ranges in either order across months, past days never selected), the
  choices offered per selection (unmarked / busy / maybe / mixed), the changes written (note kept vs new note, "Wieder
  frei" removes it), undo payload, the keyboard keys, the group result per day, and the matching runs (weekdays and
  length, maybe switch, an event day breaks a run, the period end cuts a run, a custom period clamped to the window).
- **End-to-end (Playwright, local stack):** an admin creates a group and an invite → a new person joins with name,
  email and password, signs out and back in with the password → in Meine Tage drags a busy range on desktop and taps days on a phone viewport, then chooses a state in
  the sheet → the second person sees it in Gruppe's Tabelle within 60 s → Passende Tage finden lists the expected runs
  → sign out, and the old cookie gets 401.
- **Done for v1** when the end-to-end test passes on the server under the real domain, a restore drill has succeeded, and
  `curl -I` shows the security headers.

## 8. Glossary

**Editable window** — today … today + 12 months. **Group result** — the per-day summary over members (§3.6).
**Instance admin** — the owner of the deployment. **Run** — *n* consecutive matching days found by Passende Tage
finden (§3.7). **Selection** — the days picked in Meine Tage before choosing a state (§3.5).

## 9. Open items

| Item | Owner | Needed by |
| --- | --- | --- |
| Domain / subdomain | owner | P7 (deploy) |
| SMTP provider and sender address for magic links — decided for now: none, link mode (§3.1); can be added later by setting `SMTP_*` | owner | later (local dev uses Mailpit) |
| Whether a reachable private app needs an Impressum / privacy policy beyond the privacy note | owner (optional own check) | before inviting people |
