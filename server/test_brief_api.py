"""Task 9: /api/brief, the Ruling-50 slug lockdown, and the HMAC-gated
dismiss/useful writes. Env is set at module scope BEFORE app is imported (the
pattern every test file here follows); the autouse fixture re-asserts the same paths on
the module so the file also passes when pytest imports app for another suite
first. The HMAC key is generated here — never copied from the live one."""

import hashlib
import hmac
import json
import os
import pathlib
import secrets
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
PAGES = TMP / "my-pages"
DATA = TMP / "hub" / "data"
PAGES.mkdir(parents=True)
DATA.mkdir(parents=True)

# Printable, like a real minted key: the server strips the key file's whitespace,
# so random bytes that start or end with one would make the two HMACs differ.
KEY = secrets.token_hex(32).encode()
KEY_FILE = DATA / "brief_dismiss.key"
KEY_FILE.write_bytes(KEY)
DISMISSALS = DATA / "briefing_dismissals.json"
FEEDBACK = DATA / "briefing_feedback.jsonl"

os.environ["MY_PAGES_ROOT"] = str(PAGES)
os.environ["HUB_BRIEFING_DISMISSALS"] = str(DISMISSALS)
os.environ["HUB_BRIEFING_FEEDBACK"] = str(FEEDBACK)
os.environ["HUB_BRIEF_DISMISS_KEY_FILE"] = str(KEY_FILE)
os.environ["HUB_TZ"] = "America/New_York"

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402
import app as mod  # noqa: E402

client = TestClient(mod.app)

TODAY = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
OLD = "2026-01-10"

SHOWN = "a1b2c3d4e5f6"
DISMISSED = "0f1e2d3c4b5a"
SNOOZED_LIVE = "111111111111"
SNOOZED_EXPIRED = "222222222222"
WRAPPED = "333333333333"

ENVELOPE = {
    "deferred": [{"item_id": "999999999999", "code": "NOISE", "title": "x"}],
    "held_back": {"total": 1, "by_code": {"NOISE": 1}},
    "sources": {"email": {"count": 4}},
    "provenance": {"git_sha": "deadbeef"},
    "gather_warnings": {"_warnings": []},
}


def token(date: str, item_id: str) -> str:
    return hmac.new(KEY, f"{date}:{item_id}".encode(), hashlib.sha256).hexdigest()[:24]


def item(item_id: str, title: str = "T", source: str = "email") -> dict:
    return {"item_id": item_id, "title": title, "source": source, "kind": "email"}


def write_brief(date: str, buckets: dict) -> pathlib.Path:
    d = PAGES / f"briefing-{date}"
    (d / "candidates").mkdir(parents=True, exist_ok=True)
    (d / "candidates" / "email.json").write_text('[{"item_id": "999999999999"}]')
    (d / "brief.json").write_text(json.dumps({"date": date, "buckets": buckets, **ENVELOPE}))
    return d


BRIEF_DIR = write_brief(TODAY, {
    "now": [item(SHOWN), item(DISMISSED)],
    "today": [item(SNOOZED_LIVE), item(SNOOZED_EXPIRED)],
    "week": [item(WRAPPED, title="Renewal notice\n  for the thing", source="Gmail")],
    "background": [],
})
write_brief(OLD, {"now": [item(SHOWN)], "today": [], "week": [], "background": []})

(BRIEF_DIR / "index.html").write_text(
    f'<html><body><!--dz:{WRAPPED}--><div class="card">'
    f'<div class="card-title">Renewal notice\n  for the thing</div>'
    f'<span class="tag">Gmail</span></div><!--/dz:{WRAPPED}--></body></html>')
(PAGES / "notes").mkdir(exist_ok=True)
(PAGES / "notes" / "data.json").write_text("{}")
(PAGES / "notes" / "index.html").write_text("<html></html>")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setattr(mod, "MY_PAGES_ROOT", PAGES)
    monkeypatch.setattr(mod, "BRIEFING_DISMISSALS", DISMISSALS)
    monkeypatch.setattr(mod, "BRIEFING_FEEDBACK", FEEDBACK)
    monkeypatch.setattr(mod, "BRIEF_DISMISS_KEY_FILE", KEY_FILE)
    DISMISSALS.write_text(json.dumps({"dismissed": {}, "snoozed": {}}))
    FEEDBACK.write_text("")


def ids(payload: dict, bucket: str) -> list[str]:
    return [i["item_id"] for i in payload["buckets"][bucket]]


# --- 9.1 GET /api/brief -------------------------------------------------------

def test_brief_defaults_to_today_and_passes_the_envelope_through():
    r = client.get("/api/brief")
    assert r.status_code == 200
    body = r.json()
    assert body["served_date"] == TODAY and body["hidden_count"] == 0
    assert ids(body, "now") == [SHOWN, DISMISSED]
    for key, value in ENVELOPE.items():
        assert body[key] == value


