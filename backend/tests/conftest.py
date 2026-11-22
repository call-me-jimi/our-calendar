import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wannpassts.config import Settings
from wannpassts.db import connect
from wannpassts.mail import MemoryMailer
from wannpassts.main import create_app
from wannpassts.security import hash_password, iso, now

BASE = "https://testserver"


@pytest.fixture
def settings(tmp_path: Path, request: pytest.FixtureRequest) -> Settings:
    """Mail enabled (the `MemoryMailer` catches it); `@pytest.mark.no_mail` for link mode."""
    smtp = None if request.node.get_closest_marker("no_mail") else "smtp.test"
    return Settings(data_dir=tmp_path / "data", base_url=BASE, smtp_host=smtp)


@pytest.fixture
def mailer() -> MemoryMailer:
    return MemoryMailer()


@pytest.fixture
def client(settings: Settings, mailer: MemoryMailer) -> Iterator[TestClient]:
    app = create_app(settings, mailer)
    with TestClient(app, base_url=BASE, headers={"Origin": BASE}) as c:
        yield c


@pytest.fixture
def db(settings: Settings, client: TestClient) -> Iterator[sqlite3.Connection]:
    # `client` first: its startup creates and migrates the database.
    conn = connect(settings.db_path)
    yield conn
    conn.close()


def add_user(
    db: sqlite3.Connection,
    email: str,
    name: str = "Anna",
    *,
    admin: bool = False,
    locale: str = "de",
    password: str | None = None,
) -> int:
    cur = db.execute(
        "INSERT INTO users"
        " (email, display_name, locale, is_instance_admin, password_hash, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (email, name, locale, int(admin), password and hash_password(password), iso(now())),
    )
    assert cur.lastrowid is not None
    return cur.lastrowid


def link_token(mailer: MemoryMailer) -> str:
    m = re.search(r"#t=(\S+)", mailer.sent[-1].text)
    assert m, mailer.sent[-1].text
    return m.group(1)


def sign_in(client: TestClient, mailer: MemoryMailer, email: str) -> str:
    """Sign in through the real flow; return the session cookie's value."""
    assert client.post("/api/auth/request", json={"email": email}).status_code == 202
    r = client.post("/api/auth/verify", json={"token": link_token(mailer)})
    assert r.status_code == 200, r.text
    cookie = client.cookies.get("__Host-session")
    assert cookie
    return cookie


def login_as(client: TestClient, db: sqlite3.Connection, user_id: int | None) -> None:
    """Switch the client to a fresh session of `user_id` (None: signed out), skipping email."""
    from wannpassts.deps import create_session

    client.cookies.clear()
    if user_id is not None:
        client.cookies.set("__Host-session", create_session(db, user_id, "test"))


def add_group(db: sqlite3.Connection, name: str, members: dict[int, str]) -> int:
    """A group with members {user_id: role}, straight into the database."""
    cur = db.execute("INSERT INTO groups (name, created_at) VALUES (?, ?)", (name, iso(now())))
    gid = cur.lastrowid
    assert gid is not None
    for uid, role in members.items():
        db.execute(
            "INSERT INTO memberships (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
            (gid, uid, role, iso(now())),
        )
    return gid
