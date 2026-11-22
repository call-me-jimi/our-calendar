"""Command line: `python -m ourcalendar.cli create-user --email … --name … [--admin]`,
`… signin-link --email …` and `… sync-holidays`."""

import argparse
import sys

from ourcalendar import holidays
from ourcalendar.config import load_settings
from ourcalendar.db import open_db, transaction
from ourcalendar.security import HANDED_LINK_LIFETIME, iso, normalize_email, now
from ourcalendar.signin_links import issue_login_link


def create_user(email: str, name: str, admin: bool, locale: str) -> str:
    """Create the user, or grant admin to an existing one. Never changes name or locale."""
    email = normalize_email(email)
    conn = open_db(load_settings().db_path)
    try:
        with transaction(conn):
            conn.execute(
                "INSERT INTO users (email, display_name, locale, is_instance_admin, created_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT (email) DO UPDATE"
                " SET is_instance_admin = max(is_instance_admin, excluded.is_instance_admin)",
                (email, name.strip(), locale, int(admin), iso(now())),
            )
            row = conn.execute(
                "SELECT id, is_instance_admin FROM users WHERE email = ?", (email,)
            ).fetchone()
    finally:
        conn.close()
    return f"user {row['id']} {email} admin={bool(row['is_instance_admin'])}"


def signin_link(email: str) -> str | None:
    """A 24-hour single-use sign-in link for an existing user, for the instance admin to hand
    over (spec §3.1): how the first sign-in works without mail. None if there's no such user."""
    email = normalize_email(email)
    settings = load_settings()
    conn = open_db(settings.db_path)
    try:
        with transaction(conn):
            user = conn.execute("SELECT locale FROM users WHERE email = ?", (email,)).fetchone()
            if user is None:
                return None
            link = issue_login_link(
                conn, settings.base_url, email, user["locale"], HANDED_LINK_LIFETIME
            )
    finally:
        conn.close()
    return link.url


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ourcalendar")
    sub = parser.add_subparsers(dest="command", required=True)
    cu = sub.add_parser("create-user", help="create a user (idempotent)")
    cu.add_argument("--email", required=True)
    cu.add_argument("--name", required=True)
    cu.add_argument("--admin", action="store_true", help="make them the instance admin")
    cu.add_argument("--locale", choices=["de", "en"], default="de")
    sl = sub.add_parser("signin-link", help="print a sign-in link (24 h, single use)")
    sl.add_argument("--email", required=True)
    sub.add_parser("sync-holidays", help="fetch holidays now (the app also does this daily)")
    args = parser.parse_args(argv)

    if args.command == "create-user":
        print(create_user(args.email, args.name, args.admin, args.locale))
    elif args.command == "signin-link":
        url = signin_link(args.email)
        if url is None:
            print("no user with that email", file=sys.stderr)
            return 1
        print(url)
    elif args.command == "sync-holidays":
        path = load_settings().db_path
        open_db(path).close()
        ok, message = holidays.sync(path)
        print(message)
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
