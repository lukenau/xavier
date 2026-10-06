"""Automations: runs grouped by the job that produced them.

    python3 -m pytest test_chat_automations.py -q

Own process, like every chat test file here (requirements-dev.txt).
"""
from __future__ import annotations

import os
import pathlib
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_CHAT_DB"] = str(TMP / "chat" / "chat.db")
os.environ["HUB_CHAT_MEDIA_DIR"] = str(TMP / "chat" / "media")
os.environ["HUB_PLATFORM_KEY_FILE"] = str(TMP / "hub-platform-key")
os.environ["HUB_PUSH_TOKENS"] = str(TMP / "push_tokens.json")
# Keep the credential stores hermetic: the gate's no-passkey/no-devicekey branch reads
# them, and this file deliberately enrols neither.
os.environ["HUB_PASSKEYS"] = str(TMP / "passkeys.json")
os.environ["HUB_DEVICEKEYS"] = str(TMP / "devicekeys.json")
(TMP / "hub-platform-key").write_text("test-platform-secret\n")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
import chat.platform as platform  # noqa: E402
from chat import automation_store as autos_mod  # noqa: E402
from chat.automation_store import (  # noqa: E402
    AutomationStore,
    category_for,
    followup_thread_id,
    preview_of,
    severity_of,
)
from chat.store import ChatStore  # noqa: E402

client = TestClient(app)
KEY = {"Authorization": "Bearer test-platform-secret"}
COOKIE = {"hub_chat_session": "x"}

OPS = "c0ffee000001"
CREDIT = "10a7ed1218e8"
CANDLE = "c0ffee000002"


