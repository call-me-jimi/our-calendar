from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ourcalendar.cli import main
from ourcalendar.config import Settings
from ourcalendar.db import connect
from ourcalendar.main import create_app
from ourcalendar.security import now


def test_create_user_is_idempotent_and_only_grants_admin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    main(["create-user", "--email", "Anna@Example.com", "--name", "Anna"])
    main(["create-user", "--email", "anna@example.com", "--name", "Other", "--admin"])
    main(["create-user", "--email", "anna@example.com", "--name", "Other"])

    rows = (
        connect(tmp_path / "app.db")
        .execute("SELECT email, display_name, is_instance_admin FROM users")
        .fetchall()
    )
    assert [tuple(r) for r in rows] == [("anna@example.com", "Anna", 1)]
    assert "admin=True" in capsys.readouterr().out.splitlines()[-1]


def test_signin_link_prints_a_24_hour_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("BASE_URL", "https://ourcalendar.test")
    main(["create-user", "--email", "ivo@example.com", "--name", "Ivo", "--admin"])
    capsys.readouterr()

    assert main(["signin-link", "--email", " Ivo@Example.com "]) == 0
    url = capsys.readouterr().out.strip()
    assert url.startswith("https://ourcalendar.test/auth/verify#t=")
    expires = connect(tmp_path / "app.db").execute("SELECT expires_at FROM login_tokens")
    left = datetime.fromisoformat(expires.fetchone()[0]) - now()
    assert timedelta(hours=23) < left <= timedelta(hours=24)

    # It signs the instance admin in, once (no mail needed).
    settings = Settings(data_dir=tmp_path, base_url="https://ourcalendar.test")
    origin = {"Origin": "https://ourcalendar.test"}
    with TestClient(create_app(settings), base_url="https://ourcalendar.test", headers=origin) as c:
        token = url.split("#t=", 1)[1]
        r = c.post("/api/auth/verify", json={"token": token})
        assert r.status_code == 200
        assert r.json()["is_instance_admin"] is True
        assert c.post("/api/auth/verify", json={"token": token}).status_code == 400


def test_signin_link_for_unknown_email_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    assert main(["signin-link", "--email", "nobody@example.com"]) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert "no user" in out.err
