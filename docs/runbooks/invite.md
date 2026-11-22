# Runbook: inviting people

How people get into the app. There is no public sign-up: a person joins a group through
that group's **invite link**, choosing a password there; afterwards they sign in with
email and password. Production sends no mail, so links travel by messenger. German UI
labels are in brackets.

Before the first invite: an admin account exists and backups are set up
([server.md](server.md), steps 3–4).

## 1. Create the group (instance admin, once per group)

1. Sign in with your email and password (the first time: `make server-signin-link
   EMAIL=you@example.com`, open the link, set a password under **Account**).
2. **Admin** (header) → **Create group** [Gruppe anlegen] → name it. You become its first
   member and group admin.

## 2. Create an invite link (group admin)

1. Open the group → **Settings** tab [Einstellungen] → **Invite links** [Einladungslinks]
   → **Create new link** [Neuen Link erstellen].
2. **Copy** [Kopieren] it. Each active link stays listed with its own copy button until it
   expires or you revoke it.
3. Send it to the group chat. The link:
   - works for **several people**,
   - is valid for **7 days**,
   - shows up in the list with its expiry and use count, and can be **revoked**
     [Widerrufen] there at any time.

## 3. What the invited person does

1. Opens `https://<domain>/join/<token>`, enters **name**, **email** and a **password**
   (at least 8 characters), clicks **Join** [Beitreten].
2. They're signed in at once and land on **Meine Tage**.
3. Later: **Sign in** with that email and password.

Already have an account (e.g. from another group)? They enter its email and password on
the same form; name and language stay as they are. The email is only the account's
identifier; nothing is sent to it.

## When something goes wrong

| They see | Why | Do |
| --- | --- | --- |
| "This link is no longer valid" | expired, revoked, or mistyped | create a new link (step 2) |
| "…and that's not its password" | the address has an account with another password | they use the right one, or reset it (below) |
| "…but it has no password yet" | an account from before passwords, or made by the CLI | sign them in with a link (below), then they open the invite link again and click **Join**, and set a password under **Account** |
| "Too many attempts" | 10 password tries for the address, 30 for the IP, or 20 joins per IP, in an hour | wait an hour |

## Forgotten password, or no password yet

Sessions last 90 days and renew when used. Without mail there is no "reset password"
email; instead the person gets a **sign-in link**, opens it, and sets a new password
under **Account** → **Password** [Passwort] (this signs out their other devices). Until
they have a password, every page reminds them. Who can create the link:

- **Group admin**: **Settings** → **Members** [Mitglieder] → **Sign-in link** [Anmeldelink]
  next to the person. Valid 24 h, single use, shown once; send it only to them. Not
  possible for yourself or for anyone who is an admin of a group (only the instance admin
  can do that).
- **Instance admin**, for anyone: `make server-signin-link EMAIL=<their email>` (24 h).

## Removing someone

- From a group: **Settings** → **Members** → **Remove** [Entfernen]. The account stays and
  can still sign in; it can rejoin while the invite link is valid, so revoke the link and
  create a new one if that matters.
- From the app: **Admin** → **All accounts** [Alle Konten] → **Delete** [Löschen] next to
  the person, type their name. Deletes the account with its days, notes and memberships
  (instance admin only; not possible for the only admin of a group with other members —
  make someone else admin there first).

## Making someone a group admin

**Settings** → **Members** → **Make admin** [Zum Admin machen] next to the person. They
can then create invite links and sign-in links themselves.
