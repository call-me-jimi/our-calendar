import sqlite3

import pytest
from fastapi.testclient import TestClient
from httpx2 import Response

from ourcalendar.mail import MemoryMailer
from ourcalendar.security import iso, now
from tests.conftest import add_group, add_user, login_as


@pytest.fixture
def band(db: sqlite3.Connection) -> int:
    ada = add_user(db, "ada@example.com", "Ada")
    return add_group(db, "Band", {ada: "admin"})


def invite(client: TestClient, db: sqlite3.Connection, gid: int) -> tuple[int, str]:
    """Create an invite as the group's admin; return (invite id, token). Leaves the client
    signed out."""
    ada = db.execute("SELECT id FROM users WHERE email = 'ada@example.com'").fetchone()[0]
    login_as(client, db, ada)
    r = client.post(f"/api/groups/{gid}/invites").json()
    login_as(client, db, None)
    return r["invite"]["id"], r["url"].rsplit("/", 1)[1]


def use_count(db: sqlite3.Connection, invite_id: int) -> int:
    return int(db.execute("SELECT use_count FROM invites WHERE id = ?", (invite_id,)).fetchone()[0])


def test_join_info(client: TestClient, db: sqlite3.Connection, band: int) -> None:
    _, token = invite(client, db, band)
    assert client.get(f"/api/join/{token}").json() == {"group_name": "Band"}
    r = client.get("/api/join/not-a-real-token")
    assert r.status_code == 404
    assert r.json() == {"error": "invalid_invite"}


# Joining asks for name, email and password and signs in right away, with or without mail
# (spec §3.2).
NEW = {
    "email": "Ben@Example.com",
    "display_name": " Ben ",
    "password": "ben-geheim-42",
    "locale": "en",
}


def join(client: TestClient, token: str, **changes: str) -> Response:
    return client.post(f"/api/join/{token}/request", json={**NEW, **changes})


def test_new_person_joins_and_is_signed_in(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection, band: int
) -> None:
    inv, token = invite(client, db, band)
    r = join(client, token)
    assert r.status_code == 201, r.text
    assert r.json() == {"joined": True, "group_id": band}
    assert "HttpOnly" in r.headers["set-cookie"]
    assert mailer.sent == []
    me = client.get("/api/me").json()
    assert (me["email"], me["display_name"], me["locale"], me["has_password"]) == (
        "ben@example.com",
        "Ben",
        "en",
        True,
    )
    members = client.get(f"/api/groups/{band}").json()["members"]
    assert ("Ben", "member") in [(m["display_name"], m["role"]) for m in members]
    assert use_count(db, inv) == 1

    # The password signs in later.
    client.cookies.clear()
    r = client.post(
        "/api/auth/login", json={"email": "ben@example.com", "password": "ben-geheim-42"}
    )
    assert r.status_code == 200, r.text


