"""Group events: any member creates, edits and deletes them (spec §3.9, §5)."""

import sqlite3
from collections.abc import Callable
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, field_validator

from ourcalendar import days
from ourcalendar.authz import require_member
from ourcalendar.db import transaction
from ourcalendar.deps import CurrentUser, Db
from ourcalendar.marks import _range
from ourcalendar.security import iso, now

router = APIRouter(prefix="/api/groups/{group_id}/events")

TITLE_MAX = 80
TIME_PLACE_MAX = 120
NOTE_MAX = 500
MAX_LENGTH = 31  # days, both ends included


class Event(BaseModel):
    id: int
    group_id: int
    title: str
    start_day: str
    end_day: str
    time_place: str | None
    note: str | None
    # null: the user deleted their account ("former member", spec §3.9).
    created_by_name: str | None
    updated_by_name: str | None
    created_at: str
    updated_at: str


class Events(BaseModel):
    events: list[Event]


# Validators run only on values the client sent, so an explicit null for a required field
# fails while an omitted one (PATCH) stays None. All text is stored as plain text (spec §6.2).
def _check_title(v: str | None) -> str:
    v = v.strip() if v is not None else ""
    if not 1 <= len(v) <= TITLE_MAX:
        raise ValueError("invalid title")
    return v


def _check_day(v: object) -> date:
    if not isinstance(v, str):
        raise ValueError("invalid day")
    return days.parse_day(v)


def _optional(limit: int) -> Callable[[str | None], str | None]:
    """Trimmed free text; empty means none."""

    def check(v: str | None) -> str | None:
        v = v.strip() if v is not None else None
        if v and len(v) > limit:
            raise ValueError("text too long")
        return v or None

    return check


class EventCreate(BaseModel):
    title: str
    start_day: date
    end_day: date
    time_place: str | None = None
    note: str | None = None

    _title = field_validator("title")(_check_title)
    _days = field_validator("start_day", "end_day", mode="before")(_check_day)
    _time_place = field_validator("time_place")(_optional(TIME_PLACE_MAX))
    _note = field_validator("note")(_optional(NOTE_MAX))


class EventPatch(BaseModel):
    title: str | None = None
    start_day: date | None = None
    end_day: date | None = None
    time_place: str | None = None
    note: str | None = None

    _title = field_validator("title")(_check_title)
    _days = field_validator("start_day", "end_day", mode="before")(_check_day)
    _time_place = field_validator("time_place")(_optional(TIME_PLACE_MAX))
    _note = field_validator("note")(_optional(NOTE_MAX))


def _check_span(start: date, end: date) -> None:
    # No editable-window limit: events may lie in the past or far ahead.
    if end < start or (end - start).days + 1 > MAX_LENGTH:
        raise HTTPException(422, "invalid_input")


_SELECT = (
    "SELECT e.id, e.group_id, e.title, e.start_day, e.end_day, e.time_place, e.note,"
    " c.display_name AS created_by_name, u.display_name AS updated_by_name,"
    " e.created_at, e.updated_at"
    " FROM events e"
    " LEFT JOIN users c ON c.id = e.created_by"
    " LEFT JOIN users u ON u.id = e.updated_by"
)


def _get(conn: sqlite3.Connection, group_id: int, event_id: int) -> Event:
    # Scoped by group: another group's event id is simply not found.
    row = conn.execute(f"{_SELECT} WHERE e.id = ? AND e.group_id = ?", (event_id, group_id))
    found = row.fetchone()
    if found is None:
        raise HTTPException(404, "not_found")
    return Event(**dict(found))


@router.get("")
def list_events(
    group_id: int,
    user: CurrentUser,
    conn: Db,
    start: Annotated[str, Query(alias="from")],
    end: Annotated[str, Query(alias="to")],
) -> Events:
    require_member(conn, user, group_id)
    first, last = _range(start, end)
    rows = conn.execute(
        f"{_SELECT} WHERE e.group_id = ? AND e.start_day <= ? AND e.end_day >= ?"
        " ORDER BY e.start_day, e.id",
        (group_id, last.isoformat(), first.isoformat()),
    ).fetchall()
    return Events(events=[Event(**dict(r)) for r in rows])


@router.post("", status_code=201)
def create_event(group_id: int, body: EventCreate, user: CurrentUser, conn: Db) -> Event:
    require_member(conn, user, group_id)
    _check_span(body.start_day, body.end_day)
    t = iso(now())
    cur = conn.execute(
        "INSERT INTO events (group_id, title, start_day, end_day, time_place, note,"
        " created_by, updated_by, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            group_id,
            body.title,
            body.start_day.isoformat(),
            body.end_day.isoformat(),
            body.time_place,
            body.note,
            user.id,
            user.id,
            t,
            t,
        ),
    )
    assert cur.lastrowid is not None
    return _get(conn, group_id, cur.lastrowid)


@router.patch("/{event_id}")
def patch_event(
    group_id: int, event_id: int, body: EventPatch, user: CurrentUser, conn: Db
) -> Event:
    require_member(conn, user, group_id)
    sent = body.model_dump(include=body.model_fields_set)
    with transaction(conn):
        current = _get(conn, group_id, event_id)
        start = body.start_day or days.parse_day(current.start_day)
        end = body.end_day or days.parse_day(current.end_day)
        _check_span(start, end)
        values = {k: v.isoformat() if isinstance(v, date) else v for k, v in sent.items()}
        # Column names come from the model's fields, never from the request.
        sets = "".join(f"{k} = ?, " for k in values)
        conn.execute(
            f"UPDATE events SET {sets}updated_by = ?, updated_at = ? WHERE id = ?",  # noqa: S608
            (*values.values(), user.id, iso(now()), event_id),
        )
    return _get(conn, group_id, event_id)


@router.delete("/{event_id}", status_code=204)
def delete_event(group_id: int, event_id: int, user: CurrentUser, conn: Db) -> None:
    require_member(conn, user, group_id)
    cur = conn.execute("DELETE FROM events WHERE id = ? AND group_id = ?", (event_id, group_id))
    if cur.rowcount == 0:
        raise HTTPException(404, "not_found")
