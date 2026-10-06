"""hub-api calendar module — a date range out of the calendar snapshot.

A sync job you run beside the server keeps the snapshot (HUB_CALENDAR; this repo
does not ship one); this module only reads it. Calendar sources are slow, so the
source is never called from here.

Days are HUB_TZ days throughout: an event late in the local evening belongs to that
evening, not to the UTC day it has already crossed into.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from hub_tz import hub_tz

router = APIRouter()

TZ = hub_tz()
MAX_RANGE_DAYS = 62
DEFAULT_RANGE_DAYS = 7
# The sync's expected cadences. A slice twice overdue is one the sync is failing
# to refresh, not one that is merely waiting its turn.
NEAR_CADENCE = timedelta(minutes=60)
FAR_CADENCE = timedelta(hours=12)

HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
}
FIELDS = ("id", "title", "account", "all_day", "start", "end", "start_date", "end_date",
          "location", "conference_url", "organizer", "attendee_count")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _snapshot_path() -> Path:
    return Path(os.environ.get("HUB_CALENDAR", "/data/hub/calendar.json"))


def _request_path() -> Path:
    return Path(os.environ.get("HUB_CALENDAR_SYNC_REQUEST", "/data/hub/calendar-sync.request"))


def _pending_request() -> str | None:
    """When a sync was asked for, while the host has not yet picked it up. A
    file that cannot be read is still a request: the host job removes it."""
    try:
        body = json.loads(_request_path().read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return "pending"
    at = body.get("requested_at") if isinstance(body, dict) else None
    return at if isinstance(at, str) else "pending"


def _load() -> dict[str, Any] | None:
    try:
        snapshot = json.loads(_snapshot_path().read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("events"), list):
        return None
    return snapshot


def _span(event: Any) -> tuple[date, date, str] | None:
    """(first day, last day, sort key), or None for an event that cannot be placed."""
    try:
        if event["all_day"]:
            first = date.fromisoformat(event["start_date"])
            last = date.fromisoformat(event["end_date"]) - timedelta(days=1)
            return first, max(first, last), ""
        start = datetime.fromisoformat(event["start"]).astimezone(TZ)
        end = datetime.fromisoformat(event["end"]).astimezone(TZ)
    # OverflowError: year 1 and year 9999 are a model's "no date", and neither
    # survives a timezone conversion.
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    # An end at exactly midnight belongs to the day that just finished.
    last = (end - timedelta(microseconds=1)).date() if end > start else start.date()
    return start.date(), last, start.isoformat()


def _stale_slices(slices: Any, now: datetime) -> int:
    if not isinstance(slices, dict):
        return 0
    today = now.astimezone(TZ).date()
    monday = today - timedelta(days=today.weekday())
    near = {monday.isoformat(), (monday + timedelta(weeks=1)).isoformat()}
    stale = 0
    for key, state in slices.items():
        cadence = NEAR_CADENCE if key.split("|")[0] in near else FAR_CADENCE
        try:
            fresh = now - datetime.fromisoformat(state["ok_at"]) <= 2 * cadence
        except (KeyError, TypeError, ValueError):
            fresh = False
        stale += not fresh
    return stale


def _monday(key: Any) -> date | None:
    try:
        monday = date.fromisoformat(str(key).split("|")[0])
    except ValueError:
        return None
    return monday if monday.year < 2100 else None


def _weeks(slices: Any) -> list[dict[str, Any]]:
    """When each account last synced each week, so the app can say how fresh
    the dates ON SCREEN are rather than the freshest of eighteen slices."""
    if not isinstance(slices, dict):
        return []
    weeks: dict[date, dict[str, Any]] = {}
    for key, state in slices.items():
        monday = _monday(key)
        account = str(key).partition("|")[2]
        if monday is None or account not in ("work", "personal"):
            continue
        ok_at = state.get("ok_at") if isinstance(state, dict) else None
        weeks.setdefault(monday, {"monday": monday.isoformat(), "work": None, "personal": None})
        weeks[monday][account] = ok_at if isinstance(ok_at, str) else None
    return [weeks[m] for m in sorted(weeks)]


def _window(weeks: list[dict[str, Any]]) -> dict[str, str] | None:
    synced = [date.fromisoformat(w["monday"]) for w in weeks if w["work"] or w["personal"]]
    if not synced:
        return None
    return {"from": synced[0].isoformat(), "to": (synced[-1] + timedelta(days=6)).isoformat()}


def _unconfirmed(event: Any) -> bool:
    missed = event.get("missed")
    if isinstance(missed, dict) and any(missed.values()):
        return True
    return bool(event.get("misses"))


def _parse_day(value: str) -> date:
    try:
        if len(value) != 10:
            raise ValueError(value)
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad date", headers=HEADERS)


@router.get("/api/calendar")
def calendar(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
) -> JSONResponse:
    now = _now()
    first = _parse_day(from_) if from_ else now.astimezone(TZ).date()
    try:
        last = _parse_day(to) if to else first + timedelta(days=DEFAULT_RANGE_DAYS)
    except OverflowError:
        raise HTTPException(status_code=400, detail="bad range", headers=HEADERS)
    if last < first or (last - first).days > MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail="bad range", headers=HEADERS)

    snapshot = _load()
    if snapshot is None:
        return JSONResponse(
            {"events": [], "synced_at": None, "window": None, "stale_slices": 0, "weeks": [],
             "sync_requested_at": _pending_request()},
            headers=HEADERS)

    placed = []
    for event in snapshot["events"]:
        span = _span(event)
        if span is None or span[0] > last or span[1] < first:
            continue
        day = max(span[0], first)
        placed.append(((day, not event["all_day"], span[2]), event))
    placed.sort(key=lambda pair: pair[0])

    weeks = _weeks(snapshot.get("slices"))
    return JSONResponse({
        "events": [{**{field: event.get(field) for field in FIELDS}, "unconfirmed": _unconfirmed(event)}
                   for _, event in placed],
        "synced_at": snapshot.get("synced_at"),
        "window": _window(weeks),
        "stale_slices": _stale_slices(snapshot.get("slices"), now),
        "weeks": weeks,
        "sync_requested_at": _pending_request(),
    }, headers=HEADERS)


@router.post("/api/calendar/sync")
def request_sync() -> JSONResponse:
    """Ask the host to sync this week and next now. Ungated on purpose: it only
    moves a sync the host would run anyway earlier, and a second request while
    one is pending changes nothing, so it cannot be used to run up the source."""
    pending = _pending_request()
    if pending is not None:
        return JSONResponse({"requested_at": pending, "already": True}, headers=HEADERS)
    at = _now().isoformat()
    path = _request_path()
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({"requested_at": at}))
    os.replace(tmp, path)
    return JSONResponse({"requested_at": at, "already": False}, status_code=202, headers=HEADERS)