def test_brief_hides_dismissed_and_live_snoozes_but_not_expired_ones():
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    DISMISSALS.write_text(json.dumps({
        "dismissed": {DISMISSED: "permanent"},
        "snoozed": {SNOOZED_LIVE: future, SNOOZED_EXPIRED: past}}))
    body = client.get("/api/brief").json()
    assert ids(body, "now") == [SHOWN]
    assert ids(body, "today") == [SNOOZED_EXPIRED]
    assert body["hidden_count"] == 2


def test_brief_falls_back_within_five_days_and_404s_beyond():
    three_later = (datetime.strptime(OLD, "%Y-%m-%d") + timedelta(days=3)).date().isoformat()
    r = client.get("/api/brief", params={"date": three_later})
    assert r.status_code == 200 and r.json()["served_date"] == OLD
    far = (datetime.strptime(OLD, "%Y-%m-%d") + timedelta(days=20)).date().isoformat()
    r = client.get("/api/brief", params={"date": far})
    assert r.status_code == 404 and r.json() == {"detail": "no brief"}


def test_brief_is_never_cached_and_rejects_a_bad_date():
    r = client.get("/api/brief")
    assert "no-store" in r.headers["cache-control"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert client.get("/api/brief", params={"date": "yesterday"}).status_code == 400
    assert client.get("/api/brief", params={"date": "2026-13-45"}).status_code == 400


# --- 9.2 Ruling 50: only .html is servable under a brief slug ------------------

def test_brief_slug_serves_only_html():
    assert client.get(f"/my-pages/briefing-{TODAY}/candidates/email.json").status_code == 404
    assert client.get(f"/my-pages/briefing-{TODAY}/brief.json").status_code == 404
    assert client.get(f"/my-pages/briefing-{TODAY}/index.html").status_code == 200
    # scoped to brief slugs — other my-pages keep serving their assets
    assert client.get("/my-pages/notes/data.json").status_code == 200


# --- 9.3 per-item HMAC dismiss ------------------------------------------------

def post_dismiss(action: str, item_id: str = DISMISSED, date: str = TODAY, tok: str | None = None):
    return client.post("/api/briefing/dismiss.json", json={
        "item_id": item_id, "action": action, "date": date,
        "token": token(date, item_id) if tok is None else tok})


def test_dismiss_json_is_on_the_post_allowlist():
    # the middleware 405s any POST path outside POST_ALLOWLIST_PREFIXES; the
    # existing /api/briefing/dismiss entry is a prefix of .json, so it is covered
    assert client.post("/api/briefing/nope.json", json={}).status_code == 405
    assert post_dismiss("dismiss", tok="0" * 24).status_code != 405
    assert client.post("/api/briefing/useful.json", json={
        "item_id": SHOWN, "date": TODAY, "token": "0" * 24}).status_code != 405


def test_dismiss_json_rejects_a_wrong_token_and_leaves_the_store_untouched():
    before = DISMISSALS.read_bytes()
    assert post_dismiss("dismiss", tok="0" * 24).status_code == 403
    assert post_dismiss("dismiss", tok="").status_code == 403
    # a token minted for another day must not work on this one
    assert post_dismiss("dismiss", tok=token(OLD, DISMISSED)).status_code == 403
    assert DISMISSALS.read_bytes() == before


def test_dismiss_json_writes_the_dismissal_and_the_brief_stops_serving_it():
    r = post_dismiss("dismiss")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "item_id": DISMISSED, "action": "dismiss"}
    assert json.loads(DISMISSALS.read_text())["dismissed"] == {DISMISSED: "permanent"}
    body = client.get("/api/brief").json()
    assert DISMISSED not in ids(body, "now") and body["hidden_count"] == 1


def test_dismiss_json_snoozes_then_undoes():
    r = post_dismiss("snooze:3d", item_id=SNOOZED_LIVE)
    assert r.status_code == 200 and r.json()["until"] > datetime.now(timezone.utc).isoformat()
    assert SNOOZED_LIVE in json.loads(DISMISSALS.read_text())["snoozed"]
    assert post_dismiss("snooze:9d", item_id=SNOOZED_LIVE).status_code == 400

    assert post_dismiss("undo", item_id=SNOOZED_LIVE).status_code == 200
    store = json.loads(DISMISSALS.read_text())
    assert SNOOZED_LIVE not in store["snoozed"] and SNOOZED_LIVE not in store["dismissed"]


def test_dismiss_json_reason_appends_feedback_from_brief_json():
    assert post_dismiss("reason:irrelevant", item_id=WRAPPED).status_code == 200
    entry = json.loads(FEEDBACK.read_text().splitlines()[-1])
    assert entry["reason"] == "irrelevant" and entry["brief"] == f"briefing-{TODAY}"
    assert entry["title"] == "Renewal notice for the thing" and entry["source"] == "Gmail"
    assert post_dismiss("reason:nonsense", item_id=WRAPPED).status_code == 400


