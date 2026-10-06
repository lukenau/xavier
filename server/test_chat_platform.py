"""Hub chat platform routes — chat/store.py + chat/platform.py.

Offline: TestClient in-process, chat.db + media dir under a tmpdir, no live hub-api, no
network. Run in its own process (run_tests.sh) — env vars below only take effect if
this module is the first to import `app`.
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import sys
import tempfile

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_CHAT_DB"] = str(TMP / "chat" / "chat.db")
os.environ["HUB_CHAT_MEDIA_DIR"] = str(TMP / "chat" / "media")
os.environ["HUB_CHAT_COMMAND_CATALOG"] = str(TMP / "chat" / "commands-catalog.json")
os.environ["HUB_PLATFORM_KEY_FILE"] = str(TMP / "hub-platform-key")
(TMP / "hub-platform-key").write_text("test-platform-secret\n")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
import chat.platform as platform  # noqa: E402
import chat.store as store_mod  # noqa: E402

client = TestClient(app)
AUTH = {"Authorization": "Bearer test-platform-secret"}


def deliver_body(**overrides) -> dict:
    body = {
        "thread_id": "thr_test1",
        "parts": [{"type": "text", "text": "hello from assistant"}],
    }
    body.update(overrides)
    return body


# --- auth --------------------------------------------------------------------
def test_deliver_requires_a_bearer_token():
    r = client.post("/api/platform/hub/deliver", json=deliver_body())
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "hub_platform_key_invalid"


def test_deliver_rejects_a_wrong_token():
    r = client.post("/api/platform/hub/deliver", json=deliver_body(), headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_deliver_checks_the_key_before_the_body():
    """The key dependency runs before body validation: an unauthenticated `{}` is a
    401, never a 422 that spells the request schema out to whoever reached 8090."""
    r = client.post("/api/platform/hub/deliver", json={})
    assert r.status_code == 401
    r = client.post("/api/platform/hub/deliver", json={}, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    for route in ("/api/platform/hub/media", "/api/platform/hub/commands"):
        assert client.post(route, json={}).status_code == 401


def test_deliver_503s_when_key_unprovisioned(monkeypatch):
    monkeypatch.setattr(platform, "HUB_PLATFORM_KEY_FILE", TMP / "missing-key")
    r = client.post("/api/platform/hub/deliver", json=deliver_body(), headers=AUTH)
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "hub_platform_key_unprovisioned"


def test_env_var_alone_is_never_accepted_as_the_key(monkeypatch):
    """VERDICT-V2 §7 trap: no env-var fallback for the secret VALUE, only its path."""
    monkeypatch.setenv("HUB_PLATFORM_KEY", "test-platform-secret")
    monkeypatch.setattr(platform, "HUB_PLATFORM_KEY_FILE", TMP / "missing-key-2")
    r = client.post("/api/platform/hub/deliver", json=deliver_body(), headers=AUTH)
    assert r.status_code == 503  # still unprovisioned — the env var must not be read


# --- deliver: thread + message creation ---------------------------------------
def test_deliver_lazily_creates_the_thread_with_the_hardcoded_session_key():
    r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_lazy"), headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok" and body["deduped"] is False
    thread = platform.get_store().get_thread("thr_lazy")
    assert thread is not None
    assert thread["session_key"] == "agent:main:hub:dm:thr_lazy"
    assert thread["chat_type"] == "dm"
    assert thread["kind"] == "chat"
    assert "end_reason" not in thread  # never stored — VERDICT-V2 §4.2


def test_deliver_stores_parts_and_assigns_increasing_seq():
    r1 = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_seq"), headers=AUTH)
    r2 = client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_seq", parts=[{"type": "text", "text": "second"}]),
        headers=AUTH,
    )
    assert r1.json()["seq"] < r2.json()["seq"]
    msg = platform.get_store()._message_row(r2.json()["message_id"])
    assert msg["parts"] == [{"type": "text", "text": "second"}]
    assert msg["author_type"] == "agent" and msg["role"] == "assistant"


def test_deliver_second_call_reuses_an_existing_thread():
    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_reuse"), headers=AUTH)
    before = platform.get_store().get_thread("thr_reuse")["created_at"]
    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_reuse"), headers=AUTH)
    after = platform.get_store().get_thread("thr_reuse")
    assert after["created_at"] == before  # not re-created


def test_deliver_records_hermes_session_id():
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_hsid", hermes_session_id="20260916_000000_abcd"),
        headers=AUTH,
    )
    thread = platform.get_store().get_thread("thr_hsid")
    assert thread["hermes_session_id"] == "20260916_000000_abcd"


# --- deliver: idempotency ------------------------------------------------------
def test_deliver_dedups_on_cron_run_id():
    body = deliver_body(thread_id="thr_cron", cron_run_id="run-42")
    r1 = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    r2 = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r1.json()["deduped"] is False
    assert r2.json()["deduped"] is True
    assert r1.json()["message_id"] == r2.json()["message_id"]
    # only one message actually landed
    store = platform.get_store()
    row = store._conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND cron_run_id=?", ("thr_cron", "run-42")
    ).fetchone()
    assert row["n"] == 1


def test_deliver_a_different_cron_run_id_is_a_new_message():
    r1 = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_cron2", cron_run_id="a"), headers=AUTH)
    r2 = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_cron2", cron_run_id="b"), headers=AUTH)
    assert r1.json()["message_id"] != r2.json()["message_id"]


# --- deliver: validation -------------------------------------------------------
def test_deliver_rejects_an_unknown_part_type():
    r = client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_badpart", parts=[{"type": "carrier_pigeon"}]),
        headers=AUTH,
    )
    assert r.status_code == 422


def test_deliver_rejects_empty_parts():
    r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_empty", parts=[]), headers=AUTH)
    assert r.status_code == 422


def test_deliver_rejects_role_user():
    """This route is gateway-only; a "user" row must never be mintable through it."""
    r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_role", role="user"), headers=AUTH)
    assert r.status_code == 422


def test_deliver_rejects_a_malformed_thread_id():
    for bad in ["../etc/passwd", "thr with spaces", "a" * 65, ""]:
        r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id=bad), headers=AUTH)
        assert r.status_code == 422, bad


def test_deliver_rejects_unknown_fields():
    body = deliver_body(thread_id="thr_extra")
    body["chat_type"] = "dm"  # hardcoded server-side; must not be an accepted field
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r.status_code == 422


# --- deliver: attention + approvals --------------------------------------------
def test_deliver_with_approval_attention_writes_both_tables():
    body = deliver_body(
        thread_id="thr_appr",
        run_id="run_1",
        parts=[{"type": "tool_call", "tool_name": "terminal", "state": "approval_requested"}],
        attention={"kind": "approval", "request_id": "req_1", "run_id": "run_1", "summary": "terminal: ls"},
    )
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r.status_code == 200, r.text
    att_id = r.json()["attention_id"]
    assert att_id is not None
    store = platform.get_store()
    att = store._conn.execute("SELECT * FROM attention WHERE id=?", (att_id,)).fetchone()
    assert att["kind"] == "approval" and att["state"] == "open" and att["thread_id"] == "thr_appr"
    appr = store._conn.execute(
        "SELECT * FROM approvals WHERE run_id=? AND request_id=?", ("run_1", "req_1")
    ).fetchone()
    assert appr is not None
    assert appr["answered"] == 0 and appr["choice"] is None
    frame = json.loads(appr["frame"])
    assert frame["thread_id"] == "thr_appr"


def test_approval_attention_requires_request_id_and_run_id():
    body = deliver_body(thread_id="thr_appr2", attention={"kind": "approval", "summary": "x"})
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r.status_code == 422


def test_repeated_approval_attention_updates_the_same_open_row():
    body = deliver_body(
        thread_id="thr_appr3",
        run_id="run_3",
        attention={"kind": "approval", "request_id": "req_3", "run_id": "run_3", "summary": "first", "queue_pos": 0},
    )
    r1 = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    body["attention"]["summary"] = "second"
    body["attention"]["queue_pos"] = 1
    r2 = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r1.json()["attention_id"] == r2.json()["attention_id"]
    store = platform.get_store()
    rows = store._conn.execute("SELECT * FROM attention WHERE thread_id=?", ("thr_appr3",)).fetchall()
    assert len(rows) == 1 and rows[0]["summary"] == "second"


def test_non_approval_attention_needs_no_ids():
    body = deliver_body(thread_id="thr_mention", attention={"kind": "mention", "summary": "@user in ops"})
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r.status_code == 200, r.text


# --- media ---------------------------------------------------------------------
TINY_PNG = base64.b64encode(b"\x89PNG\r\n\x1a\nnot a real image but nobody validates it").decode()


def test_media_upload_writes_a_file_and_a_row():
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media", "mime": "image/png", "data_b64": TINY_PNG},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    media_id = r.json()["media_id"]
    store = platform.get_store()
    row = store.get_media(media_id)
    assert row is not None and row["mime"] == "image/png" and row["origin"] == "agent"
    assert pathlib.Path(row["storage_path"]).exists()
    assert pathlib.Path(row["storage_path"]).read_bytes() == base64.b64decode(TINY_PNG)


def test_media_rejects_bad_base64():
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media2", "mime": "image/png", "data_b64": "not-base64!!"},
        headers=AUTH,
    )
    assert r.status_code == 400


def test_media_rejects_oversized_payload(monkeypatch):
    monkeypatch.setattr(platform, "MAX_MEDIA_DECODED_BYTES", 8)
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media3", "mime": "image/png", "data_b64": TINY_PNG},
        headers=AUTH,
    )
    assert r.status_code == 413


def test_media_enforces_the_total_storage_cap(monkeypatch):
    monkeypatch.setattr(platform, "MAX_MEDIA_TOTAL_BYTES", 4)
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media4", "mime": "image/png", "data_b64": TINY_PNG},
        headers=AUTH,
    )
    assert r.status_code == 507
    assert r.json()["detail"]["code"] == "media_store_full"


def test_media_rejects_a_disallowed_mime():
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media5", "mime": "application/pdf", "data_b64": TINY_PNG},
        headers=AUTH,
    )
    assert r.status_code == 422


# --- commands catalog ------------------------------------------------------------
def test_commands_catalog_round_trips_and_versions():
    push1 = {
        "version": 1,
        "commands": [{"name": "/new", "category": "builtin", "busy_policy": "interrupt_then_dispatch"}],
    }
    r1 = client.post("/api/platform/hub/commands", json=push1, headers=AUTH)
    assert r1.status_code == 200 and r1.json() == {"status": "ok", "version": 1, "count": 1}
    on_disk = json.loads(platform.COMMAND_CATALOG_FILE.read_text())
    assert on_disk["version"] == 1

    stale = client.post("/api/platform/hub/commands", json=push1, headers=AUTH)
    assert stale.json()["status"] == "stale_ignored"

    push2 = {"version": 2, "commands": []}
    r2 = client.post("/api/platform/hub/commands", json=push2, headers=AUTH)
    assert r2.status_code == 200 and r2.json()["version"] == 2
    assert json.loads(platform.COMMAND_CATALOG_FILE.read_text())["version"] == 2


def test_commands_rejects_an_unknown_category():
    body = {"version": 99, "commands": [{"name": "/x", "category": "bogus"}]}
    r = client.post("/api/platform/hub/commands", json=body, headers=AUTH)
    assert r.status_code == 422


# --- allowlist prefix -------------------------------------------------------------
def test_unmatched_path_under_the_allowed_prefix_is_404_not_405():
    r = client.post("/api/platform/hub/nope", json={}, headers=AUTH)
    assert r.status_code == 404


def test_a_sibling_platform_path_outside_the_prefix_is_still_405():
    r = client.post("/api/platform/other", json={})
    assert r.status_code == 405


# --- streaming a reply as it is written ------------------------------------------------

def _stream(thread_id: str, run_id: str, delta: str):
    return client.post(
        "/api/platform/hub/stream",
        json={"thread_id": thread_id, "run_id": run_id, "delta": delta},
        headers=AUTH,
    )


def test_deltas_build_one_message_and_deliver_lands_on_it():
    t, run = "thr_stream_a", "run_a"
    first = _stream(t, run, "Check").json()
    assert first["message_id"].startswith("msg_")
    _stream(t, run, "ing the")
    _stream(t, run, " cron.")

    store = platform.get_store()
    rows = store.list_messages(t)
    assert len(rows) == 1, "every delta must grow ONE message, not post a new one"
    assert rows[0]["status"] == "streaming"
    assert rows[0]["parts"][0]["text"] == "Checking the cron."

    # …and the finished turn replaces the text in place, on the same row.
    r = client.post("/api/platform/hub/deliver", json={
        "thread_id": t, "run_id": run, "parts": [{"type": "text", "text": "Checking the cron. It was stale."}],
    }, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["streamed"] is True
    assert r.json()["message_id"] == first["message_id"]
    rows = store.list_messages(t)
    assert len(rows) == 1
    assert rows[0]["status"] == "complete"
    assert rows[0]["parts"][0]["text"] == "Checking the cron. It was stale."


def test_each_delta_emits_a_part_delta_event_not_a_full_upsert():
    t, run = "thr_stream_b", "run_b"
    _stream(t, run, "one ")
    _stream(t, run, "two")
    events = [e for e in platform.get_store().list_events_after(t, 0)]
    kinds = [e["type"] for e in events]
    assert kinds.count("part.delta") == 1, "the first delta creates the message, later ones append"
    assert kinds.count("message.upsert") == 1
    delta = next(e for e in events if e["type"] == "part.delta")
    assert delta["payload"]["delta"] == "two"
    assert delta["payload"]["idx"] == 0


def test_a_tool_card_in_the_same_run_is_its_own_message():
    t, run = "thr_stream_c", "run_c"
    _stream(t, run, "looking…")
    r = client.post("/api/platform/hub/deliver", json={
        "thread_id": t, "run_id": run,
        "parts": [{"type": "tool_call", "tool_name": "terminal", "status": "complete"}],
    }, headers=AUTH)
    assert r.status_code == 200
    assert "streamed" not in r.json()
    rows = platform.get_store().list_messages(t)
    assert len(rows) == 2, "a tool card never overwrites the streaming reply"
    assert [m["status"] for m in rows] == ["streaming", "complete"]


def test_a_delivery_with_no_stream_behind_it_inserts_as_usual():
    r = client.post("/api/platform/hub/deliver", json={
        "thread_id": "thr_stream_d", "run_id": "run_d", "parts": [{"type": "text", "text": "hi"}],
    }, headers=AUTH)
    assert r.status_code == 200
    assert "streamed" not in r.json()
    assert len(platform.get_store().list_messages("thr_stream_d")) == 1


def test_stream_route_is_key_gated_and_bounded():
    assert client.post("/api/platform/hub/stream", json={"thread_id": "t", "run_id": "r", "delta": "x"}).status_code == 401
    r = client.post("/api/platform/hub/stream", json={"thread_id": "bad id!", "run_id": "r", "delta": "x"}, headers=AUTH)
    assert r.status_code == 422
    r = client.post("/api/platform/hub/stream", json={"thread_id": "thr_ok", "run_id": "", "delta": "x"}, headers=AUTH)
    assert r.status_code == 422
    r = client.post("/api/platform/hub/stream", json={"thread_id": "thr_ok", "run_id": "r", "delta": "x" * 16_001}, headers=AUTH)
    assert r.status_code == 422
    # An empty delta is a no-op, not a message.
    r = _stream("thr_stream_e", "run_e", "")
    assert r.status_code == 200 and r.json()["message_id"] is None
    assert platform.get_store().list_messages("thr_stream_e") == []


def test_thinking_streams_into_its_own_row_and_speech_opens_another():
    t, run = "thr_stream_f", "run_f"
    client.post("/api/platform/hub/stream", json={"thread_id": t, "run_id": run, "delta": "weighing ", "kind": "reasoning"}, headers=AUTH)
    client.post("/api/platform/hub/stream", json={"thread_id": t, "run_id": run, "delta": "the options", "kind": "reasoning"}, headers=AUTH)
    client.post("/api/platform/hub/stream", json={"thread_id": t, "run_id": run, "delta": "Here goes.", "kind": "text"}, headers=AUTH)

    store = platform.get_store()
    rows = store.list_messages(t)
    assert [(m["status"], [(p["type"], p["text"]) for p in m["parts"]]) for m in rows] == [
        ("streaming", [("reasoning", "weighing the options")]),
        ("streaming", [("text", "Here goes.")]),
    ]
    # (list_events_after skips seq 0, the thread.create). `run.status` is the
    # turn opening, which the first delta of any turn now announces.
    kinds = [e["type"] for e in store.list_events_after(t, 0) if e["type"] != "run.status"]
    # open the thinking row, append to it, then open a second row for the reply.
    assert kinds == ["message.upsert", "part.delta", "message.upsert"]


def test_thinking_and_the_reply_are_separate_rows_and_keep_their_order():
    """The three symptoms the user reported at once: thinking vanished on send, the
    reply appeared inside the thinking bubble, and tool calls ended up after the
    answer. All three are one cause — a single streaming row shared by both."""
    t, run = "thr_order", "run_order"
    client.post("/api/platform/hub/stream", json={"thread_id": t, "run_id": run, "delta": "weighing it", "kind": "reasoning"}, headers=AUTH)
    # a tool runs while it thinks
    client.post("/api/platform/hub/deliver", json={
        "thread_id": t, "run_id": run, "parts": [{"type": "tool_call", "tool_name": "terminal", "status": "complete"}],
    }, headers=AUTH)
    # then it starts speaking
    client.post("/api/platform/hub/stream", json={"thread_id": t, "run_id": run, "delta": "Here is", "kind": "text"}, headers=AUTH)
    # and finishes
    r = client.post("/api/platform/hub/deliver", json={
        "thread_id": t, "run_id": run, "parts": [{"type": "text", "text": "Here is the answer."}],
    }, headers=AUTH)
    assert r.json()["streamed"] is True

    rows = platform.get_store().list_messages(t)
    shapes = [(m["status"], [p["type"] for p in m["parts"]]) for m in rows]
    assert shapes == [
        ("complete", ["reasoning"]),   # the thinking, kept, not overwritten
        ("complete", ["tool_call"]),   # the work, in the middle where it happened
        ("complete", ["text"]),        # the answer, last
    ], shapes
    assert rows[0]["parts"][0]["text"] == "weighing it"
    assert rows[2]["parts"][0]["text"] == "Here is the answer."


# --- re-titling a thread whose topic moved on (L50) -------------------------------------
def say(thread_id: str, text: str, n: int = 1) -> None:
    for i in range(n):
        client.post("/api/platform/hub/deliver",
                    json={"thread_id": thread_id, "parts": [{"type": "text", "text": f"{text} {i}"}]},
                    headers=AUTH)


def test_title_and_title_review_require_the_key_before_the_body():
    assert client.post("/api/platform/hub/title", json={}).status_code == 401
    assert client.post("/api/platform/hub/title", json={"thread_id": "thr_t", "title": "x"},
                       headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/platform/hub/title-review").status_code == 401
    assert client.get("/api/platform/hub/title-review",
                      headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_title_overwrites_an_existing_name_and_emits_thread_patch():
    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_retitle", title="hello"), headers=AUTH)
    r = client.post("/api/platform/hub/title",
                    json={"thread_id": "thr_retitle", "title": "Archive retention policy"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "Archive retention policy"
    store = platform.get_store()
    assert store.get_thread("thr_retitle")["title"] == "Archive retention policy"
    patches = [e for e in store.list_events_after("thr_retitle", 0) if e["type"] == "thread.patch"]
    assert patches[-1]["payload"]["title"] == "Archive retention policy"


def test_title_404s_for_an_unknown_thread_and_never_creates_it():
    r = client.post("/api/platform/hub/title", json={"thread_id": "thr_ghost", "title": "New"}, headers=AUTH)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"
    assert platform.get_store().get_thread("thr_ghost") is None


def test_title_rejects_an_empty_oversized_or_malformed_request():
    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_title_bad"), headers=AUTH)
    for body in (
        {"thread_id": "thr_title_bad", "title": "   "},
        {"thread_id": "thr_title_bad", "title": "x" * 201},
        {"thread_id": "../etc/passwd", "title": "New"},
        {"thread_id": "thr_title_bad"},
        {"thread_id": "thr_title_bad", "title": "New", "kind": "ops"},
    ):
        assert client.post("/api/platform/hub/title", json=body, headers=AUTH).status_code == 422, body
    assert platform.get_store().get_thread("thr_title_bad")["title"] is None


def test_title_collapses_a_multi_line_proposal_to_one_row():
    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_title_lines"), headers=AUTH)
    r = client.post("/api/platform/hub/title",
                    json={"thread_id": "thr_title_lines", "title": "  Fast sleeve\n  gate  "}, headers=AUTH)
    assert r.json()["title"] == "Fast sleeve gate"


def test_title_review_lists_drifted_chat_threads_with_their_tail():
    client.post("/api/platform/hub/deliver",
                json=deliver_body(thread_id="thr_review_a", title="hello"), headers=AUTH)
    say("thr_review_a", "letf gate line", n=9)
    client.post("/api/platform/hub/deliver",
                json=deliver_body(thread_id="thr_review_ops", kind="ops", title="Ops"), headers=AUTH)
    say("thr_review_ops", "ops line", n=9)

    r = client.get("/api/platform/hub/title-review", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["min_messages"] == store_mod.TITLE_REVIEW_MIN_MESSAGES
    ids = [c["id"] for c in body["candidates"]]
    assert "thr_review_a" in ids
    assert "thr_review_ops" not in ids
    candidate = next(c for c in body["candidates"] if c["id"] == "thr_review_a")
    assert candidate["title"] == "hello"
    assert candidate["messages_since_title"] >= 9
    assert candidate["recent"][-1]["text"] == "letf gate line 8"


def test_title_review_bounds_its_page_and_its_threshold():
    r = client.get("/api/platform/hub/title-review?min_messages=0&limit=9999", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["min_messages"] == 1
    assert len(r.json()["candidates"]) <= platform.MAX_TITLE_REVIEW_LIMIT
    r = client.get("/api/platform/hub/title-review?min_messages=10000", headers=AUTH)
    assert r.json()["candidates"] == []


def test_reaffirming_a_title_clears_the_candidate_without_renaming_it():
    """The job's "still fits" answer — one POST per candidate per run, either way."""
    client.post("/api/platform/hub/deliver",
                json=deliver_body(thread_id="thr_review_keep", title="Fast sleeve"), headers=AUTH)
    say("thr_review_keep", "still about the sleeve", n=9)
    assert any(c["id"] == "thr_review_keep"
               for c in client.get("/api/platform/hub/title-review", headers=AUTH).json()["candidates"])
    r = client.post("/api/platform/hub/title",
                    json={"thread_id": "thr_review_keep", "title": "Fast sleeve"}, headers=AUTH)
    assert r.json()["title"] == "Fast sleeve"
    assert not any(c["id"] == "thr_review_keep"
                   for c in client.get("/api/platform/hub/title-review", headers=AUTH).json()["candidates"])


