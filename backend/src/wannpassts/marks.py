"""Availability marks: read a group's marks, batch-write one user's days (spec §3.4, §3.5, §5)."""

from datetime import date
from typing import Annotated, Literal, Self

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from wannpassts import days
from wannpassts.authz import membership_role, require_group_admin, require_member
from wannpassts.db import transaction
from wannpassts.deps import CurrentUser, Db
from wannpassts.security import iso, now

router = APIRouter(prefix="/api")

MAX_DAYS = 400
NOTE_MAX = 80
State = Literal["busy", "maybe"]


class Mark(BaseModel):
    user_id: int
    day: str
    state: State
    note: str | None
    # Only when someone else set it (a group admin), else null.
    set_by_name: str | None
    # The setter has deleted their account: show "former member" (spec §3.11).
    set_by_former: bool


class Marks(BaseModel):
    marks: list[Mark]


class DayWrite(BaseModel):
    day: date
    state: Literal["busy", "maybe", "free"]
    note: str | None = None

    @field_validator("day", mode="before")
    @classmethod
    def _day(cls, v: object) -> date:
        if not isinstance(v, str):
            raise ValueError("invalid day")
        return days.parse_day(v)

    @model_validator(mode="after")
    def _note(self) -> Self:
        note = self.note.strip() if self.note is not None else None
        # Erasing a day removes its note (spec §3.5), so a note on `free` is ignored.
        self.note = note if note and self.state != "free" else None
        if self.note is not None and len(self.note) > NOTE_MAX:
            raise ValueError("note too long")
        return self


class MarksWrite(BaseModel):
    user_id: int
    group_id: int | None = None
    days: list[DayWrite] = Field(min_length=1, max_length=MAX_DAYS)

    @model_validator(mode="after")
    def _unique(self) -> Self:
        if len({d.day for d in self.days}) != len(self.days):
            raise ValueError("duplicate day")
        return self


class Previous(BaseModel):
    day: str
    state: Literal["busy", "maybe", "free"]
    note: str | None


class MarksWritten(BaseModel):
    # The state before this write, in request order: send it back to undo.
    previous: list[Previous]


def _range(start: str, end: str) -> tuple[date, date]:
    try:
        first, last = days.parse_day(start), days.parse_day(end)
    except ValueError:
        raise HTTPException(422, "invalid_input") from None
    if last < first or (last - first).days + 1 > MAX_DAYS:
        raise HTTPException(422, "invalid_input")
    return first, last


@router.get("/groups/{group_id}/marks")
def get_marks(
    group_id: int,
    user: CurrentUser,
    conn: Db,
    start: Annotated[str, Query(alias="from")],
    end: Annotated[str, Query(alias="to")],
) -> Marks:
    require_member(conn, user, group_id)
    first, last = _range(start, end)
    # Joining memberships keeps out anyone who has left or was removed.
    rows = conn.execute(
        "SELECT d.user_id, d.day, d.state, d.note,"
        " CASE WHEN d.set_by != d.user_id THEN s.display_name END AS set_by_name,"
        " d.set_by IS NULL AS set_by_former"
        " FROM memberships m JOIN day_marks d ON d.user_id = m.user_id"
        " LEFT JOIN users s ON s.id = d.set_by"
        " WHERE m.group_id = ? AND d.day BETWEEN ? AND ?"
        " ORDER BY d.day, d.user_id",
        (group_id, first.isoformat(), last.isoformat()),
    ).fetchall()
    return Marks(marks=[Mark(**dict(r)) for r in rows])


@router.put("/marks")
def put_marks(body: MarksWrite, user: CurrentUser, conn: Db) -> MarksWritten:
    if body.user_id != user.id:
        if body.group_id is None:
            raise HTTPException(403, "forbidden")
        require_group_admin(conn, user, body.group_id)
        if membership_role(conn, body.group_id, body.user_id) is None:
            raise HTTPException(403, "forbidden")

    today = days.berlin_today()
    end = days.window_end(today)
    if any(not today <= d.day <= end for d in body.days):
        raise HTTPException(422, "outside_window")

    t = iso(now())
    requested = [d.day.isoformat() for d in body.days]
    with transaction(conn):
        rows = conn.execute(
            "SELECT day, state, note FROM day_marks WHERE user_id = ? AND day BETWEEN ? AND ?",
            (body.user_id, min(requested), max(requested)),
        ).fetchall()
        before = {r["day"]: r for r in rows}
        for d, day in zip(body.days, requested, strict=True):
            if d.state == "free":
                conn.execute(
                    "DELETE FROM day_marks WHERE user_id = ? AND day = ?", (body.user_id, day)
                )
            else:
                conn.execute(
                    "INSERT INTO day_marks (user_id, day, state, note, set_by, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT (user_id, day) DO UPDATE SET state = excluded.state,"
                    " note = excluded.note, set_by = excluded.set_by,"
                    " updated_at = excluded.updated_at",
                    (body.user_id, day, d.state, d.note, user.id, t),
                )
        conn.execute("UPDATE users SET availability_updated_at = ? WHERE id = ?", (t, body.user_id))
    return MarksWritten(
        previous=[
            Previous(day=day, state=before[day]["state"], note=before[day]["note"])
            if day in before
            else Previous(day=day, state="free", note=None)
            for day in requested
        ]
    )
