"""Joining a group through its invite link (spec §3.2)."""

import sqlite3
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from ourcalendar.auth import check_password
from ourcalendar.db import transaction
from ourcalendar.deps import CurrentUser, Db, create_session, set_session_cookie
from ourcalendar.security import (
    HOUR,
    PASSWORD_MAX,
    PASSWORD_MIN,
    client_ip,
    hash_password,
    hash_token,
    is_common_password,
    iso,
    normalize_email,
    now,
    prune,
    rate_hit,
)

router = APIRouter(prefix="/api/join")


class JoinInfo(BaseModel):
    group_name: str


class JoinRequest(BaseModel):
    email: str = Field(max_length=254)
    display_name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)
    locale: Literal["de", "en"] = "de"

    _email = field_validator("email")(normalize_email)

    @field_validator("display_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("empty name")
        return v


class Joined(BaseModel):
    group_id: int


def _by_token(conn: sqlite3.Connection, token: str) -> sqlite3.Row:
    """The invite if neither revoked nor expired, with its group's name; else 404."""
    invite: sqlite3.Row | None = conn.execute(
        "SELECT i.id, i.group_id, g.name AS group_name FROM invites i"
        " JOIN groups g ON g.id = i.group_id"
        " WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.expires_at > ?",
        (hash_token(token), iso(now())),
    ).fetchone()
    if invite is None:
        raise HTTPException(404, "invalid_invite")
    return invite


def add_member(conn: sqlite3.Connection, invite: sqlite3.Row, user_id: int) -> None:
    """Join as member; counts as a use of the link only if they weren't in yet."""
    cur = conn.execute(
        "INSERT INTO memberships (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)"
        " ON CONFLICT DO NOTHING",
        (invite["group_id"], user_id, iso(now())),
    )
    if cur.rowcount:
        conn.execute("UPDATE invites SET use_count = use_count + 1 WHERE id = ?", (invite["id"],))


@router.get("/{token}")
def join_info(token: str, conn: Db) -> JoinInfo:
    return JoinInfo(group_name=_by_token(conn, token)["group_name"])


@router.post("/{token}/request", status_code=201)
def request_join(
    token: str, body: JoinRequest, request: Request, response: Response, conn: Db
) -> dict[str, bool | int]:
    """Join and sign in (spec §3.2). A new address gets an account with this name and password.
    An existing one joins only with its own password (otherwise anyone with the invite link
    could take it over), keeping its name and language: 401 `invalid_credentials` if wrong,
    409 `account_exists` if the account has no password yet. A new account's password must not
    be a common one (422 `common_password`); an existing account's is checked, not judged."""
    settings = request.app.state.settings
    ip = client_ip(request)
    session = None
    with transaction(conn):
        invite = _by_token(conn, token)
        prune(conn)
        # Every attempt counts, refused ones too (they probe which addresses have accounts).
        ok = rate_hit(conn, f"link-ip:{ip}", settings.link_limit_per_ip, HOUR)
        existing = conn.execute(
            "SELECT password_hash IS NOT NULL AS has_password FROM users WHERE email = ?",
            (body.email,),
        ).fetchone()
        user_id: int | None = None
        common = existing is None and is_common_password(body.password)
        if ok and existing is None and not common:
            cur = conn.execute(
                "INSERT INTO users (email, display_name, locale, password_hash, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    body.email,
                    body.display_name,
                    body.locale,
                    hash_password(body.password),
                    iso(now()),
                ),
            )
            user_id = cur.lastrowid
        elif ok and existing is not None and existing["has_password"]:
            # Raises 429 itself; a wrong password must not raise here (it'd undo the count).
            user_id = check_password(conn, body.email, body.password, ip)
        if user_id is not None:
            add_member(conn, invite, user_id)
            session = create_session(conn, user_id, request.headers.get("user-agent", "")[:200])
    if not ok:
        raise HTTPException(429, "rate_limited")
    if common:
        raise HTTPException(422, "common_password")
    if session is None:
        if existing is not None and not existing["has_password"]:
            raise HTTPException(409, "account_exists")
        raise HTTPException(401, "invalid_credentials")
    set_session_cookie(response, session)
    return {"joined": True, "group_id": invite["group_id"]}


@router.post("/{token}")
def join_signed_in(token: str, user: CurrentUser, conn: Db) -> Joined:
    with transaction(conn):
        invite = _by_token(conn, token)
        add_member(conn, invite, user.id)
    return Joined(group_id=invite["group_id"])
