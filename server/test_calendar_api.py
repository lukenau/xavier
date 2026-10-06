"""GET /api/calendar — a date range out of the calendar snapshot a sync job keeps.
The router is mounted on a bare app here, so this file does not depend on which
suite imported `app` first; the last test checks the real app carries it.

Days are HUB_TZ days. The server's default is UTC; these tests pin New York so the
local-day boundary is actually exercised (an event at 23:30 -04:00 is a UTC tomorrow)."""

import json
import pathlib
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import hub_calendar as mod  # noqa: E402

NOW = datetime(2026, 9, 29, 20, 0, tzinfo=timezone.utc)  # Tue 16:00 in New York


def event(event_id, start, end, **over):
    e = {"id": event_id, "title": event_id, "account": "work", "all_day": False,
         "start": start, "end": end, "start_date": None, "end_date": None,
         "location": None, "conference_url": None, "organizer": None,
         "attendee_count": None, "misses": 0, "seen_at": NOW.isoformat()}
    e.update(over)
    return e


def all_day(event_id, start_date, end_date, **over):
    return event(event_id, None, None, all_day=True, start_date=start_date, end_date=end_date, **over)


def snapshot(events, slices=None):
    fresh = {"ok_at": NOW.isoformat(), "tried_at": NOW.isoformat(), "error": None, "returned": 1}
    return {"version": 1, "synced_at": NOW.isoformat(), "events": events,
            "slices": slices if slices is not None else {
                "2026-09-14|work": fresh, "2026-09-28|work": fresh, "2026-11-09|personal": fresh}}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HUB_CALENDAR", str(tmp_path / "calendar.json"))
    monkeypatch.setenv("HUB_CALENDAR_SYNC_REQUEST", str(tmp_path / "calendar-sync.request"))
    monkeypatch.setattr(mod, "_now", lambda: NOW)
    monkeypatch.setattr(mod, "TZ", ZoneInfo("America/New_York"))
    app = FastAPI()
    app.include_router(mod.router)
    c = TestClient(app)
    c.write = lambda snap: (tmp_path / "calendar.json").write_text(json.dumps(snap))
    return c


def ids(response):
    assert response.status_code == 200, response.text
    return [e["id"] for e in response.json()["events"]]


def test_an_event_inside_the_range_is_returned_and_one_after_it_is_not(client):
    client.write(snapshot([
        event("in", "2026-09-29T11:30:00-04:00", "2026-09-29T12:00:00-04:00"),
        event("after", "2026-10-01T09:00:00-04:00", "2026-10-01T10:00:00-04:00"),
        event("before", "2026-09-27T09:00:00-04:00", "2026-09-27T10:00:00-04:00"),
    ]))
    assert ids(client.get("/api/calendar?from=2026-09-28&to=2026-09-30")) == ["in"]


def test_the_range_is_in_new_york_days_not_utc_days(client):
    # 23:30 New York on the 30th is already Oct 1 in UTC.
    client.write(snapshot([event("late", "2026-09-30T23:30:00-04:00", "2026-09-30T23:45:00-04:00")]))
    assert ids(client.get("/api/calendar?from=2026-09-30&to=2026-09-30")) == ["late"]
    assert ids(client.get("/api/calendar?from=2026-10-01&to=2026-10-01")) == []


def test_an_event_written_in_utc_lands_on_its_new_york_day(client):
    client.write(snapshot([event("z", "2026-10-01T03:30:00+00:00", "2026-10-01T03:45:00+00:00")]))
    assert ids(client.get("/api/calendar?from=2026-09-30&to=2026-09-30")) == ["z"]


def test_an_event_running_past_midnight_is_on_both_days(client):
    client.write(snapshot([event("night", "2026-09-29T23:00:00-04:00", "2026-09-30T01:00:00-04:00")]))
    assert ids(client.get("/api/calendar?from=2026-09-29&to=2026-09-29")) == ["night"]
    assert ids(client.get("/api/calendar?from=2026-09-30&to=2026-09-30")) == ["night"]


