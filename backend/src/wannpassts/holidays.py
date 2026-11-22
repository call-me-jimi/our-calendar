"""Public and school holidays from OpenHolidays: daily sync and read API (spec §3.8, §3.12, §5).

Rows are upserted and never deleted, so past years stay. A failed sync keeps the old rows and is
recorded in `holiday_syncs` with ok=0.
"""

import asyncio
import json
import logging
import sqlite3
from collections.abc import Iterable
from dataclasses import astuple, dataclass
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from wannpassts import days
from wannpassts.authz import require_instance_admin
from wannpassts.db import connect, transaction
from wannpassts.deps import CurrentUser, Db
from wannpassts.marks import _range
from wannpassts.security import iso, now

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

API = "https://openholidaysapi.org"
ENDPOINTS = {"public": "/PublicHolidays", "school": "/SchoolHolidays"}
REGIONS = ("DE-BE", "DE-BB")
YEARS_AHEAD = 2
SYNC_HOUR = 4
TIMEOUT = 30.0

Kind = Literal["public", "school"]
Subdivision = Literal["DE", "DE-BE", "DE-BB"]


@dataclass(frozen=True)
class Row:
    kind: str
    subdivision: str
    start_day: str
    end_day: str
    name_de: str
    name_en: str
    source_id: str


def to_row(kind: str, subdivision: str, item: dict[str, Any]) -> Row:
    """One API holiday as a row; nationwide ones are stored once, as 'DE'."""
    names = {str(n["language"]).upper(): str(n["text"]) for n in item["name"]}
    name_de = names.get("DE") or names.get("EN")
    name_en = names.get("EN") or name_de
    if not name_de or not name_en:
        raise ValueError(f"holiday without a name: {item.get('id')}")
    return Row(
        kind=kind,
        subdivision="DE" if item.get("nationwide") is True else subdivision,
        start_day=days.parse_day(str(item["startDate"])).isoformat(),
        end_day=days.parse_day(str(item["endDate"])).isoformat(),
        name_de=name_de,
        name_en=name_en,
        source_id=str(item["id"]),
    )


def fetch(client: httpx.Client, years: Iterable[int]) -> list[Row]:
    """All holidays of both regions for `years`; raises on any API or data problem."""
    rows: list[Row] = []
    for year in years:
        for kind, path in ENDPOINTS.items():
            for region in REGIONS:
                # No languageIsoCode: the API then returns every language it has.
                r = client.get(
                    path,
                    params={
                        "countryIsoCode": "DE",
                        "subdivisionCode": region,
                        "validFrom": f"{year}-01-01",
                        "validTo": f"{year}-12-31",
                    },
                )
                r.raise_for_status()
                items = r.json()
                if not isinstance(items, list):
                    raise ValueError(f"{path} {region} {year}: expected a list")
                rows.extend(to_row(kind, region, item) for item in items)
    return rows


def sync(db_path: Path, transport: httpx.BaseTransport | None = None) -> tuple[bool, str]:
    """Fetch the current year and the next two, upsert them and record the run. Never raises
    for API, network or data errors."""
    conn = connect(db_path)
    try:
        sync_id = conn.execute(
            "INSERT INTO holiday_syncs (started_at) VALUES (?)", (iso(now()),)
        ).lastrowid
        year = days.berlin_today().year
        try:
            with httpx.Client(
                base_url=API,
                transport=transport,
                timeout=TIMEOUT,
                headers={"Accept": "application/json"},
            ) as client:
                rows = fetch(client, range(year, year + YEARS_AHEAD + 1))
            with transaction(conn):
                conn.executemany(
                    "INSERT INTO holidays"
                    " (kind, subdivision, start_day, end_day, name_de, name_en, source_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT (kind, subdivision, start_day, name_de) DO UPDATE SET"
                    " end_day = excluded.end_day, name_en = excluded.name_en,"
                    " source_id = excluded.source_id",
                    [astuple(r) for r in rows],
                )
            ok, message = True, f"{len(rows)} holidays for {year}-{year + YEARS_AHEAD}"
        except Exception as e:
            ok, message = False, f"{type(e).__name__}: {e}"[:500]
            log.warning("holiday sync failed, keeping old data: %s", message)
        conn.execute(
            "UPDATE holiday_syncs SET finished_at = ?, ok = ?, message = ? WHERE id = ?",
            (iso(now()), int(ok), message, sync_id),
        )
    finally:
        conn.close()
    if ok:
        log.info("holiday sync: %s", message)
    return ok, message


def next_run(after: datetime) -> datetime:
    """The first 04:00 Europe/Berlin strictly after `after` (aware), in UTC."""
    local = after.astimezone(days.BERLIN)
    at = datetime.combine(local.date(), time(SYNC_HOUR), days.BERLIN)
    if at <= local:
        at = datetime.combine(local.date() + timedelta(days=1), time(SYNC_HOUR), days.BERLIN)
    return at.astimezone(UTC)


async def run_daily(db_path: Path) -> None:
    """Sync now, then every day at 04:00 Berlin, until cancelled (started from the app lifespan)."""
    while True:
        try:
            await asyncio.to_thread(sync, db_path)
        except Exception:
            log.exception("holiday sync crashed")
        t = now()
        await asyncio.sleep((next_run(t) - t).total_seconds())


class Holiday(BaseModel):
    kind: Kind
    subdivision: Subdivision
    start_day: str
    end_day: str
    name_de: str
    name_en: str


class Holidays(BaseModel):
    holidays: list[Holiday]


class SyncRun(BaseModel):
    started_at: str
    finished_at: str | None
    ok: bool
    message: str | None


class AdminStatus(BaseModel):
    last_sync: SyncRun | None
    last_success: SyncRun | None


@router.get("/holidays")
def get_holidays(
    user: CurrentUser,
    conn: Db,
    start: Annotated[str, Query(alias="from")],
    end: Annotated[str, Query(alias="to")],
    regions: str = "",
) -> Holidays:
    first, last = _range(start, end)
    wanted = {r.strip() for r in regions.split(",") if r.strip()}
    if not wanted <= set(REGIONS):
        raise HTTPException(422, "invalid_input")
    if not wanted:
        return Holidays(holidays=[])
    rows = conn.execute(
        "SELECT kind, subdivision, start_day, end_day, name_de, name_en FROM holidays"
        " WHERE start_day <= ? AND end_day >= ?"
        " AND (subdivision IN (SELECT value FROM json_each(?))"
        " OR (subdivision = 'DE' AND kind = 'public'))"
        " ORDER BY start_day, kind, subdivision, name_de",
        (last.isoformat(), first.isoformat(), json.dumps(sorted(wanted))),
    ).fetchall()
    return Holidays(holidays=[Holiday(**dict(r)) for r in rows])


def _last_sync(conn: sqlite3.Connection, *, ok_only: bool) -> SyncRun | None:
    row = conn.execute(
        "SELECT started_at, finished_at, ok, message FROM holiday_syncs"
        " WHERE ok >= ? ORDER BY id DESC LIMIT 1",
        (int(ok_only),),
    ).fetchone()
    return SyncRun(**dict(row)) if row else None


@router.get("/admin/status")
def admin_status(user: CurrentUser, conn: Db) -> AdminStatus:
    require_instance_admin(user)
    return AdminStatus(
        last_sync=_last_sync(conn, ok_only=False), last_success=_last_sync(conn, ok_only=True)
    )
