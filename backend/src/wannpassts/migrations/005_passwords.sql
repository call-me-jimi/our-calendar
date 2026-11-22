-- Sign-in by email and password (spec §3.1). NULL: no password set yet (accounts from before,
-- or created by the CLI); such a user signs in by link and sets one on the account page.

ALTER TABLE users ADD COLUMN password_hash TEXT;
