"""The permission matrix (spec §6.2): every group endpoint x every kind of caller."""

import sqlite3
from dataclasses import dataclass
from datetime import date

import pytest
from fastapi.testclient import TestClient

from ourcalendar.security import hash_token, iso, now
from tests.conftest import add_group, add_user, login_as

CALLERS = ["anonymous", "outsider", "removed", "member", "group_admin", "instance_admin"]


@dataclass
class World:
    users: dict[str, int | None]
    group: int
    other_member: int
    invite: int
    invite_token: str
    event: int = 0
    feed_token: str = ""


@pytest.fixture
def world(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> World:
    monkeypatch.setattr("ourcalendar.days.berlin_today", lambda: date(2026, 6, 10))
    admin = add_user(db, "a@example.com", "Ada")
    member = add_user(db, "m@example.com", "Mia")
    removed = add_user(db, "r@example.com", "Rolf")
    other = add_user(db, "m2@example.com", "Max")
    gid = add_group(
        db, "Band", {admin: "admin", member: "member", other: "member", removed: "member"}
    )
    # "removed" was a member; removal deletes the row, so they're an outsider again.
    db.execute("DELETE FROM memberships WHERE user_id = ?", (removed,))
    users: dict[str, int | None] = {
        "anonymous": None,
        "outsider": add_user(db, "o@example.com", "Olga"),
        "removed": removed,
        "member": member,
        "group_admin": admin,
        "instance_admin": add_user(db, "i@example.com", "Ivo", admin=True),
    }
    token = "invite-token-for-the-matrix"  # noqa: S105
    cur = db.execute(
        "INSERT INTO invites (group_id, token_hash, created_by, created_at, expires_at)"
        " VALUES (?, ?, ?, ?, '2999-01-01T00:00:00+00:00')",
        (gid, hash_token(token), admin, iso(now())),
    )
    assert cur.lastrowid is not None
    invite = cur.lastrowid
    cur = db.execute(
        "INSERT INTO events (group_id, title, start_day, end_day, created_by, updated_by,"
        " created_at, updated_at) VALUES (?, 'Gig', '2026-06-12', '2026-06-12', ?, ?, ?, ?)",
        (gid, admin, admin, iso(now()), iso(now())),
    )
    assert cur.lastrowid is not None
    feed_token = "feed-token-for-the-matrix"  # noqa: S105
    db.execute(
        "INSERT INTO feed_tokens (token_hash, group_id, user_id, created_at) VALUES (?, ?, ?, ?)",
        (hash_token(feed_token), gid, member, iso(now())),
    )
    return World(users, gid, other, invite, token, cur.lastrowid, feed_token)


# (method, path template, body, expected status per caller in CALLERS order).
# Body values "{g}" and "{other}" are replaced by those ids.
MATRIX: list[tuple[str, str, dict[str, object] | None, list[int]]] = [
    ("GET", "/api/groups", None, [401, 200, 200, 200, 200, 200]),
    ("POST", "/api/groups", {"name": "New"}, [401, 403, 403, 403, 403, 201]),
    ("GET", "/api/groups/{g}", None, [401, 404, 404, 200, 200, 200]),
    ("PATCH", "/api/groups/{g}", {"name": "X"}, [401, 404, 404, 403, 200, 200]),
    ("DELETE", "/api/groups/{g}", None, [401, 403, 403, 403, 403, 204]),
    (
        "PATCH",
        "/api/groups/{g}/members/{other}",
        {"role": "admin"},
        [401, 404, 404, 403, 200, 200],
    ),
    ("DELETE", "/api/groups/{g}/members/{other}", None, [401, 404, 404, 403, 204, 204]),
    (
        "POST",
        "/api/groups/{g}/members/{other}/signin-link",
        None,
        [401, 404, 404, 403, 201, 201],
    ),
    ("GET", "/api/groups/{g}/invites", None, [401, 404, 404, 403, 200, 200]),
    ("POST", "/api/groups/{g}/invites", None, [401, 404, 404, 403, 201, 201]),
    ("DELETE", "/api/groups/{g}/invites/{invite}", None, [401, 404, 404, 403, 204, 204]),
    ("GET", "/api/join/{token}", None, [200, 200, 200, 200, 200, 200]),
    ("POST", "/api/join/{token}", None, [401, 200, 200, 200, 200, 200]),
    (
        "POST",
        "/api/join/{token}/request",
        {"email": "new@example.com", "display_name": "New", "password": "new-geheim-42"},
        [201, 201, 201, 201, 201, 201],
    ),
    (
        "GET",
        "/api/groups/{g}/marks?from=2026-06-01&to=2026-06-30",
        None,
        [401, 404, 404, 200, 200, 200],
    ),
    (
        "PUT",
        "/api/marks",
        {"user_id": "{other}", "group_id": "{g}", "days": [{"day": "2026-06-12", "state": "busy"}]},
        [401, 404, 404, 403, 200, 200],
    ),
    (
        "GET",
        "/api/groups/{g}/events?from=2026-06-01&to=2026-06-30",
        None,
        [401, 404, 404, 200, 200, 200],
    ),
    (
        "POST",
        "/api/groups/{g}/events",
        {"title": "Gig", "start_day": "2026-07-01", "end_day": "2026-07-01"},
        [401, 404, 404, 201, 201, 201],
    ),
    (
        "PATCH",
        "/api/groups/{g}/events/{event}",
        {"title": "New"},
        [401, 404, 404, 200, 200, 200],
    ),
    ("DELETE", "/api/groups/{g}/events/{event}", None, [401, 404, 404, 204, 204, 204]),
    ("GET", "/api/groups/{g}/feed-token", None, [401, 404, 404, 200, 200, 200]),
    ("POST", "/api/groups/{g}/feed-token", None, [401, 404, 404, 200, 200, 200]),
    # The token alone grants access (member's token), whoever is signed in.
    ("GET", "/feed/{feed}.ics", None, [200, 200, 200, 200, 200, 200]),
    (
        "GET",
        "/api/holidays?from=2026-06-01&to=2026-06-30&regions=DE-BE",
        None,
        [401, 200, 200, 200, 200, 200],
    ),
    ("GET", "/api/admin/status", None, [401, 403, 403, 403, 403, 200]),
    ("GET", "/api/admin/users", None, [401, 403, 403, 403, 403, 200]),
    ("DELETE", "/api/admin/users/{other}", None, [401, 403, 403, 403, 403, 204]),
    ("GET", "/api/info", None, [200, 200, 200, 200, 200, 200]),
    ("GET", "/api/me", None, [401, 200, 200, 200, 200, 200]),
    # The group admin is Band's only admin (last_admin); the instance admin is the only one.
    ("DELETE", "/api/me", None, [401, 204, 204, 204, 409, 409]),
]

CASES = [
    pytest.param(method, path, body, caller, expected[i], id=f"{method} {path} as {caller}")
    for method, path, body, expected in MATRIX
    for i, caller in enumerate(CALLERS)
]


@pytest.mark.parametrize(("method", "path", "body", "caller", "status"), CASES)
def test_matrix(
    client: TestClient,
    db: sqlite3.Connection,
    world: World,
    method: str,
    path: str,
    body: dict[str, object] | None,
    caller: str,
    status: int,
) -> None:
    login_as(client, db, world.users[caller])
    url = path.format(
        g=world.group,
        other=world.other_member,
        invite=world.invite,
        token=world.invite_token,
        event=world.event,
        feed=world.feed_token,
    )
    ids = {"{g}": world.group, "{other}": world.other_member}
    if body is not None:
        body = {k: ids.get(v, v) if isinstance(v, str) else v for k, v in body.items()}
    r = client.request(method, url, json=body)
    assert r.status_code == status, r.text


def test_instance_admin_gets_404_for_missing_group(
    client: TestClient, db: sqlite3.Connection, world: World
) -> None:
    login_as(client, db, world.users["instance_admin"])
    assert client.get("/api/groups/9999").status_code == 404


def test_member_may_leave_but_not_remove_others(
    client: TestClient, db: sqlite3.Connection, world: World
) -> None:
    member = world.users["member"]
    login_as(client, db, member)
    assert (
        client.delete(f"/api/groups/{world.group}/members/{world.other_member}").status_code == 403
    )
    assert client.delete(f"/api/groups/{world.group}/members/{member}").status_code == 204
    assert client.get(f"/api/groups/{world.group}").status_code == 404
