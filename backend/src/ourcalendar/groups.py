"""Groups, members and invite links (spec §2, §3.2, §3.3, §3.12)."""

import sqlite3
from datetime import timedelta
from typing import Literal, cast

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from ourcalendar.authz import (
    Role,
    membership_role,
    require_group_admin,
    require_instance_admin,
    require_member,
)
from ourcalendar.db import transaction
from ourcalendar.deps import CurrentUser, Db
from ourcalendar.security import hash_token, iso, new_token, now

router = APIRouter(prefix="/api/groups")

INVITE_LIFETIME = timedelta(days=7)
Region = Literal["DE-BE", "DE-BB"]


def _strip_name(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise ValueError("empty name")
    return v


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    _strip = field_validator("name")(_strip_name)


class GroupPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    regions: list[Region] | None = None
    _strip = field_validator("name")(_strip_name)


class GroupSummary(BaseModel):
    id: int
    name: str
    role: Role
    is_member: bool
    member_count: int


class Member(BaseModel):
    id: int
    display_name: str
    role: Role
    availability_updated_at: str | None
    # Nobody gets a sign-in link for the instance admin (spec §3.1); the settings page hides it.
    is_instance_admin: bool


class GroupDetail(BaseModel):
    id: int
    name: str
    regions: list[Region]
    role: Role
    is_member: bool
    members: list[Member]


class RolePatch(BaseModel):
    role: Role


class InviteOut(BaseModel):
    id: int
    created_at: str
    expires_at: str
    use_count: int
    created_by_name: str | None
    # None for links created before tokens were kept (they can't be shown again).
    url: str | None


class InviteCreated(BaseModel):
    invite: InviteOut
    url: str


def _regions(text: str) -> list[Region]:
    return cast(list[Region], [r for r in text.split(",") if r in ("DE-BE", "DE-BB")])


def group_detail(conn: sqlite3.Connection, group_id: int, role: Role, user_id: int) -> GroupDetail:
    g = conn.execute("SELECT id, name, regions FROM groups WHERE id = ?", (group_id,)).fetchone()
    members = conn.execute(
        "SELECT u.id, u.display_name, m.role, u.availability_updated_at, u.is_instance_admin"
        " FROM memberships m JOIN users u ON u.id = m.user_id"
        " WHERE m.group_id = ? ORDER BY u.display_name COLLATE NOCASE, u.id",
        (group_id,),
    ).fetchall()
    return GroupDetail(
        id=g["id"],
        name=g["name"],
        regions=_regions(g["regions"]),
        role=role,
        is_member=any(m["id"] == user_id for m in members),
        members=[Member(**dict(m)) for m in members],
    )


@router.get("")
def list_groups(user: CurrentUser, conn: Db) -> list[GroupSummary]:
    rows = conn.execute(
        "SELECT g.id, g.name, m.role,"
        " (SELECT count(*) FROM memberships x WHERE x.group_id = g.id) AS member_count"
        " FROM groups g LEFT JOIN memberships m ON m.group_id = g.id AND m.user_id = ?"
        " WHERE m.user_id IS NOT NULL OR ?"
        " ORDER BY g.name COLLATE NOCASE, g.id",
        (user.id, user.is_instance_admin),
    ).fetchall()
    return [
        GroupSummary(
            id=r["id"],
            name=r["name"],
            role="admin" if user.is_instance_admin else r["role"],
            is_member=r["role"] is not None,
            member_count=r["member_count"],
        )
        for r in rows
    ]


@router.post("", status_code=201)
def create_group(body: GroupCreate, user: CurrentUser, conn: Db) -> GroupDetail:
    require_instance_admin(user)
    t = iso(now())
    with transaction(conn):
        cur = conn.execute("INSERT INTO groups (name, created_at) VALUES (?, ?)", (body.name, t))
        gid = cur.lastrowid
        assert gid is not None
        # The creator is the first member and group admin (spec §3.12).
        conn.execute(
            "INSERT INTO memberships (group_id, user_id, role, joined_at)"
            " VALUES (?, ?, 'admin', ?)",
            (gid, user.id, t),
        )
    return group_detail(conn, gid, "admin", user.id)


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: int, user: CurrentUser, conn: Db) -> None:
    require_instance_admin(user)
    if conn.execute("DELETE FROM groups WHERE id = ?", (group_id,)).rowcount == 0:
        raise HTTPException(404, "not_found")


@router.get("/{group_id}")
def get_group(group_id: int, user: CurrentUser, conn: Db) -> GroupDetail:
    role = require_member(conn, user, group_id)
    return group_detail(conn, group_id, role, user.id)


