"""Personal iCal feed of a group's events (spec §3.10).

The token in the URL is the only credential (no session), one per user per group; only its
hash is stored. Leaving or being removed from the group deletes it (groups.remove_member).
"""

from datetime import date, datetime, timedelta
from urllib.parse import urlsplit

import icalendar
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from ourcalendar import days
from ourcalendar.authz import require_member
from ourcalendar.deps import CurrentUser, Db
from ourcalendar.security import hash_token, iso, new_token, now

router = APIRouter()


class FeedUrl(BaseModel):
    # Shown once: only the hash is stored.
    url: str


class FeedStatus(BaseModel):
    active: bool


@router.post("/api/groups/{group_id}/feed-token")
def create_feed_token(group_id: int, request: Request, user: CurrentUser, conn: Db) -> FeedUrl:
    require_member(conn, user, group_id)
    token = new_token()
    # Replaces the user's previous token for this group, so the old URL stops working.
    conn.execute(
        "INSERT INTO feed_tokens (token_hash, group_id, user_id, created_at) VALUES (?, ?, ?, ?)"
        " ON CONFLICT (group_id, user_id) DO UPDATE SET token_hash = excluded.token_hash,"
        " created_at = excluded.created_at",
        (hash_token(token), group_id, user.id, iso(now())),
    )
    base = request.app.state.settings.base_url
    return FeedUrl(url=f"{base}/feed/{token}.ics")


@router.get("/api/groups/{group_id}/feed-token")
def feed_token_status(group_id: int, user: CurrentUser, conn: Db) -> FeedStatus:
    require_member(conn, user, group_id)
    row = conn.execute(
        "SELECT 1 FROM feed_tokens WHERE group_id = ? AND user_id = ?", (group_id, user.id)
    ).fetchone()
    return FeedStatus(active=row is not None)


def _year_ago(d: date) -> date:
    try:
        return d.replace(year=d.year - 1)
    except ValueError:  # Feb 29
        return d.replace(year=d.year - 1, day=28)


# Not under /api: no session, and calendar apps send no Origin. HEAD for clients that probe.
@router.api_route("/feed/{token}.ics", methods=["GET", "HEAD"], include_in_schema=False)
def feed(token: str, request: Request, conn: Db) -> Response:
    # Also re-checks membership (the instance admin may hold one without being a member),
    # so a token that outlived its membership can't leak events.
    group = conn.execute(
        "SELECT g.id, g.name FROM feed_tokens f"
        " JOIN groups g ON g.id = f.group_id JOIN users u ON u.id = f.user_id"
        " WHERE f.token_hash = ? AND (u.is_instance_admin OR EXISTS ("
        "  SELECT 1 FROM memberships m WHERE m.group_id = f.group_id AND m.user_id = f.user_id))",
        (hash_token(token),),
    ).fetchone()
    if group is None:
        return Response(status_code=404)
    rows = conn.execute(
        "SELECT id, title, start_day, end_day, time_place, note, updated_at FROM events"
        " WHERE group_id = ? AND end_day >= ? ORDER BY start_day, id",
        (group["id"], _year_ago(days.berlin_today()).isoformat()),
    ).fetchall()

    host = urlsplit(request.app.state.settings.base_url).hostname
    cal = icalendar.Calendar()
    cal.add("prodid", "-//Our Calendar//ourcalendar//DE")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add("x-wr-calname", group["name"])
    for r in rows:
        stamp = datetime.fromisoformat(r["updated_at"])
        ev = icalendar.Event()
        ev.add("uid", f"event-{r['id']}@{host}")
        ev.add("dtstamp", stamp)
        ev.add("last-modified", stamp)
        # All-day: VALUE=DATE, and DTEND is the day after the last day (RFC 5545).
        ev.add("dtstart", date.fromisoformat(r["start_day"]))
        ev.add("dtend", date.fromisoformat(r["end_day"]) + timedelta(days=1))
        ev.add("summary", r["title"])
        if r["time_place"]:
            ev.add("location", r["time_place"])
        description = "\n\n".join(t for t in (r["time_place"], r["note"]) if t)
        if description:
            ev.add("description", description)
        cal.add_component(ev)
    return Response(
        cal.to_ical(),
        media_type="text/calendar; charset=utf-8",
        # no-store: the URL is a bearer secret and the content private; shared caches must not
        # keep serving it after a regenerate or leave. Calendar apps poll only every few hours.
        headers={"Cache-Control": "no-store"},
    )