@pytest.mark.no_mail
def test_without_mail_joining_works_the_same(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    _, token = invite(client, db, band)
    assert join(client, token).status_code == 201


def test_existing_account_joins_with_its_password(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    ben = add_user(db, "ben@example.com", "Benjamin", locale="de", password="altes-passwort")
    inv, token = invite(client, db, band)
    r = join(client, token, display_name="Someone", password="altes-passwort")
    assert r.status_code == 201, r.text
    me = client.get("/api/me").json()
    # Keeps its name and language (spec §3.2).
    assert (me["id"], me["display_name"], me["locale"]) == (ben, "Benjamin", "de")
    assert use_count(db, inv) == 1


def assert_untouched(client: TestClient, db: sqlite3.Connection, user_id: int, inv: int) -> None:
    """Not signed in, not added, not counted, account unchanged."""
    assert "__Host-session" not in client.cookies
    assert client.get("/api/me").status_code == 401
    q = "SELECT count(*) FROM memberships WHERE user_id = ?"
    assert db.execute(q, (user_id,)).fetchone()[0] == 0
    assert use_count(db, inv) == 0
    q = "SELECT count(*) FROM sessions WHERE user_id = ?"
    assert db.execute(q, (user_id,)).fetchone()[0] == 0
    name = db.execute("SELECT display_name FROM users WHERE id = ?", (user_id,)).fetchone()[0]
    assert name == "Benjamin"


def test_existing_account_with_a_wrong_password_is_refused(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    ben = add_user(db, "ben@example.com", "Benjamin", password="altes-passwort")
    inv, token = invite(client, db, band)
    r = join(client, token)
    assert (r.status_code, r.json()) == (401, {"error": "invalid_credentials"})
    assert_untouched(client, db, ben, inv)


def test_existing_account_without_a_password_is_refused(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    ben = add_user(db, "ben@example.com", "Benjamin")
    inv, token = invite(client, db, band)
    r = join(client, token)
    assert (r.status_code, r.json()) == (409, {"error": "account_exists"})
    assert_untouched(client, db, ben, inv)


def test_password_guesses_through_joining_hit_the_login_limit(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    add_user(db, "ben@example.com", "Ben", password="altes-passwort")
    _, token = invite(client, db, band)
    codes = [join(client, token, password=f"falsch{i:04}").status_code for i in range(11)]
    assert codes == [401] * 10 + [429]
    # The right password is locked out too, by sign-in as well.
    assert join(client, token, password="altes-passwort").status_code == 429
    body = {"email": "ben@example.com", "password": "altes-passwort"}
    assert client.post("/api/auth/login", json=body).status_code == 429


def test_signed_in_join_counts_once(client: TestClient, db: sqlite3.Connection, band: int) -> None:
    inv, token = invite(client, db, band)
    ben = add_user(db, "ben@example.com", "Ben")
    login_as(client, db, ben)

    assert client.post(f"/api/join/{token}").json() == {"group_id": band}
    assert client.post(f"/api/join/{token}").json() == {"group_id": band}
    assert use_count(db, inv) == 1


def test_expired_or_revoked_link_is_404_everywhere(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    inv, token = invite(client, db, band)
    db.execute("UPDATE invites SET expires_at = ? WHERE id = ?", (iso(now()), inv))
    assert client.get(f"/api/join/{token}").status_code == 404
    assert join(client, token).status_code == 404
    db.execute(
        "UPDATE invites SET revoked_at = ?, expires_at = ? WHERE id = ?", (iso(now()), "9999", inv)
    )
    assert join(client, token).status_code == 404
    assert join(client, "not-a-real-token").status_code == 404
    assert (
        db.execute("SELECT count(*) FROM users WHERE email = 'ben@example.com'").fetchone()[0] == 0
    )


def test_join_request_validation(client: TestClient, db: sqlite3.Connection, band: int) -> None:
    _, token = invite(client, db, band)
    for changes in (
        {"email": "nope"},
        {"display_name": "   "},
        {"display_name": "x" * 41},
        {"password": "kurz"},
        {"password": "x" * 201},
    ):
        assert join(client, token, **changes).status_code == 422
    r = client.post(f"/api/join/{token}/request", json={"email": "a@b.de", "display_name": "A"})
    assert r.status_code == 422


def test_a_new_account_needs_an_uncommon_password(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    inv, token = invite(client, db, band)
    r = join(client, token, password="Passwort1")
    assert (r.status_code, r.json()) == (422, {"error": "common_password"})
    assert (
        db.execute("SELECT count(*) FROM users WHERE email = 'ben@example.com'").fetchone()[0] == 0
    )
    assert use_count(db, inv) == 0


def test_an_existing_account_joins_with_its_common_password(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    add_user(db, "ben@example.com", "Ben", password="passwort1")
    _, token = invite(client, db, band)
    assert join(client, token, password="passwort1").status_code == 201


def test_joins_are_rate_limited_per_ip(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    _, token = invite(client, db, band)
    codes = []
    for i in range(21):
        client.cookies.clear()
        codes.append(join(client, token, email=f"u{i}@example.com").status_code)
    assert codes == [201] * 20 + [429]


def test_refused_joins_count_for_the_rate_limit(
    client: TestClient, db: sqlite3.Connection, band: int
) -> None:
    add_user(db, "ben@example.com", "Ben")
    _, token = invite(client, db, band)
    for _ in range(20):
        assert join(client, token, email="ben@example.com").status_code == 409
    r = join(client, token, email="new@example.com")
    assert (r.status_code, r.json()) == (429, {"error": "rate_limited"})


@pytest.mark.no_mail
def test_without_mail_sign_in_requests_send_nothing(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "ben@example.com", "Ben")
    r = client.post("/api/auth/request", json={"email": "ben@example.com"})
    assert r.status_code == 202
    assert mailer.sent == []
    assert db.execute("SELECT count(*) FROM login_tokens").fetchone()[0] == 0
