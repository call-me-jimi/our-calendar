"""Deleting your account (spec §3.11) and the public instance info (spec §3.1, §5)."""

import sqlite3
from datetime import date

import pytest
from fastapi.testclient import TestClient

from ourcalendar.config import Settings, load_settings
from ourcalendar.mail import MemoryMailer
from ourcalendar.main import create_app
from tests.conftest import add_group, add_user, login_as

COOKIE = "__Host-session"
DAY = "2026-06-12"


@pytest.fixture(autouse=True)
def pin_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ourcalendar.days.berlin_today", lambda: date(2026, 6, 10))


def references(db: sqlite3.Connection, user_id: int, email: str) -> list[str]:
    """Every place the user still appears: a foreign key to users.id, or the email anywhere."""
    found = []
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    for table in tables:
        for fk in db.execute(f"PRAGMA foreign_key_list({table})"):
            if fk["table"] == "users":
                q = f"SELECT count(*) FROM {table} WHERE {fk['from']} = ?"  # noqa: S608
                if db.execute(q, (user_id,)).fetchone()[0]:
                    found.append(f"{table}.{fk['from']}")
        for col in db.execute(f"PRAGMA table_info({table})"):
            q = f"SELECT count(*) FROM {table} WHERE CAST({col['name']} AS TEXT) LIKE ?"  # noqa: S608
            if db.execute(q, (f"%{email}%",)).fetchone()[0]:
                found.append(f"{table}.{col['name']} (email)")
    if db.execute("SELECT count(*) FROM users WHERE id = ?", (user_id,)).fetchone()[0]:
        found.append("users.id")
    return found


def test_delete_account_removes_every_personal_row(
    client: TestClient, db: sqlite3.Connection, mailer: MemoryMailer
) -> None:
    ada = add_user(db, "ada@example.com", "Ada")
    mia = add_user(db, "mia@example.com", "Mia")
    max_ = add_user(db, "max@example.com", "Max")
    gid = add_group(db, "Band", {ada: "admin", mia: "admin", max_: "member"})
    solo = add_group(db, "Solo", {mia: "admin"})

    login_as(client, db, ada)
    ada_event = client.post(
        f"/api/groups/{gid}/events", json={"title": "Ada's", "start_day": DAY, "end_day": DAY}
    ).json()["id"]

    login_as(client, db, mia)
    mia_cookie = client.cookies[COOKIE]
    login_as(client, db, mia)  # a second session
    assert (
        client.put(
            "/api/marks",
            json={"user_id": mia, "days": [{"day": DAY, "state": "busy", "note": "x"}]},
        ).status_code
        == 200
    )
    put = {"user_id": max_, "group_id": gid, "days": [{"day": DAY, "state": "maybe"}]}
    assert client.put("/api/marks", json=put).status_code == 200
    event = {"title": "Mia's", "start_day": DAY, "end_day": DAY}
    mia_event = client.post(f"/api/groups/{gid}/events", json=event).json()["id"]
    r = client.patch(f"/api/groups/{gid}/events/{ada_event}", json={"title": "Edited"})
    assert r.status_code == 200
    assert client.post(f"/api/groups/{gid}/invites").status_code == 201
    assert client.post(f"/api/groups/{gid}/feed-token").status_code == 200
    # A pending sign-in link and the rate-limit counter of the address.
    assert client.post("/api/auth/request", json={"email": "mia@example.com"}).status_code == 202
    assert len(mailer.sent) == 1
    assert references(db, mia, "mia@example.com")

    r = client.delete("/api/me")
    assert r.status_code == 204, r.text
    assert f'{COOKIE}=""' in r.headers["set-cookie"]
    assert "Max-Age=0" in r.headers["set-cookie"]

    assert references(db, mia, "mia@example.com") == []
    # Others' rows stay, with the link to Mia NULLed.
    assert (
        db.execute("SELECT set_by FROM day_marks WHERE user_id = ?", (max_,)).fetchone()[0] is None
    )
    rows = db.execute("SELECT id, created_by, updated_by FROM events ORDER BY id").fetchall()
    assert [tuple(r) for r in rows] == [(ada_event, ada, None), (mia_event, None, None)]
    assert db.execute("SELECT created_by FROM invites").fetchone()[0] is None
    # The group Mia was alone in stays, empty, for the instance admin to delete.
    assert (
        db.execute("SELECT count(*) FROM memberships WHERE group_id = ?", (solo,)).fetchone()[0]
        == 0
    )

    # Both old sessions are dead; the old address gets no new link.
    client.cookies.clear()
    client.cookies.set(COOKIE, mia_cookie)
    assert client.get("/api/me").status_code == 401
    client.cookies.clear()
    assert client.post("/api/auth/request", json={"email": "mia@example.com"}).status_code == 202
    assert len(mailer.sent) == 1

    # Ada sees Max's day as set by a former member, and the events without creator names.
    login_as(client, db, ada)
    marks = client.get(f"/api/groups/{gid}/marks", params={"from": DAY, "to": DAY}).json()["marks"]
    assert marks == [
        {
            "user_id": max_,
            "day": DAY,
            "state": "maybe",
            "note": None,
            "set_by_name": None,
            "set_by_former": True,
        }
    ]
    events = client.get(f"/api/groups/{gid}/events", params={"from": DAY, "to": DAY}).json()[
        "events"
    ]
    names = {e["title"]: (e["created_by_name"], e["updated_by_name"]) for e in events}
    assert names == {"Edited": ("Ada", None), "Mia's": (None, None)}
    members = client.get(f"/api/groups/{gid}").json()["members"]
    assert [m["display_name"] for m in members] == ["Ada", "Max"]


