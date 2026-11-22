import sqlite3
from datetime import date
from typing import Any

import icalendar
import pytest
from fastapi.testclient import TestClient

from tests.conftest import BASE, add_group, add_user, login_as

TODAY = date(2026, 6, 10)


@pytest.fixture(autouse=True)
def pin_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ourcalendar.days.berlin_today", lambda: TODAY)


@pytest.fixture
def anna(db: sqlite3.Connection, client: TestClient) -> int:
    uid = add_user(db, "a@example.com", "Anna")
    login_as(client, db, uid)
    return uid


@pytest.fixture
def gid(db: sqlite3.Connection, anna: int) -> int:
    return add_group(db, "Band", {anna: "admin"})


def new_feed(client: TestClient, gid: int) -> str:
    """The feed's path (what follows BASE in the URL)."""
    r = client.post(f"/api/groups/{gid}/feed-token")
    assert r.status_code == 200, r.text
    url: str = r.json()["url"]
    assert url.startswith(f"{BASE}/feed/") and url.endswith(".ics")
    return url.removeprefix(BASE)


def add_event(client: TestClient, gid: int, start: str, end: str, **fields: Any) -> int:
    body = {"title": "Gig", "start_day": start, "end_day": end, **fields}
    r = client.post(f"/api/groups/{gid}/events", json=body)
    assert r.status_code == 201, r.text
    event_id: int = r.json()["id"]
    return event_id


def fetch(client: TestClient, path: str) -> icalendar.Calendar:
    r = client.get(path)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "text/calendar; charset=utf-8"
    assert r.headers["cache-control"] == "no-store"
    return icalendar.Calendar.from_ical(r.content)


def test_feed_round_trip(client: TestClient, gid: int) -> None:
    eid = add_event(
        client, gid, "2026-07-03", "2026-07-04", time_place="20 Uhr, Club", note="Bring cables"
    )
    path = new_feed(client, gid)
    client.cookies.clear()  # no session needed
    cal = fetch(client, path)
    assert cal["X-WR-CALNAME"] == "Band"
    assert cal["VERSION"] == "2.0"
    assert "PRODID" in cal
    [ev] = cal.walk("VEVENT")
    assert ev["UID"] == f"event-{eid}@testserver"
    assert ev["SUMMARY"] == "Gig"
    assert ev.decoded("DTSTART") == date(2026, 7, 3)
    assert ev.decoded("DTEND") == date(2026, 7, 5)  # exclusive
    assert ev["DTSTART"].params["VALUE"] == "DATE"
    assert ev["LOCATION"] == "20 Uhr, Club"
    assert ev["DESCRIPTION"] == "20 Uhr, Club\n\nBring cables"
    assert "DTSTAMP" in ev and "LAST-MODIFIED" in ev
    # Serialising again gives the same calendar.
    assert icalendar.Calendar.from_ical(cal.to_ical()) == cal


def test_feed_has_no_optional_fields_when_unset(client: TestClient, gid: int) -> None:
    add_event(client, gid, "2026-07-03", "2026-07-03")
    [ev] = fetch(client, new_feed(client, gid)).walk("VEVENT")
    assert "LOCATION" not in ev and "DESCRIPTION" not in ev


def test_events_older_than_a_year_are_left_out(client: TestClient, gid: int) -> None:
    add_event(client, gid, "2025-06-01", "2025-06-09", title="Old")
    add_event(client, gid, "2025-06-05", "2025-06-10", title="Year ago")
    add_event(client, gid, "2027-01-01", "2027-01-01", title="Future")
    events = fetch(client, new_feed(client, gid)).walk("VEVENT")
    assert [str(e["SUMMARY"]) for e in events] == ["Year ago", "Future"]


def test_only_this_groups_events(
    client: TestClient, db: sqlite3.Connection, anna: int, gid: int
) -> None:
    other = add_group(db, "Choir", {anna: "member"})
    add_event(client, other, "2026-07-03", "2026-07-03")
    assert fetch(client, new_feed(client, gid)).walk("VEVENT") == []


def test_regenerate_invalidates_old_url(
    client: TestClient, db: sqlite3.Connection, gid: int
) -> None:
    status = client.get(f"/api/groups/{gid}/feed-token")
    assert status.json() == {"active": False}
    old = new_feed(client, gid)
    assert client.get(f"/api/groups/{gid}/feed-token").json() == {"active": True}
    new = new_feed(client, gid)
    assert new != old
    assert client.get(old).status_code == 404
    fetch(client, new)
    assert db.execute("SELECT count(*) FROM feed_tokens").fetchone()[0] == 1


def test_unknown_token_is_404(client: TestClient, gid: int) -> None:
    r = client.get("/feed/nope.ics")
    assert r.status_code == 404
    assert r.content == b""


def test_token_is_stored_hashed(client: TestClient, db: sqlite3.Connection, gid: int) -> None:
    path = new_feed(client, gid)
    token = path.removeprefix("/feed/").removesuffix(".ics")
    stored = db.execute("SELECT token_hash FROM feed_tokens").fetchone()[0]
    assert token not in stored


def test_removed_member_feed_is_404(
    client: TestClient, db: sqlite3.Connection, anna: int, gid: int
) -> None:
    ben = add_user(db, "b@example.com", "Ben")
    db.execute("INSERT INTO memberships VALUES (?, ?, 'member', '2026-01-01')", (gid, ben))
    login_as(client, db, ben)
    path = new_feed(client, gid)
    fetch(client, path)
    login_as(client, db, anna)
    assert client.delete(f"/api/groups/{gid}/members/{ben}").status_code == 204
    assert client.get(path).status_code == 404
    assert db.execute("SELECT count(*) FROM feed_tokens").fetchone()[0] == 0


def test_leaving_ends_the_feed(
    client: TestClient, db: sqlite3.Connection, anna: int, gid: int
) -> None:
    ben = add_user(db, "b@example.com", "Ben")
    db.execute("INSERT INTO memberships VALUES (?, ?, 'member', '2026-01-01')", (gid, ben))
    login_as(client, db, ben)
    path = new_feed(client, gid)
    assert client.delete(f"/api/groups/{gid}/members/{ben}").status_code == 204
    assert client.get(path).status_code == 404


def test_non_member_gets_no_token(client: TestClient, db: sqlite3.Connection, gid: int) -> None:
    login_as(client, db, add_user(db, "o@example.com", "Olga"))
    assert client.post(f"/api/groups/{gid}/feed-token").status_code == 404
    assert client.get(f"/api/groups/{gid}/feed-token").status_code == 404
