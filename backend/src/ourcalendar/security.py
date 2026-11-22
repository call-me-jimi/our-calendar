"""Tokens, time, and the database-backed rate limiter."""

import base64
import hashlib
import hmac
import re
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from functools import cache
from importlib.resources import files

from fastapi import Request

# Magic links (spec §3.1, §3.2).
LINK_LIFETIME = timedelta(minutes=15)
# A sign-in link an admin creates for someone else (or the CLI prints) travels by messenger and
# may be read hours later, so it lasts longer than a mailed one; still single use (spec §3.1).
HANDED_LINK_LIFETIME = timedelta(hours=24)
HOUR = timedelta(hours=1)
LIMIT_PER_EMAIL = 5
# Sign-in links one user may create per hour for others.
LIMIT_LINKS_PER_CALLER = 20
# Password sign-in attempts (wrong ones and right ones) per address and per IP per hour.
LIMIT_LOGIN_PER_EMAIL = 10
LIMIT_LOGIN_PER_IP = 30
PASSWORD_MIN = 8
PASSWORD_MAX = 200
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not _EMAIL.match(email):
        raise ValueError("invalid email")
    return email


def client_ip(request: Request) -> str:
    # uvicorn's --proxy-headers puts Caddy's X-Forwarded-For here.
    return request.client.host if request.client else "unknown"


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# scrypt with 32 MiB per hash (OWASP's minimum is n=2**17 at r=8, p=1 or n=2**15 at r=8, p=3;
# this is the single-thread variant of the latter cost, fine for one small instance).
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**15, 8, 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(
        password.encode(), salt=salt, n=n, r=r, p=p, maxmem=_SCRYPT_MAXMEM, dklen=32
    )


def hash_password(password: str) -> str:
    """`scrypt$n$r$p$salt$hash`, salt and hash in URL-safe base64."""
    salt = secrets.token_bytes(16)
    digest = _scrypt(password, salt, _SCRYPT_N, _SCRYPT_R, _SCRYPT_P)
    b64 = base64.urlsafe_b64encode
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64(salt).decode()}${b64(digest).decode()}"


@cache
def _common_passwords() -> frozenset[str]:
    # The NCSC's 100,000 most common passwords from Have I Been Pwned (via SecLists, MIT),
    # lowercased, 8 to 200 characters only (shorter ones are refused anyway).
    text = files("ourcalendar").joinpath("common_passwords.txt").read_text("utf-8")
    return frozenset(text.splitlines())


def is_common_password(password: str) -> bool:
    """Too easy to guess (spec §3.1); case doesn't help, `Passwort1` counts like `passwort1`."""
    return password.lower() in _common_passwords()


@cache
def _dummy_hash() -> str:
    return hash_password(secrets.token_urlsafe(16))


def verify_password(password: str, stored: str | None) -> bool:
    """Constant work whether or not there is a stored hash, so timing doesn't tell which
    addresses have a password."""
    _, n, r, p, salt, digest = (stored or _dummy_hash()).split("$")
    b64d = base64.urlsafe_b64decode
    ok = hmac.compare_digest(_scrypt(password, b64d(salt), int(n), int(r), int(p)), b64d(digest))
    return ok and stored is not None


def now() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime) -> str:
    """The one timestamp format in the database; compares correctly as text."""
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def rate_hit(conn: sqlite3.Connection, key: str, limit: int, window: timedelta) -> bool:
    """Record one hit for `key`; True if it is within `limit` hits per `window`."""
    t = now()
    count = conn.execute(
        "SELECT count(*) FROM rate_events WHERE key = ? AND at > ?", (key, iso(t - window))
    ).fetchone()[0]
    conn.execute("INSERT INTO rate_events (key, at) VALUES (?, ?)", (key, iso(t)))
    return bool(count < limit)


def prune(conn: sqlite3.Connection) -> None:
    """Drop rate events and login tokens nobody can use any more."""
    cutoff = iso(now() - timedelta(days=1))
    conn.execute("DELETE FROM rate_events WHERE at < ?", (cutoff,))
    conn.execute("DELETE FROM login_tokens WHERE expires_at < ?", (cutoff,))