def at(hours_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(job_id: str, stem: str, hours_ago: float, output: str = "", status: str = "ok", **extra) -> dict:
    return {
        "run_id": f"{job_id}:{stem}", "job_id": job_id, "run_time": at(hours_ago),
        "status": status, "output": output, **extra,
    }


JOBS = [
    {"id": OPS, "name": "ops-watch", "schedule": "0 21 * * *", "mode": "script",
     "deliver": "discord:100000000000000001,hub:ops", "state": "active"},
    {"id": CREDIT, "name": "credit-watch", "schedule": "0 9 * * *", "mode": "script",
     "deliver": "discord:100000000000000001,hub:ops", "state": "active"},
    {"id": CANDLE, "name": "Porch Light ON (2 PM)", "schedule": "0 14 * * *", "mode": "script",
     "deliver": "local", "state": "active"},
]


@pytest.fixture()
def autos(tmp_path) -> AutomationStore:
    store = ChatStore(tmp_path / "chat.db", tmp_path / "media")
    a = AutomationStore(store)
    a.upsert_jobs(JOBS, complete=True)
    return a


@pytest.fixture()
def unlocked(monkeypatch, tmp_path):
    """Fresh store behind the live app, with the cookie gate open."""
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    monkeypatch.setattr(platform, "_store", ChatStore(tmp_path / "chat.db", tmp_path / "media"))
    sync(jobs=JOBS, jobs_complete=True)


def sync(**body) -> dict:
    r = client.post("/api/platform/hub/automations/sync", json=body, headers=KEY)
    assert r.status_code == 200, r.text
    return r.json()


def jobs_by_name() -> dict[str, dict]:
    r = client.get("/api/chat/automations", cookies=COOKIE)
    assert r.status_code == 200, r.text
    return {j["name"]: j for j in r.json()["jobs"]}


# --- what a run says -----------------------------------------------------------------
def test_category_comes_from_where_the_job_delivers():
    assert category_for("discord:100000000000000005,hub:money") == "money"
    assert category_for("discord:100000000000000002,hub:brief") == "personal"
    assert category_for("hub:cron") == "ops"
    assert category_for("discord:100000000000000001") == "ops"
    assert category_for("local") == "background"
    assert category_for("origin") == "personal"
    assert category_for(None) == "background"


def test_severity_is_read_from_the_mark_the_job_already_prints():
    assert severity_of("ok", "\U0001F6A8 credit-watch: OpenRouter balance $9.97 left") == "alert"
    assert severity_of("ok", "⚠️ ops-watch:\n• backup stale") == "warn"
    assert severity_of("ok", "**Amazon order update**") == "info"
    assert severity_of("failed", "Script exited with code 28") == "failed"


def test_preview_drops_a_first_line_that_only_names_the_job():
    out = "⚠️ ops-watch:\n• backup stale — last snapshot 136h ago\n• state volume 94% full"
    assert preview_of(out) == "backup stale — last snapshot 136h ago · state volume 94% full"
    assert preview_of("**Amazon order update**\n- Cocofloss · Arriving today") == "Cocofloss · Arriving today"
    assert preview_of("\U0001F6A8 credit-watch: OpenRouter balance $9.97 left") == (
        "credit-watch: OpenRouter balance $9.97 left"
    )


def test_a_card_shows_its_lines_one_per_line():
    from chat.automation_store import preview_lines
    out = "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 last snapshot 160h ago\n\u2022 state volume 94% full\n\u2022 briefing page missing\n\u2022 a source is erroring"
    assert preview_lines(out) == ["backup stale \u2014 last snapshot 160h ago", "state volume 94% full", "briefing page missing"]
    assert preview_lines("x" * 200)[0].endswith("\u2026")


# --- grouping -------------------------------------------------------------------------
def test_every_run_lands_under_the_job_its_id_names(autos):
    autos.upsert_runs([
        run(OPS, "2026-09-28_21-00-20", 20, "⚠️ ops-watch:\n• backup stale"),
        run(CREDIT, "2026-09-29_09-00-11", 8, "\U0001F6A8 credit-watch: balance $9.97 left"),
        run(CANDLE, "2026-09-29_14-00-02", 3, "turned on"),
    ])
    jobs = {j["name"]: j for j in autos.list_jobs()["jobs"]}
    assert jobs["ops-watch"]["latest"]["run_id"] == f"{OPS}:2026-09-28_21-00-20"
    assert jobs["credit-watch"]["latest"]["run_id"] == f"{CREDIT}:2026-09-29_09-00-11"
    assert [i["run"]["job_id"] for i in autos.job_items(OPS)] == [OPS]
    assert [i["run"]["job_id"] for i in autos.job_items(CREDIT)] == [CREDIT]


def test_sections_needs_you_new_earlier_quiet(autos):
    autos.upsert_runs([
        run(OPS, "a", 20, "⚠️ ops-watch:\n• backup stale"),
        run(CREDIT, "a", 8, "balance fine, $40 left"),
        run(CANDLE, "a", 3, "turned on"),
    ])
    jobs = {j["name"]: j for j in autos.list_jobs()["jobs"]}
    assert jobs["ops-watch"]["section"] == "needs_you"
    assert jobs["credit-watch"]["section"] == "new"
    # A job that only writes `local` is addressed to nobody: folded, never unread.
    assert jobs["Porch Light ON (2 PM)"]["section"] == "quiet"
    assert jobs["Porch Light ON (2 PM)"]["unread"] == 0

    autos.mark_read(CREDIT)
    autos.mark_read(OPS)
    jobs = {j["name"]: j for j in autos.list_jobs()["jobs"]}
    assert jobs["credit-watch"]["section"] == "earlier"
    assert jobs["ops-watch"]["section"] == "earlier"
    assert autos.list_jobs()["counts"] == {"needs_you": 0, "unread": 0, "jobs": 3}


def test_a_failed_background_run_still_needs_you(autos):
    autos.upsert_runs([run(CANDLE, "a", 3, "Script exited with code 28", status="failed")])
    job = autos.job_summary(CANDLE)
    assert job["section"] == "needs_you"
    assert job["latest"]["severity"] == "failed"


def test_a_repeat_with_only_the_numbers_changed_is_unchanged(autos):
    autos.upsert_runs([
        run(OPS, "d1", 72, "⚠️ ops-watch:\n• backup stale — last snapshot 88h ago"),
        run(OPS, "d2", 48, "⚠️ ops-watch:\n• backup stale — last snapshot 112h ago"),
        run(OPS, "d3", 24, "⚠️ ops-watch:\n• backup stale — last snapshot 136h ago"),
    ])
    latest = autos.job_summary(OPS)["latest"]
    assert latest["unchanged"] is True
    assert latest["streak"] == 3
    assert autos.job_summary(OPS)["unread"] == 1  # one finding, however many times it was said


def test_a_new_line_is_counted_and_breaks_the_streak(autos):
    autos.upsert_runs([
        run(OPS, "d1", 48, "⚠️ ops-watch:\n• backup stale — 112h"),
        run(OPS, "d2", 24, "⚠️ ops-watch:\n• backup stale — 136h\n• state volume 94% full"),
    ])
    latest = autos.job_summary(OPS)["latest"]
    assert latest["unchanged"] is False
    assert latest["new_lines"] == 1
    assert latest["items"] == 2
    assert latest["streak"] == 1


def test_an_alert_already_opened_stays_opened_while_it_repeats(autos):
    autos.upsert_runs([run(OPS, "d1", 48, "⚠️ ops-watch:\n• backup stale — 112h")])
    autos.mark_read(OPS)
    autos.upsert_runs([run(OPS, "d2", 24, "⚠️ ops-watch:\n• backup stale — 136h")])
    job = autos.job_summary(OPS)
    assert job["needs_you"] is False
    assert job["unread"] == 0
    assert job["latest"]["streak"] == 2


def test_a_finding_that_went_away_for_days_and_came_back_is_news(autos):
    autos.upsert_runs([run(OPS, "d1", 120, "⚠️ ops-watch:\n• backup stale")])
    autos.mark_read(OPS)
    autos.upsert_runs([
        run(OPS, "d2", 96, "", status="silent"),
        run(OPS, "d3", 72, "", status="silent"),
        run(OPS, "d4", 24, "⚠️ ops-watch:\n• backup stale"),
    ])
    job = autos.job_summary(OPS)
    assert job["latest"]["unchanged"] is False
    assert job["needs_you"] is True


def test_a_morning_report_with_quiet_afternoons_is_the_same_report_next_morning(autos):
    autos.upsert_runs([
        run(OPS, "m1", 30, "Finance: 2 new alert(s)\n• Copilot MCP source down"),
        run(OPS, "a1", 25, "", status="silent"),
        run(OPS, "e1", 20, "", status="silent"),
        run(OPS, "m2", 6, "Finance: 2 new alert(s)\n• Copilot MCP source down"),
    ])
    latest = autos.job_summary(OPS)["latest"]
    assert (latest["unchanged"], latest["streak"]) == (True, 2)


def test_only_what_the_clock_moves_is_masked(autos):
    from chat.automation_store import normalized_lines
    same = normalized_lines("backup stale — last snapshot 112h ago · paused since 2026-09-21 (7.1d) · missed its 2026-09-29T09:15:00+00:00 run at 9:15 AM")
    assert same == normalized_lines("backup stale — last snapshot 136h ago · paused since 2026-09-22 (8.3d) · missed its 2026-09-30T09:15:00+00:00 run at 10:40 PM")
    assert normalized_lines("balance $9.97 left") != normalized_lines("balance $0.82 left")
    assert normalized_lines("state volume 93% full") != normalized_lines("state volume 94% full")


def test_a_failure_the_next_run_recovered_from_no_longer_needs_you(autos):
    autos.upsert_runs([run(CANDLE, "f", 30, "Script exited with code 28", status="failed")])
    assert autos.job_summary(CANDLE)["needs_you"] is True
    autos.upsert_runs([run(CANDLE, "ok", 3, "", status="silent")])
    job = autos.job_summary(CANDLE)
    assert (job["needs_you"], job["standing"], job["latest"]["severity"]) == (False, False, "failed")
    autos.upsert_runs([run(OPS, "w", 30, "⚠️ ops-watch:\n• backup stale"), run(OPS, "q", 3, "", status="silent")])
    assert autos.job_summary(OPS)["needs_you"] is False


def test_a_snooze_covers_the_finding_not_the_job(autos):
    autos.upsert_runs([run(OPS, "d1", 30, "⚠️ ops-watch:\n• backup stale — 88h")])
    autos.set_prefs(OPS, snooze_hours=48)
    autos.upsert_runs([run(OPS, "d2", 6, "⚠️ ops-watch:\n• backup stale — 112h")])
    assert autos.job_summary(OPS)["needs_you"] is False
    assert autos.should_push(autos.get_run(f"{OPS}:d2")) is False
    autos.upsert_runs([run(OPS, "d3", -0.01, "⚠️ ops-watch:\n• backup stale — 117h\n• disk 99% full")])
    job = autos.job_summary(OPS)
    assert (job["needs_you"], job["latest"]["new_lines"]) == (True, 1)
    assert autos.should_push(autos.get_run(f"{OPS}:d3")) is True


def test_read_all_clears_new_but_not_a_standing_alert(autos):
    autos.upsert_runs([
        run(OPS, "a", 2, "⚠️ ops-watch:\n• backup stale"),
        run(CREDIT, "a", 2, "balance fine, $40 left"),
    ])
    assert autos.mark_all_read() == 2
    jobs = {j["name"]: j for j in autos.list_jobs()["jobs"]}
    assert jobs["ops-watch"]["needs_you"] is True
    assert jobs["credit-watch"]["section"] == "earlier"


def test_only_a_job_still_scheduled_can_need_you(autos):
    autos.upsert_jobs([{**JOBS[0], "state": "paused"}], complete=False)
    autos.upsert_runs([run(OPS, "a", 2, "Script exited with code 28", status="failed")])
    job = autos.job_summary(OPS)
    assert (job["needs_you"], job["section"]) == (False, "new")


def test_an_ended_job_with_nothing_unread_is_quiet(autos):
    autos.upsert_runs([run("bbcef96bc846", "a", 900, "remember the funnel", job_name="funnel-reminder")])
    assert autos.job_summary("bbcef96bc846")["section"] == "new"
    autos.mark_read("bbcef96bc846")
    assert autos.job_summary("bbcef96bc846")["section"] == "quiet"


def test_baseline_reads_history_and_keeps_what_is_still_standing(autos):
    autos.upsert_runs([
        run(OPS, "d1", 96, "\u26A0\uFE0F ops-watch:\n\u2022 briefing page missing"),
        run(OPS, "d2", 72, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 88h"),
        run(OPS, "d3", 48, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 112h"),
        run(OPS, "d4", 24, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 136h"),
        run(CREDIT, "d1", 30, "balance fine"),
        run(CREDIT, "d2", 6, "balance still fine, $40"),
        run(CANDLE, "d1", 3, "turned on"),
    ])
    assert autos.list_jobs()["counts"]["unread"] > 2
    assert autos.baseline() == {"read": 2, "standing": 1}
    jobs = {j["name"]: j for j in autos.list_jobs()["jobs"]}
    # One standing finding, counted once however many runs have repeated it.
    assert (jobs["ops-watch"]["section"], jobs["ops-watch"]["unread"]) == ("needs_you", 1)
    assert jobs["ops-watch"]["latest"]["streak"] == 3
    assert jobs["credit-watch"]["section"] == "earlier"
    assert autos.list_jobs()["counts"] == {"needs_you": 1, "unread": 1, "jobs": 3}


def test_a_preview_carries_no_markup():
    assert preview_of("<b>Proposed:</b> Ava staying Mon through Wed") == "Proposed: Ava staying Mon through Wed"
    assert preview_of("balance < $10 and > $5") == "balance < $10 and > $5"


def test_snooze_and_mute_take_a_job_out_of_needs_you(autos):
    autos.upsert_runs([run(OPS, "a", 2, "⚠️ ops-watch:\n• backup stale")])
    assert autos.set_prefs(OPS, snooze_hours=24)["needs_you"] is False
    assert autos.set_prefs(OPS, clear_snooze=True)["needs_you"] is True
    muted = autos.set_prefs(OPS, notify="muted")
    assert (muted["needs_you"], muted["section"], muted["unread"]) == (False, "quiet", 0)


def test_history_folds_silent_and_repeated_runs(autos):
    autos.upsert_runs([
        run(OPS, "r1", 200, "", status="silent"),
        run(OPS, "r2", 180, "", status="silent"),
        run(OPS, "r3", 160, "⚠️ ops-watch:\n• backup stale 10h"),
        run(OPS, "r4", 140, "⚠️ ops-watch:\n• backup stale 34h"),
        run(OPS, "r5", 120, "⚠️ ops-watch:\n• backup stale 58h"),
        run(OPS, "r6", 100, "⚠️ ops-watch:\n• backup stale 82h"),
    ])
    items = autos.job_items(OPS)
    shape = [(i["kind"], i.get("span"), i.get("count")) for i in items]
    # Newest run is always a row, even when it repeats; the repeats under it fold.
    assert shape == [("run", None, None), ("span", "unchanged", 2), ("run", None, None), ("span", "silent", 2)]
    assert items[0]["run"]["run_id"] == f"{OPS}:r6"
    assert items[2]["run"]["run_id"] == f"{OPS}:r3"


def test_the_run_file_replaces_the_delivery_that_beat_it(autos):
    run_id = f"{OPS}:2026-09-28_21-00-20"
    autos.record_delivery(job_id=OPS, run_id=run_id, text="⚠️ ops-watch:\n• backup stale")
    assert autos.get_run(run_id)["source"] == "delivery"
    autos.upsert_runs([run(OPS, "2026-09-28_21-00-20", 5, "⚠️ ops-watch:\n• backup stale")])
    stored = autos.get_run(run_id)
    assert stored["source"] == "file"
    # ...and a late delivery never overwrites the file.
    autos.record_delivery(job_id=OPS, run_id=run_id, text="something else")
    assert autos.get_run(run_id)["output"].endswith("backup stale")
    assert len(autos.job_items(OPS)) == 1


def test_the_skills_curator_is_a_job_that_stays_active_through_a_schedule_sync(autos):
    autos.record_delivery(job_id="skills-curator", run_id="skills-curator:d1", text="💾 Self-improvement review: Skill 'x' patched.")
    autos.upsert_jobs(JOBS, complete=True)
    jobs = {j["name"]: j for j in autos.list_jobs()["jobs"]}
    assert jobs["Skills curator"]["state"] == "active"
    assert jobs["Skills curator"]["last_run"] is not None


def test_a_job_the_schedule_dropped_keeps_its_runs(autos):
    autos.upsert_runs([run("bbcef96bc846", "a", 5, "remember the funnel", job_name="tailscale-funnel-reminder")])
    autos.upsert_jobs(JOBS, complete=True)
    jobs = {j["name"]: j for j in autos.list_jobs()["jobs"]}
    assert jobs["tailscale-funnel-reminder"]["state"] == "removed"
    autos.upsert_jobs(JOBS[:2], complete=True)
    # Removed with nothing to show: gone from the list.
    assert "Porch Light ON (2 PM)" not in {j["name"] for j in autos.list_jobs()["jobs"]}


def test_timeline_is_by_day_with_quiet_runs_counted(autos):
    # Fixed local-noon times, not hours-ago-from-now: two "silent" runs 1h and 1.5h
    # back straddle midnight when this runs between 00:00 and 01:30 local, split
    # across two days and fail the same-day count below.
    from chat.automation_store import HUB_TZ

    noon = datetime.now(HUB_TZ).replace(hour=12, minute=0, second=0, microsecond=0)

    def ts(dt: datetime) -> str:
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    autos.upsert_runs([
        run(OPS, "a", 0, "⚠️ ops-watch:\n• backup stale", run_time=ts(noon)),
        run(CREDIT, "a", 0, "", status="silent", run_time=ts(noon - timedelta(hours=2))),
        run(CREDIT, "b", 0, "", status="silent", run_time=ts(noon - timedelta(hours=1, minutes=30))),
        run(CANDLE, "a", 0, "turned on", run_time=ts(noon - timedelta(hours=1))),
    ])
    days = autos.timeline(days=3)["days"]
    runs = [r["job_name"] for d in days for r in d["runs"]]
    quiet = {q["name"]: (q["count"], q["silent"]) for d in days for q in d["quiet"]}
    assert runs == ["ops-watch"]
    assert quiet == {"credit-watch": (2, 2), "Porch Light ON (2 PM)": (1, 0)}


def test_a_long_streak_stays_acknowledged(autos):
    rows = [run(OPS, f"r{n:04d}", 400 - n * 0.25, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale") for n in range(260)]
    for i in range(0, len(rows), 40):
        autos.upsert_runs(rows[i:i + 40])
    autos.mark_read(OPS)
    more = [run(OPS, f"s{n:04d}", 334 - n * 0.25, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale") for n in range(60)]
    autos.upsert_runs(more[:40])
    autos.upsert_runs(more[40:])
    latest = autos.job_summary(OPS)["latest"]
    assert latest["streak"] == 320
    assert latest["since"] == rows[0]["run_time"]


def test_a_standing_alert_reminds_once_after_three_days(autos):
    autos.upsert_runs([run(OPS, "d0", 100, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 40h")])
    autos.mark_read(OPS)
    autos.upsert_runs([run(OPS, "d1", 76, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 64h")])
    assert autos.job_summary(OPS)["needs_you"] is False
    assert autos.should_push(autos.get_run(f"{OPS}:d1")) is False
    autos.upsert_runs([run(OPS, "d4", 20, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 136h")])
    assert autos.job_summary(OPS)["needs_you"] is True
    assert autos.should_push(autos.get_run(f"{OPS}:d4")) is True
    autos.upsert_runs([run(OPS, "d5", 2, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 160h")])
    assert autos.should_push(autos.get_run(f"{OPS}:d5")) is False


def test_baseline_twice_does_not_re_raise_what_he_read(autos):
    autos.upsert_runs([
        run(OPS, "d1", 48, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale 88h"),
        run(OPS, "d2", 24, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale 112h"),
    ])
    autos.baseline()
    autos.mark_read(OPS)
    autos.baseline()
    assert autos.job_summary(OPS)["needs_you"] is False


def test_a_bad_batch_lands_nothing(autos):
    import pytest as _pytest
    good = run(CREDIT, "ok", 2, "balance fine")
    bad = {**run(CREDIT, "bad", 1, "x"), "run_time": "garbage"}
    with _pytest.raises(ValueError):
        autos.upsert_runs([good, bad])
    assert autos.get_run(f"{CREDIT}:ok") is None
    autos.upsert_runs([good])
    assert autos.job_summary(CREDIT)["latest"]["preview"] == "balance fine"


# --- routes ---------------------------------------------------------------------------
def test_reads_are_behind_the_chat_cookie():
    # No cookie, and this file enrols no passkey/device key — so the gate's honest
    # answer is 412 no_passkey ("enrol first"), not the old blanket 401 that told a
    # fresh install to unlock with a credential it did not have (task t_602da9c5).
    r = client.get("/api/chat/automations")
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_passkey"
    r = client.post("/api/chat/automations/read-all", json={})
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_passkey"


def test_sync_needs_the_platform_key():
    assert client.post("/api/platform/hub/automations/sync", json={}).status_code == 401


def test_sync_rejects_a_run_filed_under_the_wrong_job(unlocked):
    body = {"runs": [{"run_id": f"{OPS}:a", "job_id": CREDIT, "run_time": at(1), "output": "x"}]}
    r = client.post("/api/platform/hub/automations/sync", json=body, headers=KEY)
    assert r.status_code == 422


def test_a_job_delivery_is_filed_under_its_job_not_the_channel(unlocked):
    run_id = f"{OPS}:2026-09-28_21-00-20"
    r = client.post("/api/platform/hub/deliver", headers=KEY, json={
        "thread_id": "ops", "kind": "ops", "job_id": OPS, "job_run_id": run_id,
        "parts": [{"type": "text", "text": "⚠️ ops-watch:\n• backup stale"}],
    })
    assert r.status_code == 200, r.text
    assert r.json()["run_id"] == run_id
    # Nothing in the chat list: not the catch-all channel, not the per-job thread.
    threads = client.get("/api/chat/threads", cookies=COOKIE).json()["threads"]
    assert threads == []
    job = jobs_by_name()["ops-watch"]
    assert job["latest"]["run_id"] == run_id
    assert job["needs_you"] is True
    # The scheduler sending it twice is one row.
    again = client.post("/api/platform/hub/deliver", headers=KEY, json={
        "thread_id": "ops", "kind": "ops", "job_id": OPS, "job_run_id": run_id,
        "parts": [{"type": "text", "text": "⚠️ ops-watch:\n• backup stale"}],
    })
    assert again.json()["deduped"] is True


def test_a_runs_attachment_is_kept_beside_its_text(unlocked):
    run_id = f"{OPS}:2026-09-28_21-00-20"
    for parts in (
        [{"type": "text", "text": "\u26A0\uFE0F ops-watch:\n\u2022 backup stale"}],
        [{"type": "file", "name": "report.csv", "path": "/tmp/x.csv"}, {"type": "text", "text": "Saved on the gateway"}],
    ):
        r = client.post("/api/platform/hub/deliver", headers=KEY,
                        json={"thread_id": "ops", "job_id": OPS, "job_run_id": run_id, "parts": parts})
        assert r.json()["deduped"] is False, r.text
    body = client.post(f"/api/chat/automations/runs/{run_id}/open", json={}, cookies=COOKIE).json()
    assert [p["type"] for p in body["run"]["parts"]] == ["text", "file"]
    assert body["run"]["preview"] == "backup stale"


def test_sync_refuses_a_bad_time_and_cleans_bad_text(unlocked):
    bad = {"runs": [{"run_id": f"{OPS}:a", "job_id": OPS, "run_time": "yesterday", "output": "x"}]}
    assert client.post("/api/platform/hub/automations/sync", json=bad, headers=KEY).status_code == 422
    import json as _json
    # The plugin sends json.dumps output: ASCII, with the surrogate escaped.
    body = _json.dumps({"runs": [run(OPS, "b", 1, "ok \ud800 fine")]})
    r = client.post("/api/platform/hub/automations/sync", content=body,
                    headers={**KEY, "Content-Type": "application/json"})
    assert r.status_code == 200, r.text
    assert "fine" in client.get(f"/api/chat/automations/jobs/{OPS}", cookies=COOKIE).json()["items"][0]["run"]["preview"]


def test_a_job_made_in_a_chat_does_not_post_back_into_that_chat(unlocked):
    chat = client.post("/api/chat/threads", json={"title": "amex"}, cookies=COOKIE).json()["thread"]
    sync(jobs=[{"id": "032f5faf3581", "name": "amex-payment-watch", "deliver": "origin",
                "origin": {"platform": "hub", "chat_id": chat["id"]}}])
    client.post("/api/platform/hub/deliver", headers=KEY, json={
        "thread_id": chat["id"], "job_id": "032f5faf3581", "job_run_id": "032f5faf3581:a",
        "parts": [{"type": "text", "text": "No payment posted yet."}],
    })
    detail = client.get(f"/api/chat/threads/{chat['id']}", cookies=COOKIE).json()
    assert detail["messages"] == []
    job = jobs_by_name()["amex-payment-watch"]
    assert job["category"] == "personal"
    assert job["origin_thread"] == {"id": chat["id"], "title": "amex"}
    assert job["latest"]["preview"] == "No payment posted yet."


def test_a_catch_all_thread_stays_listed_while_it_holds_an_unclaimed_row(unlocked):
    client.post("/api/platform/hub/deliver", headers=KEY, json={
        "thread_id": "ops", "kind": "ops", "parts": [{"type": "text", "text": "no job id on this one"}],
    })
    threads = client.get("/api/chat/threads", cookies=COOKIE).json()["threads"]
    assert [t["id"] for t in threads] == ["ops"]


def test_opening_a_run_reads_it_and_makes_its_thread(unlocked):
    sync(runs=[run(OPS, "a", 2, "⚠️ ops-watch:\n• backup stale — 136h")])
    run_id = f"{OPS}:a"
    r = client.post(f"/api/chat/automations/runs/{run_id}/open", json={}, cookies=COOKIE)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run"]["parts"] == [{"type": "text", "text": "⚠️ ops-watch:\n• backup stale — 136h"}]
    assert body["run"]["read"] is True
    assert body["job"]["needs_you"] is False
    thread = body["thread"]
    assert (thread["id"], thread["kind"], thread["origin_run_id"]) == (followup_thread_id(run_id), "followup", run_id)
    # Hidden from Chat until pinned.
    assert client.get("/api/chat/threads", cookies=COOKIE).json()["threads"] == []
    client.post(f"/api/chat/threads/{thread['id']}/patch", json={"pinned": True}, cookies=COOKIE)
    assert [t["id"] for t in client.get("/api/chat/threads", cookies=COOKIE).json()["threads"]] == [thread["id"]]


def test_the_first_reply_carries_the_run_to_the_agent(unlocked, monkeypatch):
    sync(runs=[run(OPS, "a", 2, "⚠️ ops-watch:\n• backup stale — 136h")])
    thread_id = client.post(f"/api/chat/automations/runs/{OPS}:a/open", json={}, cookies=COOKIE).json()["thread"]["id"]
    sent: list[dict] = []
    monkeypatch.setattr("chat.routes.forward_gateway_event", lambda payload: (sent.append(payload), ("forwarded", ""))[1])
    for n, text in enumerate(["why is the backup stale", "and the fix?"]):
        r = client.post(f"/api/chat/threads/{thread_id}/send", cookies=COOKIE,
                        json={"text": text, "client_msg_id": f"c{n}"})
        assert r.status_code == 200, r.text
    assert sent[0]["text"] == "why is the backup stale"
    assert "ops-watch" in sent[0]["context_note"] and "backup stale — 136h" in sent[0]["context_note"]
    assert "context_note" not in sent[1]
    # Opening it again parks nothing new, and the run now shows its replies.
    reopened = client.post(f"/api/chat/automations/runs/{OPS}:a/open", json={}, cookies=COOKIE).json()
    assert reopened["run"]["replies"] == 2
    assert reopened["job"]["followups"] == 1


def test_prefs_and_read_routes(unlocked):
    sync(runs=[run(OPS, "a", 2, "⚠️ ops-watch:\n• backup stale")])
    r = client.post(f"/api/chat/automations/jobs/{OPS}/prefs", json={"notify": "quiet"}, cookies=COOKIE)
    assert r.json()["job"]["notify"] == "quiet"
    assert client.post(f"/api/chat/automations/jobs/{OPS}/prefs", json={}, cookies=COOKIE).status_code == 422
    assert client.post("/api/chat/automations/jobs/nope/prefs", json={"notify": "push"}, cookies=COOKIE).status_code == 404
    assert client.post("/api/chat/automations/read-all", json={}, cookies=COOKIE).json()["counts"]["needs_you"] == 1
    assert client.get("/api/automations/badge").json() == {"needs_you": 1}
    assert client.post(f"/api/chat/automations/jobs/{OPS}/read", json={}, cookies=COOKIE).json()["job"]["needs_you"] is False
    detail = client.get(f"/api/chat/automations/jobs/{OPS}", cookies=COOKIE).json()
    assert detail["job"]["section"] == "earlier"
    assert [i["kind"] for i in detail["items"]] == ["run"]


# --- history ----------------------------------------------------------------------------
def test_backfill_files_stored_deliveries_on_evidence_only(unlocked):
    autos = AutomationStore(platform.get_store())
    sync(jobs=[{"id": "ce4ca12805ee", "name": "cron-watch", "deliver": "discord:100000000000000004,hub:cron"}])
    sync(runs=[
        run(OPS, "f1", 30, "\u26A0\uFE0F ops-watch:\n\u2022 backup stale \u2014 112h"),
        run(CREDIT, "f1", 1, "\U0001F6A8 credit-watch: balance $9.97 left"),
    ])

    def stored(thread: str, text: str, **extra) -> None:
        r = client.post("/api/platform/hub/deliver", headers=KEY,
                        json={"thread_id": thread, "kind": thread, "parts": [{"type": "text", "text": text}], **extra})
        assert r.status_code == 200, r.text

    stored("ops", "\U0001F6A8 credit-watch: balance $9.97 left")                       # text
    stored("ops", "\u26A0\uFE0F ops-watch:\n\u2022 state volume 94% full")   # opener
    stored("cron", "\U0001F6A8 cron-watch:\n  credit-watch missed its run")            # thread
    stored("ops", "\u23F3 Working \u2014 18 min \u2014 iteration 3")                    # nothing claims it
    stored("brief", "\u26A0\uFE0F Cron 'cron-watch' failed: the AI model service says no")  # named
    stored("ops", "here is what I found", run_id="run-1")                              # a chat turn
    client.post("/api/chat/threads/ops/send", cookies=COOKIE, json={"text": "why", "client_msg_id": "c1"})

    dry = client.post("/api/platform/hub/automations/backfill", json={}, headers=KEY).json()
    assert dry["dry_run"] is True
    assert dry["by_rule"] == {"text": 1, "opener": 1, "thread": 1, "named": 1}
    assert dry["left_in_thread"] == 1
    assert autos.job_summary("ce4ca12805ee")["latest"] is None   # a dry run writes nothing

    done = client.post("/api/platform/hub/automations/backfill", json={"dry_run": False}, headers=KEY).json()
    assert done["by_job"] == {"credit-watch": 1, "ops-watch": 1, "cron-watch": 2}
    assert done["left_in_thread"] == 1
    # The delivery that matched a run file joined it; the others became runs of their own.
    assert done["runs_added"] == 3
    assert len(autos.job_items(CREDIT)) == 1
    # Both of cron-watch's rows — the one its thread placed and the failure
    # notice that named it — are its runs. (Stored in the same second, so
    # which is "newest" is not something this test can say.)
    previews = sorted(i["run"]["preview"] for i in autos.job_items("ce4ca12805ee") if i["kind"] == "run")
    assert previews[0].startswith("Cron 'cron-watch' failed")
    assert previews[1] == "credit-watch missed its run"

    listed = {t["id"] for t in client.get("/api/chat/threads", cookies=COOKIE).json()["threads"]}
    # `cron` held nothing but deliveries and is gone from Chat; `ops` holds a
    # conversation and stays.
    assert listed == {"ops"}
    again = client.post("/api/platform/hub/automations/backfill", json={"dry_run": False}, headers=KEY).json()
    assert again["rows"] == 0


def test_a_thread_snapshot_carries_its_open_approval(unlocked):
    """Opened after the approval arrived, the thread must still be able to draw
    and answer the card: the socket resumes past the event that raised it."""
    r = client.post("/api/platform/hub/deliver", headers=KEY, json={
        "thread_id": "thr_appr_snap", "run_id": "run_9",
        "parts": [{"type": "tool_call", "tool_call_id": "req_9", "tool_name": "terminal", "state": "approval_requested"}],
        "attention": {"kind": "approval", "request_id": "req_9", "run_id": "run_9", "summary": "terminal: curl"},
    })
    assert r.status_code == 200, r.text
    detail = client.get("/api/chat/threads/thr_appr_snap", cookies=COOKIE).json()
    [row] = detail["attention"]
    assert (row["kind"], row["request_id"], row["run_id"], row["state"]) == ("approval", "req_9", "run_9", "open")
    assert row["message_id"] == detail["messages"][0]["id"]


def test_an_approval_the_gateway_stopped_waiting_on_closes(unlocked):
    """/stop withdrew the approval; its card sat in Needs you for good."""
    for rid in ("req_a", "req_b"):
        client.post("/api/platform/hub/deliver", headers=KEY, json={
            "thread_id": "thr_settle", "run_id": "run_s",
            "parts": [{"type": "tool_call", "tool_call_id": rid, "tool_name": "terminal", "state": "approval_requested"}],
            "attention": {"kind": "approval", "request_id": rid, "run_id": "run_s", "summary": f"terminal {rid}"},
        })
    r = client.post("/api/platform/hub/approvals/settle", headers=KEY,
                    json={"thread_id": "thr_settle", "pending_request_ids": ["req_b"], "outcome": "cancelled"})
    assert r.json() == {"status": "ok", "closed": 1}
    detail = client.get("/api/chat/threads/thr_settle", cookies=COOKIE).json()
    assert [a["request_id"] for a in detail["attention"]] == ["req_b"]
    cards = {m["parts"][0]["tool_call_id"]: m["parts"][0] for m in detail["messages"]}
    assert (cards["req_a"]["state"], cards["req_a"]["resolved_choice"]) == ("answered", "withdrawn")
    assert cards["req_b"]["state"] == "approval_requested"
    # Settling again changes nothing.
    again = client.post("/api/platform/hub/approvals/settle", headers=KEY,
                        json={"thread_id": "thr_settle", "pending_request_ids": ["req_b"], "outcome": "timeout"})
    assert again.json()["closed"] == 0
    assert client.post("/api/platform/hub/approvals/settle", json={"thread_id": "thr_settle"}).status_code == 401


# --- push -----------------------------------------------------------------------------
@pytest.fixture()
def pushes(monkeypatch):
    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(platform, "_notify_automation", lambda name, run_id, text: sent.append((name, run_id, text)))
    return sent


def deliver(job_id: str, stem: str, text: str) -> None:
    r = client.post("/api/platform/hub/deliver", headers=KEY, json={
        "thread_id": "ops", "job_id": job_id, "job_run_id": f"{job_id}:{stem}",
        "parts": [{"type": "text", "text": text}],
    })
    assert r.status_code == 200, r.text


def test_a_delivery_pushes_once_and_a_repeat_does_not(unlocked, pushes):
    deliver(OPS, "d1", "⚠️ ops-watch:\n• backup stale — last snapshot 112h ago")
    deliver(OPS, "d2", "⚠️ ops-watch:\n• backup stale — last snapshot 136h ago")
    deliver(CREDIT, "d1", "🚨 credit-watch: balance $9.97 left (threshold $10)")
    deliver(CREDIT, "d2", "🚨 credit-watch: balance $0.82 left (threshold $10)")
    assert [(name, run_id) for name, run_id, _ in pushes] == [
        ("ops-watch", f"{OPS}:d1"), ("credit-watch", f"{CREDIT}:d1"), ("credit-watch", f"{CREDIT}:d2"),
    ]


def test_a_delivery_whose_file_is_missing_is_its_own_run(unlocked, pushes):
    from chat.platform import get_store
    deliver(OPS, "same", "⚠️ ops-watch:\n• first")
    store = get_store()
    with store._lock:
        store._conn.execute("UPDATE messages SET created_at='2026-09-29T00:00:00Z' WHERE cron_run_id=?", (f"{OPS}:same",))
        store._conn.execute("UPDATE automation_runs SET run_time='2026-09-29T00:00:00Z' WHERE run_id=?", (f"{OPS}:same",))
        store._conn.commit()
    deliver(OPS, "same", "⚠️ ops-watch:\n• second, no file yet")
    items = [i["run"]["preview"] for i in AutomationStore(store).job_items(OPS) if i["kind"] == "run"]
    assert items == ["second, no file yet", "first"]


def test_a_reply_that_the_gateway_did_not_take_keeps_the_run_for_the_next_one(unlocked, monkeypatch):
    sync(runs=[run(OPS, "a", 2, "⚠️ ops-watch:\n• backup stale")])
    thread_id = client.post(f"/api/chat/automations/runs/{OPS}:a/open", json={}, cookies=COOKIE).json()["thread"]["id"]
    sent: list[dict] = []
    outcome = {"status": "pending"}
    monkeypatch.setattr("chat.routes.forward_gateway_event", lambda p: (sent.append(p), (outcome["status"], "gateway unreachable"))[1])
    client.post(f"/api/chat/threads/{thread_id}/send", cookies=COOKIE, json={"text": "why", "client_msg_id": "c1"})
    outcome["status"] = "forwarded"
    client.post(f"/api/chat/threads/{thread_id}/send", cookies=COOKIE, json={"text": "still there?", "client_msg_id": "c2"})
    assert "context_note" in sent[0] and "context_note" in sent[1]
    client.post(f"/api/chat/threads/{thread_id}/send", cookies=COOKIE, json={"text": "ok", "client_msg_id": "c3"})
    assert "context_note" not in sent[2]


def test_quiet_muted_and_snoozed_jobs_never_push(unlocked, pushes):
    client.post(f"/api/chat/automations/jobs/{OPS}/prefs", json={"notify": "quiet"}, cookies=COOKIE)
    client.post(f"/api/chat/automations/jobs/{CREDIT}/prefs", json={"snooze_hours": 24}, cookies=COOKIE)
    deliver(OPS, "a", "⚠️ ops-watch:\n• backup stale")
    deliver(CREDIT, "a", "\U0001F6A8 credit-watch: balance low")
    assert pushes == []


def test_the_push_opens_the_run():
    from chat import notify

    (TMP / "push_tokens.json").write_text('{"tokens": [{"token": "ExponentPushToken[abc]"}]}')
    notify.set_presence("background")
    seen: list = []

    class Response:
        def read(self):
            return b'{"data": [{"status": "ok"}]}'

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def opener(req, timeout):
        import json

        seen.extend(json.loads(req.data.decode()))
        return Response()

    out = notify.notify_automation(job_name="ops-watch", run_id=f"{OPS}:a", text="backup stale", open_fn=opener)
    assert out == {"sent": 1, "reason": "ok"}
    assert seen[0]["title"] == "ops-watch"
    assert seen[0]["data"] == {"url": f"/automations/run?runId={OPS}:a", "run_id": f"{OPS}:a"}


def test_the_module_is_wired_to_the_store_in_use(unlocked):
    assert autos_mod.delivery_thread_id(OPS) == f"auto_{OPS}"