def test_dismiss_json_accepts_the_ruling_146_why_chip_codes():
    """The undo-row chips (not-mine/done/noise) post through the SAME
    reason: handler as the legacy irrelevant/bot codes — this only proves the
    server accepts and logs them; load_exemplars grouping them by reason is
    covered by the brief-triage tests."""
    assert post_dismiss("reason:done", item_id=WRAPPED).status_code == 200
    entry = json.loads(FEEDBACK.read_text().splitlines()[-1])
    assert entry["reason"] == "done" and entry["item_id"] == WRAPPED
    assert post_dismiss("reason:bogus", item_id=WRAPPED).status_code == 400


def test_dismiss_json_503s_with_no_key_and_writes_nothing(monkeypatch):
    before = DISMISSALS.read_bytes()
    monkeypatch.setattr(mod, "BRIEF_DISMISS_KEY_FILE", DATA / "absent.key")
    assert post_dismiss("dismiss").status_code == 503
    assert client.post("/api/briefing/useful.json", json={
        "item_id": SHOWN, "date": TODAY, "token": token(TODAY, SHOWN)}).status_code == 503
    assert DISMISSALS.read_bytes() == before and FEEDBACK.read_text() == ""


def test_dismiss_json_rejects_malformed_ids_and_actions():
    assert post_dismiss("dismiss", item_id="nothex").status_code == 400
    assert post_dismiss("dismiss", date="2026-9-16").status_code == 400
    assert post_dismiss("obliterate").status_code == 400
    assert client.post("/api/briefing/dismiss.json", json={"item_id": SHOWN}).status_code == 422


# --- 9.4 one-line feedback facts ----------------------------------------------

def test_card_facts_from_html_collapse_to_one_line():
    r = client.post("/api/briefing/dismiss", data={
        "item_id": WRAPPED, "action": "reason:irrelevant",
        "return_to": f"/my-pages/briefing-{TODAY}/index.html"}, follow_redirects=False)
    assert r.status_code == 303
    entry = json.loads(FEEDBACK.read_text().splitlines()[-1])
    assert entry["title"] == "Renewal notice for the thing"
    assert "\n" not in entry["title"] and "\n" not in entry["source"]


# --- 9.5 "useful" signal ------------------------------------------------------

def post_useful(item_id: str = SHOWN, date: str = TODAY, tok: str | None = None):
    return client.post("/api/briefing/useful.json", json={
        "item_id": item_id, "date": date,
        "token": token(date, item_id) if tok is None else tok})


def test_useful_appends_once_and_is_idempotent_per_item():
    r = post_useful()
    assert r.status_code == 200 and not r.json().get("already")
    entry = json.loads(FEEDBACK.read_text().splitlines()[-1])
    assert entry["signal"] == "useful" and entry["item_id"] == SHOWN
    assert entry["title"] == "T" and entry["source"] == "email"
    assert entry["brief"] == f"briefing-{TODAY}"

    again = post_useful()
    assert again.status_code == 200 and again.json()["already"] is True
    assert len(FEEDBACK.read_text().splitlines()) == 1

    post_useful(item_id=WRAPPED)
    assert len(FEEDBACK.read_text().splitlines()) == 2


def test_useful_rejects_a_wrong_token_and_appends_nothing():
    assert post_useful(tok="0" * 24).status_code == 403
    assert FEEDBACK.read_text() == ""


# --- 9.6 "tell the brief about this" (Ruling 146) -----------------------------

def post_note(note: str, item_id: str = SHOWN, date: str = TODAY, tok: str | None = None):
    return client.post("/api/briefing/note.json", json={
        "item_id": item_id, "date": date, "note": note,
        "token": token(date, item_id) if tok is None else tok})


def test_note_is_logged_and_never_deduped():
    r = post_note("this is actually my manager's, not mine")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "item_id": SHOWN, "signal": "note"}
    entry = json.loads(FEEDBACK.read_text().splitlines()[-1])
    assert entry["signal"] == "note" and entry["item_id"] == SHOWN
    assert entry["note"] == "this is actually my manager's, not mine"
    assert entry["title"] == "T" and entry["source"] == "email"
    assert entry["brief"] == f"briefing-{TODAY}"

    # unlike useful.json, a second note on the same item is kept, not dropped
    assert post_note("a second, different thing to say").status_code == 200
    assert len(FEEDBACK.read_text().splitlines()) == 2


def test_note_collapses_newlines_to_one_line():
    assert post_note("line one\n  line two").status_code == 200
    entry = json.loads(FEEDBACK.read_text().splitlines()[-1])
    assert entry["note"] == "line one line two"


def test_note_rejects_an_over_long_note_and_an_empty_one():
    assert post_note("x" * 301).status_code == 400
    assert post_note("   ").status_code == 400
    assert FEEDBACK.read_text() == ""


def test_note_rejects_a_wrong_token_and_appends_nothing():
    assert post_note("anything", tok="0" * 24).status_code == 403
    assert FEEDBACK.read_text() == ""
