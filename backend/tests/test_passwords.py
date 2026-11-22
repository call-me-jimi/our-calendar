"""Sign-in by email and password, and setting one (spec §3.1)."""

import sqlite3

from fastapi.testclient import TestClient

from ourcalendar.security import hash_password, verify_password
from tests.conftest import add_user, login_as

COOKIE = "__Host-session"


def login(client: TestClient, email: str, password: str) -> int:
    return client.post("/api/auth/login", json={"email": email, "password": password}).status_code


def test_hash_round_trip() -> None:
    stored = hash_password("geheim123")
    assert stored.startswith("scrypt$")
    assert "geheim123" not in stored
    assert stored != hash_password("geheim123")  # salted
    assert verify_password("geheim123", stored)
    assert not verify_password("geheim124", stored)
    assert not verify_password("geheim123", None)


def test_login_signs_in(client: TestClient, db: sqlite3.Connection) -> None:
    add_user(db, "ben@example.com", "Ben", password="geheim123")
    r = client.post("/api/auth/login", json={"email": " Ben@Example.com ", "password": "geheim123"})
    assert r.status_code == 200, r.text
    assert r.json()["display_name"] == "Ben"
    assert r.json()["has_password"] is True
    assert "HttpOnly" in r.headers["set-cookie"]
    assert client.get("/api/me").json()["email"] == "ben@example.com"


def test_login_failures_all_look_the_same(client: TestClient, db: sqlite3.Connection) -> None:
    add_user(db, "ben@example.com", "Ben", password="geheim123")
    add_user(db, "nopw@example.com", "Nora")
    for email, password in (
        ("ben@example.com", "falsch123"),
        ("nopw@example.com", "irgendwas"),
        ("nobody@example.com", "geheim123"),
        ("ben@example.com", ""),
    ):
        r = client.post("/api/auth/login", json={"email": email, "password": password})
        assert (r.status_code, r.json()) == (401, {"error": "invalid_credentials"})
        assert COOKIE not in client.cookies


def test_login_is_rate_limited_per_address(client: TestClient, db: sqlite3.Connection) -> None:
    add_user(db, "ben@example.com", "Ben", password="geheim123")
    codes = [login(client, "ben@example.com", f"falsch{i:04}") for i in range(10)]
    assert codes == [401] * 10
    assert login(client, "ben@example.com", "geheim123") == 429
    # Another address from the same IP still works.
    add_user(db, "mia@example.com", "Mia", password="geheim123")
    assert login(client, "mia@example.com", "geheim123") == 200


def test_login_is_rate_limited_per_ip(client: TestClient, db: sqlite3.Connection) -> None:
    codes = [login(client, f"u{i}@example.com", "falsch123") for i in range(31)]
    assert codes == [401] * 30 + [429]


def test_set_password_then_sign_in_with_it(client: TestClient, db: sqlite3.Connection) -> None:
    ben = add_user(db, "ben@example.com", "Ben")
    login_as(client, db, ben)
    assert client.get("/api/me").json()["has_password"] is False
    r = client.put("/api/me/password", json={"password": "neues-passwort"})
    assert r.status_code == 204
    assert client.get("/api/me").json()["has_password"] is True
    client.cookies.clear()
    assert login(client, "ben@example.com", "neues-passwort") == 200


def test_changing_the_password_signs_out_other_sessions(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ben = add_user(db, "ben@example.com", "Ben", password="altes-passwort")
    login_as(client, db, ben)
    other = client.cookies[COOKIE]
    login_as(client, db, ben)
    assert client.put("/api/me/password", json={"password": "neues-passwort"}).status_code == 204
    assert client.get("/api/me").status_code == 200  # this one stays
    q = "SELECT count(*) FROM sessions WHERE user_id = ?"
    assert db.execute(q, (ben,)).fetchone()[0] == 1
    client.cookies.set(COOKIE, other)
    assert client.get("/api/me").status_code == 401
    client.cookies.clear()
    assert login(client, "ben@example.com", "altes-passwort") == 401
    assert login(client, "ben@example.com", "neues-passwort") == 200


def test_set_password_validation_and_auth(client: TestClient, db: sqlite3.Connection) -> None:
    assert client.put("/api/me/password", json={"password": "geheim123"}).status_code == 401
    login_as(client, db, add_user(db, "ben@example.com", "Ben"))
    for password in ("kurz", "x" * 201):
        assert client.put("/api/me/password", json={"password": password}).status_code == 422
    r = client.put("/api/me/password", json={"password": "Schalke04"})
    assert (r.status_code, r.json()) == (422, {"error": "common_password"})


def test_deleting_the_account_drops_its_login_rate_counter(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ben = add_user(db, "ben@example.com", "Ben", password="geheim123")
    login(client, "ben@example.com", "falsch123")
    login_as(client, db, ben)
    assert client.delete("/api/me").status_code == 204
    q = "SELECT count(*) FROM rate_events WHERE key = 'login-email:ben@example.com'"
    assert db.execute(q).fetchone()[0] == 0
