from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wannpassts.config import Settings
from wannpassts.main import create_app


@pytest.fixture
def static(tmp_path: Path) -> Path:
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>shell</title>")
    (d / "assets" / "app-abc123.js").write_text("console.log(1)")
    (d / "manifest.webmanifest").write_text("{}")
    (tmp_path / "secret.txt").write_text("outside")
    return d


@pytest.fixture
def client(tmp_path: Path, static: Path) -> Iterator[TestClient]:
    settings = Settings(data_dir=tmp_path / "data", base_url="https://t", static_dir=static)
    with TestClient(create_app(settings)) as c:
        yield c


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_unknown_api_route_is_json_404(client: TestClient) -> None:
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.json() == {"error": "not_found"}


def test_spa_fallback_serves_index_for_client_routes(client: TestClient) -> None:
    r = client.get("/g/1/calendar")
    assert r.status_code == 200
    assert "shell" in r.text
    assert r.headers["cache-control"] == "no-cache"


def test_assets_are_immutable(client: TestClient) -> None:
    r = client.get("/assets/app-abc123.js")
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]


def test_root_file_served(client: TestClient) -> None:
    r = client.get("/manifest.webmanifest")
    assert r.text == "{}"
    assert r.headers["cache-control"] == "no-cache"
    # PWA manifest type (spec §3.14); browsers warn on anything else.
    assert r.headers["content-type"] == "application/manifest+json"


def test_path_traversal_gets_index_not_file(client: TestClient) -> None:
    r = client.get("/..%2Fsecret.txt")
    assert "outside" not in r.text


def test_head_on_spa_route(client: TestClient) -> None:
    assert client.head("/").status_code == 200