# --- the turn, not the stream, decides "working" --------------------------------------
def test_a_stream_delta_starts_the_turn_and_only_the_final_reply_ends_it():
    client.post("/api/platform/hub/stream",
                json={"thread_id": "thr_run", "run_id": "run-1", "delta": "thinking"}, headers=AUTH)
    assert platform.get_store().get_thread("thr_run")["status"] == "running"
    # A tool card mid-turn keeps it running.
    client.post("/api/platform/hub/deliver",
                json=deliver_body(thread_id="thr_run", run_id="run-1",
                                  parts=[{"type": "tool_call", "tool_call_id": "t1", "tool_name": "terminal",
                                          "status": "complete"}]), headers=AUTH)
    assert platform.get_store().get_thread("thr_run")["status"] == "running"
    # So does one stream's own final text, which is not the turn's.
    client.post("/api/platform/hub/deliver",
                json=deliver_body(thread_id="thr_run", run_id="run-1", parts=[{"type": "text", "text": "one moment"}]),
                headers=AUTH)
    assert platform.get_store().get_thread("thr_run")["status"] == "running"
    # The gateway's own reply carries `final` and ends it.
    client.post("/api/platform/hub/deliver",
                json=deliver_body(thread_id="thr_run", run_id="run-1", final=True,
                                  parts=[{"type": "text", "text": "Here is the answer."}]), headers=AUTH)
    assert platform.get_store().get_thread("thr_run")["status"] == "idle"