def test_an_event_ending_exactly_at_midnight_is_not_on_the_next_day(client):
    client.write(snapshot([event("eve", "2026-09-29T22:00:00-04:00", "2026-09-30T00:00:00-04:00")]))
    assert ids(client.get("/api/calendar?from=2026-09-30&to=2026-09-30")) == []


def test_an_all_day_event_covering_the_range_is_returned(client):
    client.write(snapshot([all_day("vacation", "2026-09-26", "2026-10-07")]))
    assert ids(client.get("/api/calendar?from=2026-09-29&to=2026-09-29")) == ["vacation"]


def test_an_all_day_end_date_is_exclusive(client):
    client.write(snapshot([all_day("holiday", "2026-10-01", "2026-10-02")]))
    assert ids(client.get("/api/calendar?from=2026-10-01&to=2026-10-01")) == ["holiday"]
    assert ids(client.get("/api/calendar?from=2026-10-02&to=2026-10-02")) == []


def test_events_come_sorted_by_day_all_day_first_then_by_start(client):
    client.write(snapshot([
        event("b", "2026-09-29T15:00:00-04:00", "2026-09-29T16:00:00-04:00"),
        event("c", "2026-09-30T09:00:00-04:00", "2026-09-30T10:00:00-04:00"),
        all_day("d", "2026-09-30", "2026-10-01"),
        event("a", "2026-09-29T15:30:00+00:00", "2026-09-29T16:00:00+00:00"),
    ]))
    assert ids(client.get("/api/calendar?from=2026-09-29&to=2026-09-30")) == ["a", "b", "d", "c"]


def test_bookkeeping_fields_stay_on_the_server(client):
    client.write(snapshot([event("x", "2026-09-29T11:30:00-04:00", "2026-09-29T12:00:00-04:00",
                                 location="Room 5", attendee_count=3, misses=2)]))
    got = client.get("/api/calendar?from=2026-09-29&to=2026-09-29").json()["events"][0]
    assert set(got) == {"id", "title", "account", "all_day", "start", "end", "start_date",
                        "end_date", "location", "conference_url", "organizer", "attendee_count",
                        "unconfirmed"}
    assert got["location"] == "Room 5" and got["attendee_count"] == 3


def test_without_a_range_it_serves_today_through_a_week_out(client):
    client.write(snapshot([
        event("yesterday", "2026-09-28T09:00:00-04:00", "2026-09-28T10:00:00-04:00"),
        event("today", "2026-09-29T09:00:00-04:00", "2026-09-29T10:00:00-04:00"),
        event("day7", "2026-10-06T09:00:00-04:00", "2026-10-06T10:00:00-04:00"),
        event("day8", "2026-10-07T09:00:00-04:00", "2026-10-07T10:00:00-04:00"),
    ]))
    assert ids(client.get("/api/calendar")) == ["today", "day7"]


@pytest.mark.parametrize("query", [
    "from=2026-13-40&to=2026-09-30",
    "from=2026-09-30&to=yesterday",
    "from=20260930&to=2026-09-30",
    "from=2026-09-30&to=2026-09-29",
    "from=2026-09-01&to=2026-11-03",
])
def test_a_range_that_makes_no_sense_is_refused(client, query):
    client.write(snapshot([]))
    assert client.get(f"/api/calendar?{query}").status_code == 400


def test_sixty_two_days_is_allowed(client):
    client.write(snapshot([]))
    assert client.get("/api/calendar?from=2026-09-01&to=2026-11-01").status_code == 200


def test_no_snapshot_yet_is_an_empty_calendar_that_says_so(client):
    body = client.get("/api/calendar").json()
    assert body == {"events": [], "synced_at": None, "window": None, "stale_slices": 0, "weeks": [],
                    "sync_requested_at": None}


@pytest.mark.parametrize("text", ['{"events": [', "[]", '{"events": "none"}', ""])
def test_a_broken_snapshot_reads_as_no_snapshot(client, tmp_path, text):
    (tmp_path / "calendar.json").write_text(text)
    body = client.get("/api/calendar").json()
    assert body["synced_at"] is None and body["events"] == []


