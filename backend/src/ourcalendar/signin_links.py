"""Sign-in links handed out instead of mailed (spec §3.1): needed when there is no mail
provider, and available with one too.

A link is a single-use `login` token, redeemed by the usual `POST /api/auth/verify`.
"""

import logging
import sqlite3
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ourcalendar.authz import require_group_admin
from ourcalendar.db import transaction
from ourcalendar.deps import CurrentUser, Db, User
from ourcalendar.security import (
    HANDED_LINK_LIFETIME,
    HOUR,
    LIMIT_LINKS_PER_CALLER,
    hash_token,
    iso,
    new_token,
    now,
    prune,
    rate_hit,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


class LinkOut(BaseModel):
    # Shown once: only the hash is stored.
    url: str
    expires_at: str


def issue_login_link(
    conn: sqlite3.Connection, base_url: str, email: str, locale: str, lifetime: timedelta
) -> LinkOut:
    """Store a single-use login token for `email`; return its verify URL."""
    token = new_token()
    t = now()
    expires = iso(t + lifetime)
    conn.execute(
        "INSERT INTO login_tokens (token_hash, email, purpose, locale, expires_at, created_at)"
        " VALUES (?, ?, 'login', ?, ?, ?)",
        (hash_token(token), email, locale, expires, iso(t)),
    )
    return LinkOut(url=f"{base_url}/auth/verify#t={token}", expires_at=expires)


def _rate_check(conn: sqlite3.Connection, user: User) -> None:
    prune(conn)
    if not rate_hit(conn, f"signin-link:{user.id}", LIMIT_LINKS_PER_CALLER, HOUR):
        raise HTTPException(429, "rate_limited")


@router.post("/groups/{group_id}/members/{member_id}/signin-link", status_code=201)
def member_link(
    group_id: int, member_id: int, request: Request, user: CurrentUser, conn: Db
) -> LinkOut:
    """A group admin signs a member in by link: whoever opens it *is* that member. So never for
    yourself, never for an instance admin, and a group admin can't do it for anyone who is an
    admin of any group (that would hand over their admin rights); the instance admin can."""
    require_group_admin(conn, user, group_id)
    with transaction(conn):
        target = conn.execute(
            "SELECT u.id, u.email, u.locale, u.is_instance_admin,"
            " EXISTS (SELECT 1 FROM memberships a WHERE a.user_id = u.id AND a.role = 'admin')"
            "  AS is_some_admin"
            " FROM memberships m JOIN users u ON u.id = m.user_id"
            " WHERE m.group_id = ? AND m.user_id = ?",
            (group_id, member_id),
        ).fetchone()
        if target is None:
            raise HTTPException(404, "not_found")
        if target["id"] == user.id:
            raise HTTPException(403, "target_is_self")
        if target["is_instance_admin"]:
            raise HTTPException(403, "target_is_instance_admin")
        if target["is_some_admin"] and not user.is_instance_admin:
            raise HTTPException(403, "target_is_admin")
        _rate_check(conn, user)
        link = issue_login_link(
            conn,
            request.app.state.settings.base_url,
            target["email"],
            target["locale"],
            HANDED_LINK_LIFETIME,
        )
    log.info("sign-in link created by user %d for user %d (group %d)", user.id, member_id, group_id)
    return link
