import sqlite3
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.conftest import add_group, add_user, login_as


@pytest.fixture
def anna(db: sqlite3.Connection, client: TestClient) -> int:
    uid = add_user(db, "a@example.com", "Anna")
    login_as(client, db, uid)
    return uid


@pytest.fixture
def gid(db: sqlite3.Connection, anna: int) -> int:
    return add_group(db, "Band", {anna: "member"})


def create(client: TestClient, gid: int, **fields: Any) -> Any:
    body = {"title": "Gig", "start_day": "2027-03-05", "end_day": "2027-03-06", **fields}
    return client.post(f"/api/groups/{gid}/events", json=body)


def listed(client: TestClient, gid: int, start: str, end: str) -> list[dict[str, Any]]:
    r = client.get(f"/api/groups/{gid}/events", params={"from": start, "to": end})
    assert r.status_code == 200, r.text
    result: list[dict[str, Any]] = r.json()["events"]
    return result


def test_create_edit_delete(
    client: TestClient, db: sqlite3.Connection, anna: int, gid: int
) -> None:
    r = create(client, gid, title="  Gig im Club  ", time_place=" 20 Uhr, Club ", note="")
    assert r.status_code == 201, r.text
    ev = r.json()
    assert ev == {
        "id": ev["id"],
        "group_id": gid,
        "title": "Gig im Club",
        "start_day": "2027-03-05",
        "end_day": "2027-03-06",
        "time_place": "20 Uhr, Club",
        "note": None,
        "created_by_name": "Anna",
        "updated_by_name": "Anna",
        "created_at": ev["created_at"],
        "updated_at": ev["updated_at"],
    }

    # Another member edits: only the fields sent change; null clears an optional field.
    ben = add_user(db, "b@example.com", "Ben")
    db.execute("INSERT INTO memberships VALUES (?, ?, 'member', '2026-01-01')", (gid, ben))
    login_as(client, db, ben)
    r = client.patch(
        f"/api/groups/{gid}/events/{ev['id']}",
        json={"end_day": "2027-03-07", "time_place": None, "note": "Bring cables"},
    )
    assert r.status_code == 200, r.text
    patched = r.json()
    assert patched["title"] == "Gig im Club"
    assert (patched["start_day"], patched["end_day"]) == ("2027-03-05", "2027-03-07")
    assert (patched["time_place"], patched["note"]) == (None, "Bring cables")
    assert (patched["created_by_name"], patched["updated_by_name"]) == ("Anna", "Ben")

    assert client.delete(f"/api/groups/{gid}/events/{ev['id']}").status_code == 204
    assert client.delete(f"/api/groups/{gid}/events/{ev['id']}").status_code == 404
    assert listed(client, gid, "2027-01-01", "2027-12-31") == []


def test_deleted_creator_is_former_member(
    client: TestClient, db: sqlite3.Connection, anna: int, gid: int
) -> None:
    ev = create(client, gid).json()
    ben = add_user(db, "b@example.com", "Ben")
    db.execute("INSERT INTO memberships VALUES (?, ?, 'member', '2026-01-01')", (gid, ben))
    db.execute("DELETE FROM users WHERE id = ?", (anna,))
    login_as(client, db, ben)
    [got] = listed(client, gid, "2027-03-01", "2027-03-31")
    assert got["id"] == ev["id"]
    assert got["created_by_name"] is None


@pytest.mark.parametrize(
    "fields",
    [
        {"title": ""},
        {"title": "   "},
        {"title": "x" * 81},
        {"title": None},
        {"time_place": "x" * 121},
        {"note": "x" * 501},
        {"start_day": "2027-3-05"},
        {"start_day": "20270305"},
        {"end_day": "2027-02-30"},
        {"start_day": "2027-03-06", "end_day": "2027-03-05"},
        {"start_day": "2027-03-01", "end_day": "2027-04-01"},  # 32 days
        {"title": 5},
    ],
)
def test_create_rejects(client: TestClient, gid: int, fields: dict[str, Any]) -> None:
    r = create(client, gid, **fields)
    assert r.status_code == 422, r.text
    assert r.json() == {"error": "invalid_input"}


