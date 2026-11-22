"""Request dependencies: the database connection and the signed-in user."""

import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, Response

from ourcalendar.db import connect
from ourcalendar.security import hash_token, iso, new_token, now

COOKIE = "__Host-session"
SESSION_LIFETIME = timedelta(days=90)
# Renew a session's expiry at most once a day, not on every request.
RENEW_AFTER = timedelta(days=1)


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    conn = connect(request.app.state.settings.db_path)
    try:
        yield conn
    finally:
        conn.close()


Db = Annotated[sqlite3.Connection, Depends(get_db)]


@dataclass(frozen=True)
class User:
    id: int
    email: str
    display_name: str
    locale: Literal["de", "en"]
    is_instance_admin: bool
    has_password: bool
    session_hash: str


def create_session(conn: sqlite3.Connection, user_id: int, user_agent: str | None) -> str:
    token = new_token()
    t = now()
    conn.execute(
        "INSERT INTO sessions (id_hash, user_id, created_at, last_used_at, expires_at, user_agent)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (hash_token(token), user_id, iso(t), iso(t), iso(t + SESSION_LIFETIME), user_agent),
    )
    return token


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE,
        token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/", secure=True, httponly=True, samesite="lax")


def current_user(request: Request, response: Response, conn: Db) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "unauthenticated")
    h = hash_token(token)
    t = now()
    row = conn.execute(
        "SELECT u.id, u.email, u.display_name, u.locale, u.is_instance_admin,"
        " u.password_hash IS NOT NULL AS has_password, s.last_used_at"
        " FROM sessions s JOIN users u ON u.id = s.user_id"
        " WHERE s.id_hash = ? AND s.expires_at > ?",
        (h, iso(t)),
    ).fetchone()
    if row is None:
        raise HTTPException(401, "unauthenticated")
    if row["last_used_at"] < iso(t - RENEW_AFTER):
        conn.execute(
            "UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id_hash = ?",
            (iso(t), iso(t + SESSION_LIFETIME), h),
        )
        set_session_cookie(response, token)
    return User(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        locale=row["locale"],
        is_instance_admin=bool(row["is_instance_admin"]),
        has_password=bool(row["has_password"]),
        session_hash=h,
    )


CurrentUser = Annotated[User, Depends(current_user)]