def test_one_malformed_event_does_not_take_the_others_down(client):
    client.write(snapshot([
        {"id": "broken", "title": "x", "all_day": False, "start": "soon", "end": None},
        "not an event",
        event("ok", "2026-09-29T11:30:00-04:00", "2026-09-29T12:00:00-04:00"),
    ]))
    assert ids(client.get("/api/calendar?from=2026-09-29&to=2026-09-29")) == ["ok"]


def test_the_window_is_what_the_snapshot_covers(client):
    client.write(snapshot([]))
    body = client.get("/api/calendar").json()
    assert body["window"] == {"from": "2026-09-14", "to": "2026-11-15"}
    assert body["synced_at"] == NOW.isoformat()


def test_slices_past_twice_their_cadence_are_counted_stale(client):
    def ok(age):
        return {"ok_at": (NOW - age).isoformat(), "tried_at": NOW.isoformat(), "error": None, "returned": 1}
    client.write(snapshot([], slices={
        "2026-09-28|work": ok(timedelta(hours=3)),         # near, limit 2h  → stale
        "2026-09-28|personal": ok(timedelta(minutes=90)),  # near            → fine
        "2026-10-05|work": ok(timedelta(minutes=121)),     # near (next wk)  → stale
        "2026-10-19|work": ok(timedelta(hours=25)),        # far, limit 24h  → stale
        "2026-10-19|personal": ok(timedelta(hours=23)),    # far             → fine
        "2026-10-26|work": {"ok_at": None, "tried_at": NOW.isoformat(), "error": "HTTP 502", "returned": None},
    }))
    assert client.get("/api/calendar").json()["stale_slices"] == 4


def test_the_answer_is_never_cached(client):
    client.write(snapshot([]))
    assert "no-store" in client.get("/api/calendar").headers["cache-control"]


def test_the_real_app_carries_the_route():
    source = (pathlib.Path(__file__).parent / "app.py").read_text()
    assert "from hub_calendar import router as calendar_router" in source
    assert "app.include_router(calendar_router)" in source
    dockerfile = (pathlib.Path(__file__).parent / "Dockerfile").read_text()
    assert "hub_calendar.py" in dockerfile


@pytest.mark.parametrize("start,end", [
    ("0001-01-01T00:00:00+00:00", "0001-01-01T01:00:00+00:00"),
    ("2026-09-29T11:30:00-04:00", "9999-12-31T23:59:59-12:00"),
])
def test_an_event_at_an_impossible_date_is_skipped_not_fatal(client, start, end):
    client.write(snapshot([
        event("zero", start, end),
        event("ok", "2026-09-29T11:30:00-04:00", "2026-09-29T12:00:00-04:00"),
    ]))
    assert ids(client.get("/api/calendar?from=2026-09-29&to=2026-09-29")) == ["ok"]


def test_a_range_off_the_end_of_time_is_refused(client):
    client.write(snapshot([]))
    assert client.get("/api/calendar?from=9999-12-30").status_code == 400


def test_a_slice_at_an_impossible_date_does_not_break_the_window(client):
    fresh = {"ok_at": NOW.isoformat(), "tried_at": NOW.isoformat(), "error": None, "returned": 1}
    client.write(snapshot([], slices={"2026-09-28|work": fresh, "9999-12-31|work": fresh, "junk": fresh}))
    body = client.get("/api/calendar")
    assert body.status_code == 200
    assert body.json()["window"] == {"from": "2026-09-28", "to": "2026-10-04"}


def test_per_week_miss_counts_stay_on_the_server(client):
    client.write(snapshot([event("x", "2026-09-29T11:30:00-04:00", "2026-09-29T12:00:00-04:00",
                                 missed={"2026-09-28": 2})]))
    assert "missed" not in client.get("/api/calendar?from=2026-09-29&to=2026-09-29").json()["events"][0]


# --- what the app needs to say how fresh the dates on screen are -----------------