def test_limits_are_inclusive(client: TestClient, gid: int) -> None:
    r = create(
        client,
        gid,
        title="x" * 80,
        time_place="y" * 120,
        note="z" * 500,
        start_day="2027-03-01",
        end_day="2027-03-31",
    )
    assert r.status_code == 201, r.text
    # Past dates are fine: no editable window for events.
    assert create(client, gid, start_day="2020-01-01", end_day="2020-01-01").status_code == 201


@pytest.mark.parametrize(
    "fields",
    [
        {"title": None},
        {"title": " "},
        {"start_day": None},
        {"end_day": "2027-03-04"},  # before the stored start
        {"end_day": "2027-04-05"},  # longer than 31 days with the stored start
        {"start_day": "2027-03-07"},  # after the stored end
        {"note": "x" * 501},
    ],
)
def test_patch_rejects(client: TestClient, gid: int, fields: dict[str, Any]) -> None:
    ev = create(client, gid).json()
    r = client.patch(f"/api/groups/{gid}/events/{ev['id']}", json=fields)
    assert r.status_code == 422, r.text


def test_range_returns_overlapping_sorted(client: TestClient, gid: int) -> None:
    spans = [
        ("2027-02-25", "2027-03-02"),  # overlaps the start
        ("2027-03-10", "2027-03-10"),
        ("2027-03-30", "2027-04-03"),  # overlaps the end
        ("2027-02-01", "2027-02-28"),  # before
        ("2027-04-01", "2027-04-02"),  # after
        ("2027-03-10", "2027-03-11"),  # same start: by id
    ]
    ids = [create(client, gid, start_day=s, end_day=e).json()["id"] for s, e in spans]
    got = listed(client, gid, "2027-03-01", "2027-03-31")
    assert [e["id"] for e in got] == [ids[0], ids[1], ids[5], ids[2]]


@pytest.mark.parametrize(
    ("start", "end"),
    [("2027-03-01", "2027-02-28"), ("2027-01-01", "2028-02-05"), ("2027-1-1", "2027-02-01")],
)
def test_range_rejects(client: TestClient, gid: int, start: str, end: str) -> None:
    r = client.get(f"/api/groups/{gid}/events", params={"from": start, "to": end})
    assert r.status_code == 422


def test_event_of_another_group_is_not_found(
    client: TestClient, db: sqlite3.Connection, anna: int, gid: int
) -> None:
    other = add_group(db, "Choir", {anna: "member"})
    ev = create(client, other).json()
    assert client.patch(f"/api/groups/{gid}/events/{ev['id']}", json={}).status_code == 404
    assert client.delete(f"/api/groups/{gid}/events/{ev['id']}").status_code == 404
    assert listed(client, gid, "2027-03-01", "2027-03-31") == []
    assert len(listed(client, other, "2027-03-01", "2027-03-31")) == 1


def test_non_member_is_refused(client: TestClient, db: sqlite3.Connection, gid: int) -> None:
    ev = create(client, gid).json()
    login_as(client, db, add_user(db, "o@example.com", "Olga"))
    # Not a member: 404, like every group route (authz.py).
    assert create(client, gid).status_code == 404
    assert client.get(f"/api/groups/{gid}/events?from=2027-03-01&to=2027-03-31").status_code == 404
    assert client.patch(f"/api/groups/{gid}/events/{ev['id']}", json={}).status_code == 404
    assert client.delete(f"/api/groups/{gid}/events/{ev['id']}").status_code == 404


def test_text_is_stored_verbatim(client: TestClient, gid: int) -> None:
    title = "<b>Gig</b> & 'Party'"
    ev = create(client, gid, title=title).json()
    assert ev["title"] == title
