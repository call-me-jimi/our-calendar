"""Sign-in links handed out by admins or to your other device (spec §3.1)."""

import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from ourcalendar.security import hash_token, iso, now
from tests.conftest import BASE, add_group, add_user, login_as


@dataclass
class Band:
    group: int
    ada: int  # group admin
    mia: int  # member
    max: int  # member, and admin of another group
    ivo: int  # instance admin, a member of Band
    olga: int  # in another group only


@pytest.fixture
def band(db: sqlite3.Connection) -> Band:
    ada = add_user(db, "ada@example.com", "Ada")
    mia = add_user(db, "mia@example.com", "Mia", locale="en")
    max_ = add_user(db, "max@example.com", "Max")
    ivo = add_user(db, "ivo@example.com", "Ivo", admin=True)
    olga = add_user(db, "olga@example.com", "Olga")
    gid = add_group(db, "Band", {ada: "admin", mia: "member", max_: "member", ivo: "member"})
    add_group(db, "Choir", {max_: "admin", olga: "member"})
    return Band(gid, ada, mia, max_, ivo, olga)


def link_for(client: TestClient, band: Band, target: int) -> dict[str, str]:
    r = client.post(f"/api/groups/{band.group}/members/{target}/signin-link")
    assert r.status_code == 201, r.text
    body: dict[str, str] = r.json()
    return body


def redeem(client: TestClient, url: str) -> int:
    """Open the link signed out, as on another device; return the status of verify."""
    client.cookies.clear()
    token = url.split("#t=", 1)[1]
    return client.post("/api/auth/verify", json={"token": token}).status_code


def lasts(link: dict[str, str]) -> timedelta:
    return datetime.fromisoformat(link["expires_at"]) - now()


def test_group_admin_signs_a_member_in_by_link(
    client: TestClient, db: sqlite3.Connection, band: Band
) -> None:
    login_as(client, db, band.ada)
    link = link_for(client, band, band.mia)
    assert link["url"].startswith(f"{BASE}/auth/verify#t=")
    assert timedelta(hours=23, minutes=59) < lasts(link) <= timedelta(hours=24)
    token = link["url"].split("#t=", 1)[1]
    stored = db.execute("SELECT token_hash, email, purpose, locale FROM login_tokens").fetchall()
    assert [tuple(r) for r in stored] == [(hash_token(token), "mia@example.com", "login", "en")]

    # Whoever opens it is Mia, not Ada.
    assert redeem(client, link["url"]) == 200
    me = client.get("/api/me").json()
    assert (me["id"], me["display_name"]) == (band.mia, "Mia")
    # Single use.
    assert redeem(client, link["url"]) == 400


def test_expired_handed_link_is_refused(
    client: TestClient, db: sqlite3.Connection, band: Band
) -> None:
    login_as(client, db, band.ada)
    link = link_for(client, band, band.mia)
    db.execute("UPDATE login_tokens SET expires_at = ?", (iso(now() - timedelta(seconds=1)),))
    assert redeem(client, link["url"]) == 400
    assert client.get("/api/me").status_code == 401


@pytest.mark.parametrize(
    ("target", "status", "code"),
    [
        ("ada", 403, "target_is_self"),
        ("ivo", 403, "target_is_instance_admin"),
        ("max", 403, "target_is_admin"),  # admin of Choir: would hand over those rights
        ("olga", 404, "not_found"),  # not in Band
    ],
)
def test_group_admin_target_rules(
    client: TestClient, db: sqlite3.Connection, band: Band, target: str, status: int, code: str
) -> None:
    login_as(client, db, band.ada)
    r = client.post(f"/api/groups/{band.group}/members/{getattr(band, target)}/signin-link")
    assert (r.status_code, r.json()) == (status, {"error": code})
    assert db.execute("SELECT count(*) FROM login_tokens").fetchone()[0] == 0


def test_another_admin_of_the_same_group_is_excluded(
    client: TestClient, db: sqlite3.Connection, band: Band
) -> None:
    db.execute("UPDATE memberships SET role = 'admin' WHERE user_id = ?", (band.mia,))
    login_as(client, db, band.ada)
    r = client.post(f"/api/groups/{band.group}/members/{band.mia}/signin-link")
    assert (r.status_code, r.json()) == (403, {"error": "target_is_admin"})


def test_instance_admin_may_link_admins_but_not_instance_admins(
    client: TestClient, db: sqlite3.Connection, band: Band
) -> None:
    other_ia = add_user(db, "eva@example.com", "Eva", admin=True)
    db.execute(
        "INSERT INTO memberships (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
        (band.group, other_ia, iso(now())),
    )
    login_as(client, db, band.ivo)
    for target in (band.ada, band.max):
        assert (
            client.post(f"/api/groups/{band.group}/members/{target}/signin-link").status_code == 201
        )
    r = client.post(f"/api/groups/{band.group}/members/{other_ia}/signin-link")
    assert (r.status_code, r.json()) == (403, {"error": "target_is_instance_admin"})
    r = client.post(f"/api/groups/{band.group}/members/{band.ivo}/signin-link")
    assert (r.status_code, r.json()) == (403, {"error": "target_is_self"})


def test_instance_admin_need_not_be_a_member(
    client: TestClient, db: sqlite3.Connection, band: Band
) -> None:
    db.execute("DELETE FROM memberships WHERE user_id = ?", (band.ivo,))
    login_as(client, db, band.ivo)
    link = link_for(client, band, band.mia)
    assert redeem(client, link["url"]) == 200
    assert client.get("/api/me").json()["id"] == band.mia


def test_creating_a_link_is_logged_with_ids_only(
    client: TestClient, db: sqlite3.Connection, band: Band, caplog: pytest.LogCaptureFixture
) -> None:
    login_as(client, db, band.ada)
    with caplog.at_level(logging.INFO, logger="ourcalendar.signin_links"):
        link = link_for(client, band, band.mia)
    assert f"by user {band.ada} for user {band.mia} (group {band.group})" in caplog.text
    assert "mia@example.com" not in caplog.text
    assert link["url"].split("#t=", 1)[1] not in caplog.text


def test_links_per_caller_are_rate_limited(
    client: TestClient, db: sqlite3.Connection, band: Band
) -> None:
    login_as(client, db, band.ada)
    codes = [
        client.post(f"/api/groups/{band.group}/members/{band.mia}/signin-link").status_code
        for _ in range(20)
    ]
    assert codes == [201] * 20
    r = client.post(f"/api/groups/{band.group}/members/{band.mia}/signin-link")
    assert (r.status_code, r.json()) == (429, {"error": "rate_limited"})


@pytest.mark.no_mail
def test_links_work_without_mail(client: TestClient, db: sqlite3.Connection, band: Band) -> None:
    login_as(client, db, band.ada)
    link = link_for(client, band, band.mia)
    assert redeem(client, link["url"]) == 200
    assert client.get("/api/me").json()["id"] == band.mia