def test_each_week_reports_when_each_account_last_synced(client):
    ok = {"ok_at": NOW.isoformat(), "tried_at": NOW.isoformat(), "error": None, "returned": 1}
    old = {"ok_at": (NOW - timedelta(hours=5)).isoformat(), "tried_at": NOW.isoformat(), "error": None, "returned": 1}
    never = {"ok_at": None, "tried_at": NOW.isoformat(), "error": "HTTP 502", "returned": None}
    client.write(snapshot([], slices={
        "2026-09-28|work": ok, "2026-09-28|personal": old,
        "2026-10-05|work": never,
    }))
    body = client.get("/api/calendar").json()
    assert body["weeks"] == [
        {"monday": "2026-09-28", "work": NOW.isoformat(), "personal": (NOW - timedelta(hours=5)).isoformat()},
        {"monday": "2026-10-05", "work": None, "personal": None},
    ]


def test_the_window_covers_only_weeks_that_have_synced_at_least_once(client):
    ok = {"ok_at": NOW.isoformat(), "tried_at": NOW.isoformat(), "error": None, "returned": 1}
    never = {"ok_at": None, "tried_at": NOW.isoformat(), "error": "HTTP 502", "returned": None}
    client.write(snapshot([], slices={
        "2026-09-14|work": never, "2026-09-14|personal": never,
        "2026-09-21|work": ok, "2026-09-21|personal": never,
        "2026-09-28|work": ok, "2026-09-28|personal": ok,
        "2026-10-05|work": never,
    }))
    assert client.get("/api/calendar").json()["window"] == {"from": "2026-09-21", "to": "2026-10-04"}


def test_an_event_the_last_sync_did_not_return_is_marked_unconfirmed(client):
    client.write(snapshot([
        event("seen", "2026-09-29T11:30:00-04:00", "2026-09-29T12:00:00-04:00", missed={}),
        event("missed", "2026-09-29T13:00:00-04:00", "2026-09-29T14:00:00-04:00", missed={"2026-09-28": 1}),
        event("legacy", "2026-09-29T15:00:00-04:00", "2026-09-29T16:00:00-04:00", misses=2),
    ]))
    got = client.get("/api/calendar?from=2026-09-29&to=2026-09-29").json()["events"]
    assert [(e["id"], e["unconfirmed"]) for e in got] == [("seen", False), ("missed", True), ("legacy", True)]


def test_no_snapshot_has_no_weeks(client):
    assert client.get("/api/calendar").json()["weeks"] == []


# --- sync now ---------------------------------------------------------------------

@pytest.fixture
def request_file(tmp_path, monkeypatch):
    path = tmp_path / "calendar-sync.request"
    monkeypatch.setenv("HUB_CALENDAR_SYNC_REQUEST", str(path))
    return path


def test_asking_for_a_sync_leaves_a_request_for_the_host(client, request_file):
    r = client.post("/api/calendar/sync")
    assert r.status_code == 202
    assert r.json() == {"requested_at": NOW.isoformat(), "already": False}
    assert json.loads(request_file.read_text()) == {"requested_at": NOW.isoformat()}


def test_asking_again_while_one_is_pending_changes_nothing(client, request_file):
    request_file.write_text(json.dumps({"requested_at": "2026-09-29T19:58:00+00:00"}))
    r = client.post("/api/calendar/sync")
    assert r.status_code == 200
    assert r.json() == {"requested_at": "2026-09-29T19:58:00+00:00", "already": True}
    assert json.loads(request_file.read_text()) == {"requested_at": "2026-09-29T19:58:00+00:00"}


def test_the_calendar_says_when_a_sync_was_asked_for(client, request_file):
    client.write(snapshot([]))
    assert client.get("/api/calendar").json()["sync_requested_at"] is None
    client.post("/api/calendar/sync")
    assert client.get("/api/calendar").json()["sync_requested_at"] == NOW.isoformat()


def test_a_garbled_request_file_still_counts_as_pending(client, request_file):
    request_file.write_text("not json")
    client.write(snapshot([]))
    assert client.get("/api/calendar").json()["sync_requested_at"] == "pending"
    assert client.post("/api/calendar/sync").json()["already"] is True


def test_the_sync_request_is_on_the_post_allowlist():
    source = (pathlib.Path(__file__).parent / "app.py").read_text()
    block = source[source.index("POST_ALLOWLIST_PREFIXES = ("):]
    assert '"/api/calendar/sync"' in block[: block.index(")\n")]