# --- a subagent's stop lands on its start --------------------------------------------
def _subagent_part(phase: str, **over) -> dict:
    part = {
        "type": "tool_call", "tool_call_id": "subagent:child-1", "tool_name": "delegate_task",
        "args": {"role": "leaf"}, "status": "running" if phase == "start" else "complete",
        "duration_ms": None if phase == "start" else 87_000,
        "subagent": {"child_session_id": "child-1", "child_role": "leaf", "phase": phase, "tool_call_count": None},
    }
    part.update(over)
    return part


def test_a_subagent_stop_lands_on_the_row_that_holds_its_start():
    client.post("/api/platform/hub/deliver",
                json=deliver_body(thread_id="thr_sub", run_id="run-p", parts=[_subagent_part("start")]), headers=AUTH)
    r = client.post("/api/platform/hub/deliver",
                    json=deliver_body(thread_id="thr_sub", run_id="run-p",
                                      parts=[_subagent_part("stop", result="found three things")]), headers=AUTH)
    assert r.json()["landed"] is True
    rows = platform.get_store().list_messages("thr_sub")
    assert len(rows) == 1
    (part,) = rows[0]["parts"]
    assert (part["status"], part["subagent"]["phase"], part["result"]) == ("complete", "stop", "found three things")
    last = platform.get_store().list_events_after("thr_sub", 0)[-1]
    assert last["type"] == "part.upsert" and last["payload"]["part"]["status"] == "complete"
    assert rows[0]["version"] == last["seq"]


