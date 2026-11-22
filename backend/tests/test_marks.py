import sqlite3
from collections.abc import Mapping, Sequence
from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ourcalendar.days import window_end
from tests.conftest import add_group, add_user, login_as

TODAY = date(2026, 6, 10)  # window end: 2027-06-10


@pytest.fixture(autouse=True)
def pin_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ourcalendar.days.berlin_today", lambda: TODAY)


def day(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


def put(
    client: TestClient,
    user_id: int,
    days: Sequence[Mapping[str, object]],
    group_id: int | None = None,
) -> Any:
    return client.put("/api/marks", json={"user_id": user_id, "group_id": group_id, "days": days})


def marks(
    client: TestClient, gid: int, start: str = day(0), end: str = day(30)
) -> list[dict[str, Any]]:
    r = client.get(f"/api/groups/{gid}/marks", params={"from": start, "to": end})
    assert r.status_code == 200, r.text
    result: list[dict[str, Any]] = r.json()["marks"]
    return result


@pytest.fixture
def anna(db: sqlite3.Connection, client: TestClient) -> int:
    uid = add_user(db, "a@example.com", "Anna")
    login_as(client, db, uid)
    return uid


def test_window_end_clamps_to_month_end() -> None:
    assert window_end(date(2026, 6, 10)) == date(2027, 6, 10)
    assert window_end(date(2026, 12, 31)) == date(2027, 12, 31)
    assert window_end(date(2028, 2, 29)) == date(2029, 2, 28)
    assert window_end(date(2027, 2, 28)) == date(2028, 2, 28)


def test_own_write_and_read(client: TestClient, db: sqlite3.Connection, anna: int) -> None:
    gid = add_group(db, "Band", {anna: "member"})
    r = put(
        client,
        anna,
        [
            {"day": day(2), "state": "maybe", "note": "  Probe  "},
            {"day": day(1), "state": "busy"},
        ],
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "previous": [
            {"day": day(2), "state": "free", "note": None},
            {"day": day(1), "state": "free", "note": None},
        ]
    }
    assert marks(client, gid) == [
        {
            "user_id": anna,
            "day": day(1),
            "state": "busy",
            "note": None,
            "set_by_name": None,
            "set_by_former": False,
        },
        {
            "user_id": anna,
            "day": day(2),
            "state": "maybe",
            "note": "Probe",
            "set_by_name": None,
            "set_by_former": False,
        },
    ]


def test_free_deletes_the_row(client: TestClient, db: sqlite3.Connection, anna: int) -> None:
    gid = add_group(db, "Band", {anna: "member"})
    put(client, anna, [{"day": day(1), "state": "busy", "note": "x"}])
    r = put(client, anna, [{"day": day(1), "state": "free", "note": "ignored"}])
    assert r.json()["previous"] == [{"day": day(1), "state": "busy", "note": "x"}]
    assert marks(client, gid) == []
    assert db.execute("SELECT count(*) FROM day_marks").fetchone()[0] == 0


def test_notes(client: TestClient, db: sqlite3.Connection, anna: int) -> None:
    gid = add_group(db, "Band", {anna: "member"})
    ok = put(
        client,
        anna,
        [
            {"day": day(1), "state": "busy", "note": "   "},
            {"day": day(2), "state": "busy", "note": "x" * 80},
            {"day": day(3), "state": "free", "note": "y" * 81},  # ignored on free
        ],
    )
    assert ok.status_code == 200, ok.text
    assert [m["note"] for m in marks(client, gid)] == [None, "x" * 80]

    r = put(client, anna, [{"day": day(1), "state": "busy", "note": "x" * 81}])
    assert (r.status_code, r.json()) == (422, {"error": "invalid_input"})


@pytest.mark.parametrize(
    "days",
    [
        [],
        [{"day": day(1), "state": "busy"}, {"day": day(1), "state": "free"}],
        [{"day": day(i), "state": "busy"} for i in range(401)],
        [{"day": "2026-6-12", "state": "busy"}],
        [{"day": "20260612", "state": "busy"}],
        [{"day": "2026-02-30", "state": "busy"}],
        [{"day": 1781049600, "state": "busy"}],
        [{"day": day(1), "state": "away"}],
    ],
    ids=["empty", "duplicate", "401 days", "short", "basic", "no such day", "number", "state"],
)
def test_invalid_writes(client: TestClient, anna: int, days: list[dict[str, object]]) -> None:
    r = put(client, anna, days)
    assert (r.status_code, r.json()) == (422, {"error": "invalid_input"})


def test_whole_window_in_one_write(client: TestClient, anna: int) -> None:
    n = (window_end(TODAY) - TODAY).days + 1
    r = put(client, anna, [{"day": day(i), "state": "busy"} for i in range(n)])
    assert r.status_code == 200, r.text


@pytest.mark.parametrize(
    ("d", "status"),
    [
        (day(-1), 422),
        (day(0), 200),
        ("2027-06-10", 200),
        ("2027-06-11", 422),
    ],
    ids=["yesterday", "today", "window end", "after window end"],
)
def test_editable_window(client: TestClient, anna: int, d: str, status: int) -> None:
    r = put(client, anna, [{"day": day(1), "state": "busy"}, {"day": d, "state": "busy"}])
    assert r.status_code == status, r.text
    if status == 422:
        assert r.json() == {"error": "outside_window"}


def test_previous_values_undo_the_write(
    client: TestClient, db: sqlite3.Connection, anna: int
) -> None:
    gid = add_group(db, "Band", {anna: "member"})
    put(
        client,
        anna,
        [{"day": day(1), "state": "busy", "note": "a"}, {"day": day(2), "state": "maybe"}],
    )
    before = marks(client, gid)

    r = put(
        client, anna, [{"day": d, "state": "busy", "note": "new"} for d in (day(1), day(2), day(3))]
    )
    assert marks(client, gid) != before
    undo = put(client, anna, r.json()["previous"])
    assert undo.status_code == 200, undo.text
    assert marks(client, gid) == before


def test_sets_availability_updated_at(
    client: TestClient, db: sqlite3.Connection, anna: int
) -> None:
    q = "SELECT availability_updated_at FROM users WHERE id = ?"
    assert db.execute(q, (anna,)).fetchone()[0] is None
    put(client, anna, [{"day": day(1), "state": "free"}])
    assert db.execute(q, (anna,)).fetchone()[0] is not None


def test_group_admin_writes_for_member(client: TestClient, db: sqlite3.Connection) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    mia = add_user(db, "m@example.com", "Mia")
    gid = add_group(db, "Band", {ada: "admin", mia: "member"})
    login_as(client, db, ada)
    r = put(client, mia, [{"day": day(1), "state": "busy"}], group_id=gid)
    assert r.status_code == 200, r.text
    put(client, ada, [{"day": day(1), "state": "maybe"}])

    login_as(client, db, mia)
    assert marks(client, gid) == [
        {
            "user_id": ada,
            "day": day(1),
            "state": "maybe",
            "note": None,
            "set_by_name": None,
            "set_by_former": False,
        },
        {
            "user_id": mia,
            "day": day(1),
            "state": "busy",
            "note": None,
            "set_by_name": "Ada",
            "set_by_former": False,
        },
    ]
    q = "SELECT availability_updated_at FROM users WHERE id = ?"
    assert db.execute(q, (mia,)).fetchone()[0] is not None


def test_writing_for_others_needs_admin_of_their_group(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    mia = add_user(db, "m@example.com", "Mia")
    max_ = add_user(db, "x@example.com", "Max")
    band = add_group(db, "Band", {ada: "admin", mia: "member"})
    add_group(db, "Choir", {max_: "member", mia: "member"})
    one = [{"day": day(1), "state": "busy"}]

    login_as(client, db, ada)
    # Max is in another group only.
    assert put(client, max_, one, group_id=band).json() == {"error": "forbidden"}
    assert put(client, max_, one, group_id=band).status_code == 403
    # Writing for someone else needs a group.
    assert put(client, mia, one).status_code == 403

    login_as(client, db, mia)
    assert put(client, ada, one, group_id=band).status_code == 403
    assert db.execute("SELECT count(*) FROM day_marks").fetchone()[0] == 0


def test_reading_needs_membership(client: TestClient, db: sqlite3.Connection, anna: int) -> None:
    gid = add_group(db, "Band", {})
    r = client.get(f"/api/groups/{gid}/marks", params={"from": day(0), "to": day(1)})
    assert (r.status_code, r.json()) == (404, {"error": "not_found"})


def test_removed_members_marks_are_hidden(
    client: TestClient, db: sqlite3.Connection, anna: int
) -> None:
    rolf = add_user(db, "r@example.com", "Rolf")
    gid = add_group(db, "Band", {anna: "admin", rolf: "member"})
    login_as(client, db, rolf)
    put(client, rolf, [{"day": day(1), "state": "busy"}])
    db.execute("DELETE FROM memberships WHERE user_id = ?", (rolf,))

    login_as(client, db, anna)
    assert marks(client, gid) == []


def test_past_days_are_readable(client: TestClient, db: sqlite3.Connection, anna: int) -> None:
    gid = add_group(db, "Band", {anna: "member"})
    db.execute(
        "INSERT INTO day_marks (user_id, day, state, set_by, updated_at)"
        " VALUES (?, '2025-01-01', 'busy', ?, 'x')",
        (anna, anna),
    )
    assert [m["day"] for m in marks(client, gid, "2024-12-01", "2025-01-31")] == ["2025-01-01"]


@pytest.mark.parametrize(
    ("start", "end", "status"),
    [
        ("2026-06-10", "2026-06-09", 422),
        ("2026-01-01", "2027-02-05", 422),  # 401 days
        ("2026-01-01", "2027-02-04", 200),  # 400 days
        ("2026-06-10", "2026-06-10", 200),
        ("2026-6-10", "2026-06-12", 422),
        ("2026-06-10", "", 422),
    ],
)
def test_read_range_validation(
    client: TestClient, db: sqlite3.Connection, anna: int, start: str, end: str, status: int
) -> None:
    gid = add_group(db, "Band", {anna: "member"})
    r = client.get(f"/api/groups/{gid}/marks", params={"from": start, "to": end})
    assert r.status_code == status, r.text
    if status == 422:
        assert r.json() == {"error": "invalid_input"}
    r = client.get(f"/api/groups/{gid}/marks", params={"from": start})
    assert (r.status_code, r.json()) == (422, {"error": "invalid_input"})