@router.patch("/{group_id}")
def patch_group(group_id: int, body: GroupPatch, user: CurrentUser, conn: Db) -> GroupDetail:
    require_group_admin(conn, user, group_id)
    with transaction(conn):
        if body.name is not None:
            conn.execute("UPDATE groups SET name = ? WHERE id = ?", (body.name, group_id))
        if body.regions is not None:
            regions = ",".join(r for r in ("DE-BE", "DE-BB") if r in body.regions)
            conn.execute("UPDATE groups SET regions = ? WHERE id = ?", (regions, group_id))
    return group_detail(conn, group_id, "admin", user.id)


def _admin_count(conn: sqlite3.Connection, group_id: int) -> int:
    return int(
        conn.execute(
            "SELECT count(*) FROM memberships WHERE group_id = ? AND role = 'admin'", (group_id,)
        ).fetchone()[0]
    )


@router.patch("/{group_id}/members/{member_id}")
def patch_member(
    group_id: int, member_id: int, body: RolePatch, user: CurrentUser, conn: Db
) -> GroupDetail:
    require_group_admin(conn, user, group_id)
    with transaction(conn):
        current = membership_role(conn, group_id, member_id)
        if current is None:
            raise HTTPException(404, "not_found")
        if current == "admin" and body.role == "member" and _admin_count(conn, group_id) == 1:
            raise HTTPException(409, "last_admin")
        conn.execute(
            "UPDATE memberships SET role = ? WHERE group_id = ? AND user_id = ?",
            (body.role, group_id, member_id),
        )
    return group_detail(conn, group_id, "admin", user.id)


@router.delete("/{group_id}/members/{member_id}", status_code=204)
def remove_member(group_id: int, member_id: int, user: CurrentUser, conn: Db) -> None:
    """A group admin removes someone, or a member leaves (spec §3.2)."""
    if member_id == user.id:
        require_member(conn, user, group_id)
    else:
        require_group_admin(conn, user, group_id)
    with transaction(conn):
        current = membership_role(conn, group_id, member_id)
        if current is None:
            raise HTTPException(404, "not_found")
        if current == "admin" and _admin_count(conn, group_id) == 1:
            raise HTTPException(409, "last_admin")
        conn.execute(
            "DELETE FROM memberships WHERE group_id = ? AND user_id = ?", (group_id, member_id)
        )
        # The personal feed stops working with the membership (spec §3.10).
        conn.execute(
            "DELETE FROM feed_tokens WHERE group_id = ? AND user_id = ?", (group_id, member_id)
        )


def _invite_out(row: sqlite3.Row, base_url: str) -> InviteOut:
    return InviteOut(
        id=row["id"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        use_count=row["use_count"],
        created_by_name=row["created_by_name"],
        url=f"{base_url}/join/{row['token']}" if row["token"] else None,
    )


_INVITE_SELECT = (
    "SELECT i.id, i.created_at, i.expires_at, i.use_count, i.token,"
    " u.display_name AS created_by_name"
    " FROM invites i LEFT JOIN users u ON u.id = i.created_by"
)


@router.get("/{group_id}/invites")
def list_invites(group_id: int, request: Request, user: CurrentUser, conn: Db) -> list[InviteOut]:
    """Active links only: neither revoked nor expired."""
    require_group_admin(conn, user, group_id)
    rows = conn.execute(
        f"{_INVITE_SELECT} WHERE i.group_id = ? AND i.revoked_at IS NULL AND i.expires_at > ?"
        " ORDER BY i.created_at DESC, i.id DESC",
        (group_id, iso(now())),
    ).fetchall()
    base = request.app.state.settings.base_url
    return [_invite_out(r, base) for r in rows]


@router.post("/{group_id}/invites", status_code=201)
def create_invite(group_id: int, request: Request, user: CurrentUser, conn: Db) -> InviteCreated:
    require_group_admin(conn, user, group_id)
    token = new_token()
    t = now()
    cur = conn.execute(
        "INSERT INTO invites (group_id, token_hash, token, created_by, created_at, expires_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (group_id, hash_token(token), token, user.id, iso(t), iso(t + INVITE_LIFETIME)),
    )
    row = conn.execute(f"{_INVITE_SELECT} WHERE i.id = ?", (cur.lastrowid,)).fetchone()
    base = request.app.state.settings.base_url
    return InviteCreated(invite=_invite_out(row, base), url=f"{base}/join/{token}")


@router.delete("/{group_id}/invites/{invite_id}", status_code=204)
def revoke_invite(group_id: int, invite_id: int, user: CurrentUser, conn: Db) -> None:
    require_group_admin(conn, user, group_id)
    cur = conn.execute(
        "UPDATE invites SET revoked_at = ?, token = NULL"
        " WHERE id = ? AND group_id = ? AND revoked_at IS NULL",
        (iso(now()), invite_id, group_id),
    )
    if cur.rowcount == 0:
        raise HTTPException(404, "not_found")
