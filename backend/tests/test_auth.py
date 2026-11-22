import sqlite3
from datetime import timedelta

from fastapi.testclient import TestClient

from ourcalendar.mail import MemoryMailer
from ourcalendar.security import hash_token, iso, now
from tests.conftest import BASE, add_user, link_token, sign_in

COOKIE = "__Host-session"


def test_unknown_email_gets_202_and_no_mail(client: TestClient, mailer: MemoryMailer) -> None:
    r = client.post("/api/auth/request", json={"email": "nobody@example.com"})
    assert r.status_code == 202
    assert r.json() == {"ok": True}
    assert mailer.sent == []


def test_known_email_gets_link_in_their_language(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com", "Anna", locale="de")
    add_user(db, "ben@example.com", "Ben", locale="en")

    client.post("/api/auth/request", json={"email": " Anna@Example.COM "})
    client.post("/api/auth/request", json={"email": "ben@example.com"})

    de, en = mailer.sent
    assert de.to == "anna@example.com"
    assert de.subject == "Dein Anmeldelink für Unser Kalender"
    assert f"{BASE}/auth/verify#t=" in de.text
    assert "Hallo Anna" in de.text
    assert en.subject == "Your sign-in link for Our Calendar"


def test_token_is_stored_hashed(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com")
    client.post("/api/auth/request", json={"email": "anna@example.com"})
    token = link_token(mailer)
    stored = [r[0] for r in db.execute("SELECT token_hash FROM login_tokens")]
    assert stored == [hash_token(token)]


def test_verify_sets_session_cookie(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com", admin=True)
    client.post("/api/auth/request", json={"email": "anna@example.com"})
    r = client.post("/api/auth/verify", json={"token": link_token(mailer)})

    assert r.status_code == 200
    assert r.json()["email"] == "anna@example.com"
    assert r.json()["is_instance_admin"] is True
    set_cookie = r.headers["set-cookie"]
    for part in ("__Host-session=", "HttpOnly", "Secure", "SameSite=lax", "Path=/"):
        assert part in set_cookie
    assert "Max-Age=7776000" in set_cookie  # 90 days
    assert client.get("/api/me").status_code == 200


def test_token_works_once(client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection) -> None:
    add_user(db, "anna@example.com")
    client.post("/api/auth/request", json={"email": "anna@example.com"})
    token = link_token(mailer)
    assert client.post("/api/auth/verify", json={"token": token}).status_code == 200
    r = client.post("/api/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert r.json() == {"error": "invalid_token"}


def test_expired_token_is_refused(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com")
    client.post("/api/auth/request", json={"email": "anna@example.com"})
    db.execute("UPDATE login_tokens SET expires_at = ?", (iso(now() - timedelta(seconds=1)),))
    r = client.post("/api/auth/verify", json={"token": link_token(mailer)})
    assert r.status_code == 400


def test_token_of_deleted_user_is_refused(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com")
    client.post("/api/auth/request", json={"email": "anna@example.com"})
    db.execute("DELETE FROM users")
    assert client.post("/api/auth/verify", json={"token": link_token(mailer)}).status_code == 400


def test_logged_out_cookie_is_refused_when_replayed(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com")
    old = sign_in(client, mailer, "anna@example.com")
    # The replay mechanism itself works: the same cookie set by hand is accepted.
    client.cookies.clear()
    client.cookies.set(COOKIE, old)
    assert client.get("/api/me").status_code == 200

    r = client.post("/api/auth/logout")
    assert r.status_code == 204
    assert "Max-Age=0" in r.headers["set-cookie"] or "expires=" in r.headers["set-cookie"].lower()

    client.cookies.set(COOKIE, old)
    r = client.get("/api/me")
    assert r.status_code == 401
    assert r.json() == {"error": "unauthenticated"}


def test_expired_session_is_refused(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com")
    sign_in(client, mailer, "anna@example.com")
    db.execute("UPDATE sessions SET expires_at = ?", (iso(now() - timedelta(seconds=1)),))
    assert client.get("/api/me").status_code == 401


def test_session_slides_once_a_day(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com")
    sign_in(client, mailer, "anna@example.com")

    r = client.get("/api/me")
    assert "set-cookie" not in r.headers  # fresh: nothing to renew

    soon = iso(now() + timedelta(days=3))
    db.execute(
        "UPDATE sessions SET last_used_at = ?, expires_at = ?",
        (iso(now() - timedelta(days=2)), soon),
    )
    r = client.get("/api/me")
    assert r.status_code == 200
    assert "Max-Age=7776000" in r.headers["set-cookie"]
    expires = db.execute("SELECT expires_at FROM sessions").fetchone()[0]
    assert expires > iso(now() + timedelta(days=89))


def test_rate_limit_per_email(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    add_user(db, "anna@example.com")
    for _ in range(6):
        r = client.post("/api/auth/request", json={"email": "anna@example.com"})
        assert r.status_code == 202  # never tells
    assert len(mailer.sent) == 5


def test_rate_limit_per_ip(
    client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection
) -> None:
    for i in range(21):
        add_user(db, f"user{i}@example.com")
    for i in range(21):
        client.post("/api/auth/request", json={"email": f"user{i}@example.com"})
    assert len(mailer.sent) == 20


def test_invalid_email_is_422(client: TestClient) -> None:
    r = client.post("/api/auth/request", json={"email": "not-an-email"})
    assert r.status_code == 422
    assert r.json() == {"error": "invalid_input"}


def test_write_without_origin_is_403(client: TestClient) -> None:
    r = client.post("/api/auth/request", json={"email": "a@b.de"}, headers={"Origin": ""})
    assert r.status_code == 403
    assert r.json() == {"error": "bad_origin"}


def test_write_from_foreign_origin_is_403(client: TestClient) -> None:
    r = client.post(
        "/api/auth/request", json={"email": "a@b.de"}, headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403


def test_reads_need_no_origin(client: TestClient) -> None:
    assert client.get("/api/health", headers={"Origin": ""}).status_code == 200


def test_me_requires_session(client: TestClient) -> None:
    assert client.get("/api/me").status_code == 401


def test_patch_me(client: TestClient, mailer: MemoryMailer, db: sqlite3.Connection) -> None:
    add_user(db, "anna@example.com")
    sign_in(client, mailer, "anna@example.com")

    r = client.patch("/api/me", json={"display_name": "  Anna B.  ", "locale": "en"})
    assert r.status_code == 200
    assert r.json()["display_name"] == "Anna B."
    assert client.get("/api/me").json()["locale"] == "en"

    assert client.patch("/api/me", json={"display_name": "   "}).status_code == 422
    assert client.patch("/api/me", json={"display_name": "x" * 41}).status_code == 422
    assert client.patch("/api/me", json={"locale": "fr"}).status_code == 422
