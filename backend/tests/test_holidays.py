"""Holiday sync against recorded OpenHolidays 2027 responses, and the read API (spec §3.8)."""

import functools
import sqlite3
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.conftest import BASE, add_user, login_as
from wannpassts import holidays
from wannpassts.cli import main
from wannpassts.config import Settings
from wannpassts.main import create_app

# Recorded 2026-11-18 from the live API, validFrom=2027-01-01 validTo=2027-12-31.
FIXTURES = Path(__file__).parent / "fixtures" / "openholidays"


def recorded(request: httpx.Request) -> httpx.Response:
    """The real 2027 data; other years are empty."""
    p = request.url.params
    if p["validFrom"] != "2027-01-01":
        return httpx.Response(200, json=[])
    name = f"{request.url.path.strip('/')}-{p['subdivisionCode']}-2027.json"
    return httpx.Response(200, content=(FIXTURES / name).read_bytes())


RECORDED = httpx.MockTransport(recorded)


@pytest.fixture(autouse=True)
def today_2027(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("wannpassts.days.berlin_today", lambda: date(2027, 6, 1))


@pytest.fixture
def synced(settings: Settings, db: sqlite3.Connection) -> sqlite3.Connection:
    assert holidays.sync(settings.db_path, RECORDED)[0]
    return db


def rows(db: sqlite3.Connection, where: str) -> list[tuple[object, ...]]:
    cols = "kind, subdivision, start_day, end_day, name_de, name_en"
    sql = f"SELECT {cols} FROM holidays WHERE {where} ORDER BY subdivision"  # noqa: S608
    return [tuple(r) for r in db.execute(sql)]


def test_sync_maps_real_2027_data(synced: sqlite3.Connection) -> None:
    db = synced
    assert rows(db, "name_de = 'Reformationstag'") == [
        ("public", "DE-BB", "2027-10-31", "2027-10-31", "Reformationstag", "Reformation Day")
    ]
    assert rows(db, "name_de = 'Ostersonntag'") == [
        ("public", "DE-BB", "2027-03-28", "2027-03-28", "Ostersonntag", "Easter Sunday")
    ]
    assert rows(db, "name_de = 'Internationaler Frauentag'") == [
        (
            "public",
            "DE-BE",
            "2027-03-08",
            "2027-03-08",
            "Internationaler Frauentag",
            "International Women's Day",
        )
    ]
    # Nationwide: returned for both regions, stored once.
    assert rows(db, "start_day = '2027-10-03'") == [
        (
            "public",
            "DE",
            "2027-10-03",
            "2027-10-03",
            "Tag der Deutschen Einheit",
            "Day of German Unity",
        )
    ]
    # The single "unterrichtsfreie Tag" is Berlin's; Brandenburg calls its day off differently.
    assert rows(db, "start_day = '2027-05-07'") == [
        ("school", "DE-BB", "2027-05-07", "2027-05-07", "Variabler Ferientag", "Variable holiday"),
        ("school", "DE-BE", "2027-05-07", "2027-05-07", "Unterrichtsfreier Tag", "Day off"),
    ]
    # School holidays crossing New Year come back with their real start.
    assert rows(db, "name_de = 'Weihnachtsferien' AND start_day < '2027-01-01'") == [
        ("school", "DE-BB", "2026-12-23", "2027-01-02", "Weihnachtsferien", "Christmas holidays"),
        ("school", "DE-BE", "2026-12-23", "2027-01-02", "Weihnachtsferien", "Christmas holidays"),
    ]
    assert db.execute("SELECT count(*) FROM holidays WHERE subdivision = 'DE'").fetchone()[0] == 9
    assert db.execute("SELECT count(*) FROM holidays WHERE source_id IS NULL").fetchone()[0] == 0
    sync = db.execute("SELECT finished_at, ok, message FROM holiday_syncs").fetchall()
    assert len(sync) == 1
    assert sync[0]["finished_at"] and sync[0]["ok"] == 1


def test_sync_asks_for_three_years_in_all_languages(
    settings: Settings, db: sqlite3.Connection
) -> None:
    seen: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return recorded(request)

    holidays.sync(settings.db_path, httpx.MockTransport(handler))
    assert len(seen) == 3 * 2 * 2
    assert {u.params["validFrom"] for u in seen} == {"2027-01-01", "2028-01-01", "2029-01-01"}
    assert {u.params["subdivisionCode"] for u in seen} == {"DE-BE", "DE-BB"}
    assert {u.path for u in seen} == {"/PublicHolidays", "/SchoolHolidays"}
    assert all("languageIsoCode" not in u.params for u in seen)


def test_second_sync_is_idempotent(settings: Settings, synced: sqlite3.Connection) -> None:
    before = synced.execute("SELECT * FROM holidays ORDER BY id").fetchall()
    assert holidays.sync(settings.db_path, RECORDED)[0]
    after = synced.execute("SELECT * FROM holidays ORDER BY id").fetchall()
    assert [tuple(r) for r in after] == [tuple(r) for r in before]
    assert synced.execute("SELECT count(*) FROM holiday_syncs WHERE ok = 1").fetchone()[0] == 2


def _raise(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("no route to host", request=request)


@pytest.mark.parametrize(
    "handler",
    [
        _raise,
        lambda request: httpx.Response(500, text="oops"),
        lambda request: httpx.Response(200, json={"not": "a list"}),
        lambda request: httpx.Response(200, json=[{"id": "x", "startDate": "2027-13-01"}]),
    ],
    ids=["network", "http-500", "not-a-list", "bad-item"],
)
def test_failed_sync_keeps_rows_and_records_it(
    settings: Settings,
    synced: sqlite3.Connection,
    caplog: pytest.LogCaptureFixture,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    count = synced.execute("SELECT count(*) FROM holidays").fetchone()[0]
    ok, message = holidays.sync(settings.db_path, httpx.MockTransport(handler))
    assert not ok
    assert synced.execute("SELECT count(*) FROM holidays").fetchone()[0] == count
    last = synced.execute(
        "SELECT finished_at, ok, message FROM holiday_syncs ORDER BY id DESC"
    ).fetchone()
    assert last["finished_at"] and last["ok"] == 0 and last["message"] == message
    assert "holiday sync failed" in caplog.text


def test_name_falls_back_to_the_other_language() -> None:
    item = {"id": "1", "startDate": "2027-01-01", "endDate": "2027-01-01", "nationwide": True}
    only_de = holidays.to_row(
        "public", "DE-BE", {**item, "name": [{"language": "DE", "text": "A"}]}
    )
    only_en = holidays.to_row(
        "public", "DE-BE", {**item, "name": [{"language": "EN", "text": "B"}]}
    )
    assert (only_de.name_de, only_de.name_en, only_de.subdivision) == ("A", "A", "DE")
    assert (only_en.name_de, only_en.name_en) == ("B", "B")


@pytest.mark.parametrize(
    ("after", "expected"),
    [
        # 03:00 CEST -> 04:00 the same day.
        (datetime(2027, 6, 1, 1, 0, tzinfo=UTC), datetime(2027, 6, 1, 2, 0, tzinfo=UTC)),
        # Exactly 04:00 CEST -> tomorrow.
        (datetime(2027, 6, 1, 2, 0, tzinfo=UTC), datetime(2027, 6, 2, 2, 0, tzinfo=UTC)),
        # 05:00 CET on the day before clocks go forward -> 04:00 CEST, 22 h later.
        (datetime(2027, 3, 27, 4, 0, tzinfo=UTC), datetime(2027, 3, 28, 2, 0, tzinfo=UTC)),
        # 04:00 CEST on the day before clocks go back -> 04:00 CET, 25 h later.
        (datetime(2027, 10, 30, 2, 0, tzinfo=UTC), datetime(2027, 10, 31, 3, 0, tzinfo=UTC)),
        # 02:30 CEST, the first of the two 02:30s that night -> 04:00 CET.
        (datetime(2027, 10, 31, 0, 30, tzinfo=UTC), datetime(2027, 10, 31, 3, 0, tzinfo=UTC)),
    ],
)
def test_next_run_is_the_next_4am_in_berlin(after: datetime, expected: datetime) -> None:
    assert holidays.next_run(after) == expected


def _summary(client: TestClient, query: str) -> list[tuple[str, str, str, str]]:
    r = client.get(f"/api/holidays?{query}")
    assert r.status_code == 200, r.text
    return [
        (h["start_day"], h["kind"], h["subdivision"], h["name_de"]) for h in r.json()["holidays"]
    ]


def test_get_holidays_filters_by_region_and_range(
    client: TestClient, synced: sqlite3.Connection
) -> None:
    login_as(client, synced, add_user(synced, "a@example.com"))
    march = "from=2027-03-01&to=2027-03-28"
    assert _summary(client, f"{march}&regions=DE-BE") == [
        ("2027-03-08", "public", "DE-BE", "Internationaler Frauentag"),
        ("2027-03-22", "school", "DE-BE", "Osterferien"),
        ("2027-03-26", "public", "DE", "Karfreitag"),
    ]
    assert _summary(client, f"{march}&regions=DE-BB") == [
        ("2027-03-22", "school", "DE-BB", "Osterferien"),
        ("2027-03-26", "public", "DE", "Karfreitag"),
        ("2027-03-28", "public", "DE-BB", "Ostersonntag"),
    ]
    assert _summary(client, f"{march}&regions=DE-BB,DE-BE") == [
        ("2027-03-08", "public", "DE-BE", "Internationaler Frauentag"),
        ("2027-03-22", "school", "DE-BB", "Osterferien"),
        ("2027-03-22", "school", "DE-BE", "Osterferien"),
        ("2027-03-26", "public", "DE", "Karfreitag"),
        ("2027-03-28", "public", "DE-BB", "Ostersonntag"),
    ]
    # Overlap, not containment: holidays that started last year count.
    r = client.get("/api/holidays?from=2027-01-01&to=2027-01-01&regions=DE-BE")
    assert r.json() == {
        "holidays": [
            {
                "kind": "school",
                "subdivision": "DE-BE",
                "start_day": "2026-12-23",
                "end_day": "2027-01-02",
                "name_de": "Weihnachtsferien",
                "name_en": "Christmas holidays",
            },
            {
                "kind": "public",
                "subdivision": "DE",
                "start_day": "2027-01-01",
                "end_day": "2027-01-01",
                "name_de": "Neujahr",
                "name_en": "New Year's Day",
            },
        ]
    }
    assert _summary(client, f"{march}&regions=") == []
    assert _summary(client, march) == []


@pytest.mark.parametrize(
    "query",
    [
        "from=2027-03-01&to=2027-03-31&regions=DE-BY",
        "from=2027-03-01&to=2027-03-31&regions=DE",
        "from=2027-03-01&to=2027-03-31&regions=DE-BE,nope",
        "from=2027-03-31&to=2027-03-01&regions=DE-BE",
        "from=2027-01-01&to=2028-02-05&regions=DE-BE",
        "from=20270301&to=2027-03-31&regions=DE-BE",
        "to=2027-03-31&regions=DE-BE",
    ],
)
def test_get_holidays_rejects_bad_input(
    client: TestClient, db: sqlite3.Connection, query: str
) -> None:
    login_as(client, db, add_user(db, "a@example.com"))
    r = client.get(f"/api/holidays?{query}")
    assert (r.status_code, r.json()) == (422, {"error": "invalid_input"})


def test_admin_status_shows_last_sync_and_last_success(
    client: TestClient, settings: Settings, db: sqlite3.Connection
) -> None:
    login_as(client, db, add_user(db, "i@example.com", admin=True))
    assert client.get("/api/admin/status").json() == {"last_sync": None, "last_success": None}

    holidays.sync(settings.db_path, RECORDED)
    holidays.sync(settings.db_path, httpx.MockTransport(_raise))
    body = client.get("/api/admin/status").json()
    assert set(body["last_sync"]) == {"started_at", "finished_at", "ok", "message"}
    assert body["last_sync"]["ok"] is False
    assert "ConnectError" in body["last_sync"]["message"]
    assert body["last_success"]["ok"] is True
    assert body["last_success"]["finished_at"] <= body["last_sync"]["started_at"]


def test_cli_sync_holidays(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    real = holidays.sync
    monkeypatch.setattr(holidays, "sync", functools.partial(real, transport=RECORDED))
    assert main(["sync-holidays"]) == 0
    assert "holidays for 2027-2029" in capsys.readouterr().out
    monkeypatch.setattr(
        holidays, "sync", functools.partial(real, transport=httpx.MockTransport(_raise))
    )
    assert main(["sync-holidays"]) == 1


def test_app_runs_the_sync_at_startup_only_when_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran = threading.Event()

    def fake_sync(db_path: Path) -> tuple[bool, str]:
        ran.set()
        return True, "ok"

    monkeypatch.setattr(holidays, "sync", fake_sync)
    off = Settings(data_dir=tmp_path / "off", base_url=BASE)
    with TestClient(create_app(off)):
        assert not ran.wait(0.2)
    on = Settings(data_dir=tmp_path / "on", base_url=BASE, holiday_sync=True)
    with TestClient(create_app(on)):
        assert ran.wait(5)
    # Leaving the block cancelled the sleeping scheduler without an error.
