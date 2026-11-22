"""Who may do what in a group (spec §2). Every group route goes through here.

- Not a member (and not instance admin): 404, so a group's existence isn't revealed.
- Member where an admin is needed: 403.
- The instance admin acts as group admin in every group, member or not.
"""

import sqlite3
from typing import Literal

from fastapi import HTTPException

from ourcalendar.deps import User

Role = Literal["admin", "member"]


def membership_role(conn: sqlite3.Connection, group_id: int, user_id: int) -> Role | None:
    row = conn.execute(
        "SELECT role FROM memberships WHERE group_id = ? AND user_id = ?", (group_id, user_id)
    ).fetchone()
    return row["role"] if row else None


def group_role(conn: sqlite3.Connection, user: User, group_id: int) -> Role | None:
    if user.is_instance_admin:
        exists = conn.execute("SELECT 1 FROM groups WHERE id = ?", (group_id,)).fetchone()
        return "admin" if exists else None
    return membership_role(conn, group_id, user.id)


def require_member(conn: sqlite3.Connection, user: User, group_id: int) -> Role:
    role = group_role(conn, user, group_id)
    if role is None:
        raise HTTPException(404, "not_found")
    return role


def require_group_admin(conn: sqlite3.Connection, user: User, group_id: int) -> None:
    if require_member(conn, user, group_id) != "admin":
        raise HTTPException(403, "forbidden")


def require_instance_admin(user: User) -> None:
    if not user.is_instance_admin:
        raise HTTPException(403, "forbidden")
