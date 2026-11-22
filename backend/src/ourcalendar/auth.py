"""Sign-in by password or magic link, sessions, and the user's own profile (spec §3.1, §3.11)."""

import logging
import sqlite3
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from ourcalendar.authz import require_instance_admin
from ourcalendar.db import transaction
from ourcalendar.deps import (
    CurrentUser,
    Db,
    User,
    clear_session_cookie,
    create_session,
    set_session_cookie,
)
from ourcalendar.mail import magic_link_mail
from ourcalendar.security import (
    HOUR,
    LIMIT_LOGIN_PER_EMAIL,
    LIMIT_LOGIN_PER_IP,
    LIMIT_PER_EMAIL,
    LINK_LIFETIME,
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
    verify_password,
)
from ourcalendar.signin_links import issue_login_link

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


class LinkRequest(BaseModel):
    email: str = Field(max_length=254)

    _norm = field_validator("email")(normalize_email)


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    # No minimum here: a too-short password is just a wrong one.
    password: str = Field(max_length=PASSWORD_MAX)

    _norm = field_validator("email")(normalize_email)


class PasswordIn(BaseModel):
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)


class TokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=100)


class MeOut(BaseModel):
    id: int
    email: str
    display_name: str
    locale: Literal["de", "en"]
    is_instance_admin: bool
    has_password: bool


class MePatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=40)
    locale: Literal["de", "en"] | None = None

    @field_validator("display_name")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("empty name")
        return v


def me_out(u: User) -> MeOut:
    return MeOut(
        id=u.id,
        email=u.email,
        display_name=u.display_name,
        locale=u.locale,
        is_instance_admin=u.is_instance_admin,
        has_password=u.has_password,
    )


_SELECT_USER = (
    "SELECT id, email, display_name, locale, is_instance_admin,"
    " password_hash IS NOT NULL AS has_password FROM users"
)


def row_out(row: sqlite3.Row) -> MeOut:
    return MeOut(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        locale=row["locale"],
        is_instance_admin=bool(row["is_instance_admin"]),
        has_password=bool(row["has_password"]),
    )


def check_password(conn: sqlite3.Connection, email: str, password: str, ip: str) -> int | None:
    """The user id if `password` is that account's; None otherwise (no account, no password set,
    or wrong). Every attempt counts against the address and the IP; over either limit: 429.
    Call inside a transaction."""
    ok_email = rate_hit(conn, f"login-email:{email}", LIMIT_LOGIN_PER_EMAIL, HOUR)
    ok_ip = rate_hit(conn, f"login-ip:{ip}", LIMIT_LOGIN_PER_IP, HOUR)
    if not (ok_email and ok_ip):
        log.warning("password rate limit hit (email ok=%s, ip ok=%s)", ok_email, ok_ip)
        raise HTTPException(429, "rate_limited")
    row = conn.execute("SELECT id, password_hash FROM users WHERE email = ?", (email,)).fetchone()
    if not verify_password(password, row["password_hash"] if row else None):
        return None
    return int(row["id"])


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, conn: Db) -> MeOut:
    """Sign in with email and password (spec §3.1). One answer, 401 `invalid_credentials`, for
    an unknown address, an account without a password and a wrong password."""
    user = token = None
    with transaction(conn):
        prune(conn)
        # A wrong password must not raise in here: that would roll back the counted attempt.
        user_id = check_password(conn, body.email, body.password, client_ip(request))
        if user_id is not None:
            token = create_session(conn, user_id, request.headers.get("user-agent", "")[:200])
            user = conn.execute(_SELECT_USER + " WHERE id = ?", (user_id,)).fetchone()
    if user is None or token is None:
        raise HTTPException(401, "invalid_credentials")
    set_session_cookie(response, token)
    return row_out(user)


@router.post("/auth/request", status_code=202)
def request_link(
    body: LinkRequest, request: Request, background: BackgroundTasks, conn: Db
) -> dict[str, bool]:
    """Email a sign-in link if the account exists. The answer never says whether it does,
    and the mail goes out after the response, so timing doesn't tell either.

    Without mail this does nothing: links come from an admin or another device (spec §3.1)."""
    settings = request.app.state.settings
    if not settings.mail_enabled:
        return {"ok": True}
    with transaction(conn):
        prune(conn)
        ok_email = rate_hit(conn, f"link-email:{body.email}", LIMIT_PER_EMAIL, HOUR)
        ok_ip = rate_hit(conn, f"link-ip:{client_ip(request)}", settings.link_limit_per_ip, HOUR)
        user = conn.execute(
            "SELECT display_name, locale FROM users WHERE email = ?", (body.email,)
        ).fetchone()
        if not (ok_email and ok_ip):
            log.warning("sign-in link rate limit hit (email ok=%s, ip ok=%s)", ok_email, ok_ip)
            return {"ok": True}
        if user is None:
            return {"ok": True}
        link = issue_login_link(conn, settings.base_url, body.email, user["locale"], LINK_LIFETIME)
    mail = magic_link_mail(body.email, user["display_name"], link.url, user["locale"])
    background.add_task(request.app.state.mailer.send, mail)
    return {"ok": True}


@router.post("/auth/verify")
def verify(body: TokenIn, request: Request, response: Response, conn: Db) -> MeOut:
    with transaction(conn):
        # Only `login`: joining no longer goes through a mailed link (spec §3.2).
        row = conn.execute(
            "SELECT id, email FROM login_tokens"
            " WHERE token_hash = ? AND purpose = 'login' AND used_at IS NULL AND expires_at > ?",
            (hash_token(body.token), iso(now())),
        ).fetchone()
        if row is None:
            raise HTTPException(400, "invalid_token")
        conn.execute("UPDATE login_tokens SET used_at = ? WHERE id = ?", (iso(now()), row["id"]))
        user = conn.execute(_SELECT_USER + " WHERE email = ?", (row["email"],)).fetchone()
        if user is None:
            raise HTTPException(400, "invalid_token")
        token = create_session(conn, user["id"], request.headers.get("user-agent", "")[:200])
    set_session_cookie(response, token)
    return row_out(user)