def test_a_stop_with_no_start_on_record_is_its_own_row():
    r = client.post("/api/platform/hub/deliver",
                    json=deliver_body(thread_id="thr_sub2", run_id="run-q", parts=[_subagent_part("stop")]), headers=AUTH)
    assert "landed" not in r.json()
    assert len(platform.get_store().list_messages("thr_sub2")) == 1


# --- delivery ids: a retried request acts once ---------------------------------------
def test_a_repeated_delivery_id_is_answered_once_and_applied_once():
    body = deliver_body(thread_id="thr_idem", parts=[{"type": "text", "text": "only once"}], delivery_id="dlv-1")
    first = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    again = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert first.status_code == 200 and again.json() == first.json()
    assert len(platform.get_store().list_messages("thr_idem")) == 1


def test_a_repeated_stream_delta_is_appended_once():
    body = {"thread_id": "thr_idem2", "run_id": "run-i", "delta": "abc", "delivery_id": "dlv-s1"}
    first = client.post("/api/platform/hub/stream", json=body, headers=AUTH)
    again = client.post("/api/platform/hub/stream", json=body, headers=AUTH)
    assert again.json() == first.json()
    (row,) = platform.get_store().list_messages("thr_idem2")
    assert row["parts"][0]["text"] == "abc"


def test_a_repeated_close_is_answered_from_the_first():
    client.post("/api/platform/hub/stream", json={"thread_id": "thr_idem3", "run_id": "run-c", "delta": "abc"}, headers=AUTH)
    body = {"thread_id": "thr_idem3", "run_id": "run-c", "delivery_id": "dlv-c1"}
    first = client.post("/api/platform/hub/close", json=body, headers=AUTH)
    again = client.post("/api/platform/hub/close", json=body, headers=AUTH)
    assert first.json() == {"status": "ok", "closed": 1}
    assert again.json() == first.json()


def test_deliveries_without_an_id_are_applied_every_time():
    body = deliver_body(thread_id="thr_idem4", parts=[{"type": "widget", "kind": "metric", "props": {"label": "x", "value": "1"}}])
    client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert len(platform.get_store().list_messages("thr_idem4")) == 2
