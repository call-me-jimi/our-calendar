"""Calendar days: "today" in Berlin and the editable window (spec §3.4).

Call these as `days.berlin_today()` (not `from days import ...`), so tests can pin "today"
by monkeypatching `ourcalendar.days.berlin_today`.
"""

import calendar
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")
_DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def berlin_today() -> date:
    return datetime.now(BERLIN).date()


def window_end(today: date) -> date:
    """Last editable day: today + 12 months, clamped to the month's end (Feb 29 -> Feb 28)."""
    year = today.year + 1
    return date(year, today.month, min(today.day, calendar.monthrange(year, today.month)[1]))


def parse_day(value: str) -> date:
    """Strictly 'YYYY-MM-DD' (fromisoformat alone also takes '20260101' and week dates)."""
    if not _DAY.fullmatch(value):
        raise ValueError("invalid day")
    return date.fromisoformat(value)