@router.post("/auth/logout", status_code=204)
def logout(user: CurrentUser, response: Response, conn: Db) -> None:
    conn.execute("DELETE FROM sessions WHERE id_hash = ?", (user.session_hash,))
    clear_session_cookie(response)


@router.get("/me")
def get_me(user: CurrentUser) -> MeOut:
    return me_out(user)


@router.patch("/me")
def patch_me(body: MePatch, user: CurrentUser, conn: Db) -> MeOut:
    name = body.display_name or user.display_name
    locale = body.locale or user.locale
    conn.execute(
        "UPDATE users SET display_name = ?, locale = ? WHERE id = ?", (name, locale, user.id)
    )
    return MeOut(
        id=user.id,
        email=user.email,
        display_name=name,
        locale=locale,
        is_instance_admin=user.is_instance_admin,
        has_password=user.has_password,
    )


@router.put("/me/password", status_code=204)
def set_password(body: PasswordIn, user: CurrentUser, conn: Db) -> None:
    """Set or change the password. The session is enough (no current password asked): without
    mail, a sign-in link from an admin is how a forgotten password gets reset (spec §3.1).
    Signs out every other session. 422 `common_password` if it's too easy to guess."""
    if is_common_password(body.password):
        raise HTTPException(422, "common_password")
    password_hash = hash_password(body.password)
    with transaction(conn):
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user.id))
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND id_hash != ?",
            (user.id, user.session_hash),
        )


def delete_user(conn: sqlite3.Connection, user_id: int, email: str) -> None:
    """Delete an account (spec §3.11). Cascades remove sessions, memberships, days, notes and
    feed tokens; `set_by`/`created_by`/`updated_by` become NULL ("former member"). A group the
    user was alone in stays, empty, for the instance admin to delete. Call in a transaction.

    The leave rule (spec §2): refused with 409 `last_admin` while the user is the only admin
    of a group that has other members."""
    if conn.execute(
        "SELECT 1 FROM memberships m WHERE m.user_id = ? AND m.role = 'admin'"
        " AND EXISTS (SELECT 1 FROM memberships o"
        "  WHERE o.group_id = m.group_id AND o.user_id != m.user_id)"
        " AND NOT EXISTS (SELECT 1 FROM memberships o"
        "  WHERE o.group_id = m.group_id AND o.user_id != m.user_id AND o.role = 'admin')",
        (user_id,),
    ).fetchone():
        raise HTTPException(409, "last_admin")
    # Not linked by foreign key: keyed by the email address.
    conn.execute("DELETE FROM login_tokens WHERE email = ?", (email,))
    conn.execute(
        "DELETE FROM rate_events WHERE key IN (?, ?)",
        (f"link-email:{email}", f"login-email:{email}"),
    )
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


@router.delete("/me", status_code=204)
def delete_me(user: CurrentUser, response: Response, conn: Db) -> None:
    with transaction(conn):
        if user.is_instance_admin:
            other = conn.execute(
                "SELECT 1 FROM users WHERE is_instance_admin = 1 AND id != ?", (user.id,)
            ).fetchone()
            if other is None:
                raise HTTPException(409, "last_instance_admin")
        delete_user(conn, user.id, user.email)
    clear_session_cookie(response)


class AdminUser(BaseModel):
    id: int
    email: str
    display_name: str
    is_instance_admin: bool
    has_password: bool
    created_at: str
    groups: list[str]


@router.get("/admin/users")
def list_users(user: CurrentUser, conn: Db) -> list[AdminUser]:
    """Every account, with the groups it is in (spec §3.12). Instance admin only."""
    require_instance_admin(user)
    groups: dict[int, list[str]] = {}
    for r in conn.execute(
        "SELECT m.user_id, g.name FROM memberships m JOIN groups g ON g.id = m.group_id"
        " ORDER BY g.name COLLATE NOCASE, g.id"
    ):
        groups.setdefault(r["user_id"], []).append(r["name"])
    rows = conn.execute(
        "SELECT id, email, display_name, is_instance_admin,"
        " password_hash IS NOT NULL AS has_password, created_at FROM users"
        " ORDER BY display_name COLLATE NOCASE, id"
    ).fetchall()
    return [
        AdminUser(
            id=r["id"],
            email=r["email"],
            display_name=r["display_name"],
            is_instance_admin=bool(r["is_instance_admin"]),
            has_password=bool(r["has_password"]),
            created_at=r["created_at"],
            groups=groups.get(r["id"], []),
        )
        for r in rows
    ]


@router.delete("/admin/users/{user_id}", status_code=204)
def admin_delete_user(user_id: int, user: CurrentUser, conn: Db) -> None:
    """The instance admin deletes someone else's account, exactly as "delete account" would
    (spec §3.12). Not yourself (use `/me`), not another instance admin."""
    require_instance_admin(user)
    with transaction(conn):
        target = conn.execute(
            "SELECT email, is_instance_admin FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if target is None:
            raise HTTPException(404, "not_found")
        if user_id == user.id:
            raise HTTPException(403, "target_is_self")
        if target["is_instance_admin"]:
            raise HTTPException(403, "target_is_instance_admin")
        delete_user(conn, user_id, target["email"])
    log.info("account %d deleted by instance admin %d", user_id, user.id)
