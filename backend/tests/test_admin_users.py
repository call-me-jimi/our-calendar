"""The instance admin's user list and deleting someone else's account (spec §3.12)."""

import sqlite3

from fastapi.testclient import TestClient

from tests.conftest import add_group, add_user, login_as


def test_list_shows_every_account_with_its_groups(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ivo = add_user(db, "ivo@example.com", "Ivo", admin=True)
    ada = add_user(db, "ada@example.com", "Ada", password="geheim123")
    ben = add_user(db, "ben@example.com", "ben")
    add_group(db, "Chor", {ada: "member"})
    add_group(db, "Band", {ada: "admin"})
    login_as(client, db, ivo)
    users = client.get("/api/admin/users").json()
    assert [(u["display_name"], u["groups"], u["has_password"]) for u in users] == [
        ("Ada", ["Band", "Chor"], True),
        ("ben", [], False),
        ("Ivo", [], False),
    ]
    assert users[2]["is_instance_admin"] is True
    assert users[1]["id"] == ben


def test_delete_removes_the_account(client: TestClient, db: sqlite3.Connection) -> None:
    ivo = add_user(db, "ivo@example.com", "Ivo", admin=True)
    ben = add_user(db, "ben@example.com", "Ben", password="geheim123")
    add_group(db, "Band", {ivo: "admin", ben: "member"})
    login_as(client, db, ben)
    ben_cookie = client.cookies["__Host-session"]

    login_as(client, db, ivo)
    assert client.delete(f"/api/admin/users/{ben}").status_code == 204
    assert db.execute("SELECT count(*) FROM users WHERE id = ?", (ben,)).fetchone()[0] == 0
    q = "SELECT count(*) FROM memberships WHERE user_id = ?"
    assert db.execute(q, (ben,)).fetchone()[0] == 0
    # Ben's session is gone, and so is the password sign-in.
    client.cookies.set("__Host-session", ben_cookie)
    assert client.get("/api/me").status_code == 401
    client.cookies.clear()
    body = {"email": "ben@example.com", "password": "geheim123"}
    assert client.post("/api/auth/login", json=body).status_code == 401
    login_as(client, db, ivo)
    assert client.delete(f"/api/admin/users/{ben}").status_code == 404


def test_delete_refuses_self_other_instance_admins_and_last_admins(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ivo = add_user(db, "ivo@example.com", "Ivo", admin=True)
    eva = add_user(db, "eva@example.com", "Eva", admin=True)
    ada = add_user(db, "ada@example.com", "Ada")
    ben = add_user(db, "ben@example.com", "Ben")
    add_group(db, "Band", {ada: "admin", ben: "member"})
    login_as(client, db, ivo)
    for target, status, error in (
        (ivo, 403, "target_is_self"),
        (eva, 403, "target_is_instance_admin"),
        (ada, 409, "last_admin"),
    ):
        r = client.delete(f"/api/admin/users/{target}")
        assert (r.status_code, r.json()) == (status, {"error": error})
    assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 4