def test_last_admin_of_a_group_with_others_cannot_delete(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ada = add_user(db, "ada@example.com", "Ada")
    mia = add_user(db, "mia@example.com", "Mia")
    add_group(db, "Band", {ada: "admin", mia: "member"})
    login_as(client, db, ada)
    r = client.delete("/api/me")
    assert r.status_code == 409
    assert r.json() == {"error": "last_admin"}
    assert client.get("/api/me").status_code == 200

    # With a second admin it works.
    db.execute("UPDATE memberships SET role = 'admin' WHERE user_id = ?", (mia,))
    assert client.delete("/api/me").status_code == 204


def test_last_instance_admin_cannot_delete(client: TestClient, db: sqlite3.Connection) -> None:
    ivo = add_user(db, "ivo@example.com", "Ivo", admin=True)
    login_as(client, db, ivo)
    r = client.delete("/api/me")
    assert r.status_code == 409
    assert r.json() == {"error": "last_instance_admin"}

    add_user(db, "eva@example.com", "Eva", admin=True)
    assert client.delete("/api/me").status_code == 204


def test_delete_needs_session_and_origin(client: TestClient, db: sqlite3.Connection) -> None:
    assert client.delete("/api/me").status_code == 401
    login_as(client, db, add_user(db, "ada@example.com", "Ada"))
    assert client.delete("/api/me", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/me").status_code == 200


def test_info_says_mail_is_enabled(client: TestClient) -> None:
    r = client.get("/api/info")
    assert r.status_code == 200
    assert r.json() == {"mail_enabled": True, "operator_name": None}


@pytest.mark.no_mail
def test_info_says_mail_is_disabled(client: TestClient) -> None:
    assert client.get("/api/info").json() == {"mail_enabled": False, "operator_name": None}


def test_info_names_the_operator_when_set(settings: Settings) -> None:
    named = Settings(data_dir=settings.data_dir, base_url=settings.base_url, operator_name="Kim")
    with TestClient(create_app(named, MemoryMailer())) as c:
        assert c.get("/api/info").json()["operator_name"] == "Kim"


def test_operator_name_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPERATOR_NAME", "  Kim ")
    assert load_settings().operator_name == "Kim"
    monkeypatch.setenv("OPERATOR_NAME", " ")
    assert load_settings().operator_name is None
