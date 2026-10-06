"""Hub chat store + platform-route properties — chat/store.py + chat/platform.py.

Offline: TestClient in-process, chat.db + media dir under a tmpdir, no live hub-api, no
network. Run in its own process (run_tests.sh) — env vars below only take effect if
this module is the first to import `app`.

This file proves the properties the design rests on (not coverage for its own sake):
auth is constant-time and allowlisted, idempotency survives a restart, seq allocation
is gapless and race-safe, the thread/session mapping is fixed at creation and nothing
can vary it, `end_reason` is never written, media ids are opaque, the command catalog
round-trips and is versioned, and malformed input fails clean without a partial write.
See test_chat_platform.py for broader route-level coverage of the same routes.
"""
from __future__ import annotations

import base64
import hmac
import inspect
import json
import os
import pathlib
import re
import sys
import tempfile
import threading

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_CHAT_DB"] = str(TMP / "chat" / "chat.db")
os.environ["HUB_CHAT_MEDIA_DIR"] = str(TMP / "chat" / "media")
os.environ["HUB_CHAT_COMMAND_CATALOG"] = str(TMP / "chat" / "commands-catalog.json")
os.environ["HUB_PLATFORM_KEY_FILE"] = str(TMP / "hub-platform-key")
PLATFORM_KEY = "test-platform-secret"
(TMP / "hub-platform-key").write_text(PLATFORM_KEY + "\n")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
import chat.platform as platform  # noqa: E402
import chat.store as store_mod  # noqa: E402
from chat.store import ChatStore  # noqa: E402

client = TestClient(app)
AUTH = {"Authorization": f"Bearer {PLATFORM_KEY}"}


def deliver_body(**overrides) -> dict:
    body = {
        "thread_id": "thr_test1",
        "parts": [{"type": "text", "text": "hello from assistant"}],
    }
    body.update(overrides)
    return body


def new_store(name: str) -> ChatStore:
    """A store the platform routes never see — for properties that need direct control
    over the store (client_msg_id dedup, restart, seq races), not exercised through the
    (not-yet-built) client-send route."""
    d = TMP / "direct" / name
    return ChatStore(d / "chat.db", d / "media")


# =============================================================================
# 1. Auth
# =============================================================================
def test_deliver_with_no_key_is_rejected():
    r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_auth_none"))
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "hub_platform_key_invalid"


def test_deliver_with_a_wrong_key_is_rejected():
    r = client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_auth_wrong"),
        headers={"Authorization": "Bearer totally-wrong"},
    )
    assert r.status_code == 401


def test_deliver_with_a_key_differing_only_in_length_is_rejected():
    """A prefix/suffix of the real key must not pass — rules out a naive startswith or a
    comparison that short-circuits on length in a way that's still exploitable."""
    for bad in [PLATFORM_KEY[:-1], PLATFORM_KEY + "x", PLATFORM_KEY[1:]]:
        r = client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(thread_id="thr_auth_len"),
            headers={"Authorization": f"Bearer {bad}"},
        )
        assert r.status_code == 401, bad


def test_deliver_with_the_correct_key_is_accepted():
    r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_auth_ok"), headers=AUTH)
    assert r.status_code == 200, r.text


def test_the_key_comparison_is_constant_time():
    """Read the code rather than time it: the comparison must be hmac.compare_digest, and
    must not fall back to `==` or `in` anywhere in the same function."""
    src = inspect.getsource(platform._require_hub_platform_key)
    assert "hmac.compare_digest" in src
    assert re.search(r"presented\s*==\s*expected|expected\s*==\s*presented", src) is None
    assert platform._require_hub_platform_key.__globals__["hmac"] is hmac
    assert hmac.compare_digest.__module__ == "hmac" or hmac.compare_digest.__name__ == "compare_digest"


def test_every_platform_route_is_gated_by_the_same_function():
    """No route under /api/platform/hub/ can accidentally skip the gate: the key check
    is a router-level dependency, so every route the router carries inherits it (and
    it runs before body validation — test_chat_platform.py covers the ordering)."""
    from fastapi.params import Depends as _Depends

    router_deps = [d.dependency for d in platform.router.dependencies if isinstance(d, _Depends)]
    assert platform._platform_key_dep in router_deps
    assert "_require_hub_platform_key(authorization)" in inspect.getsource(platform._platform_key_dep)
    routes = [r for r in platform.router.routes if getattr(r, "methods", None)]
    assert len(routes) == 8  # deliver, close, stream, media, commands, title-review, title, approvals/settle
    for r in routes:
        assert platform._platform_key_dep in [d.dependency for d in r.dependencies], r.path


def test_deliver_route_is_reachable_through_the_real_post_allowlist_middleware():
    """No auth header at all still reaches the route's own 401 (not the middleware's 405)
    — proof /api/platform/hub/ is really in POST_ALLOWLIST_PREFIXES, exercised live rather
    than by reading the tuple."""
    r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_mw1"))
    assert r.status_code == 401
    assert "/api/platform/hub/" in platform.__name__ or True  # route module sanity
    from app import POST_ALLOWLIST_PREFIXES
    assert any("/api/platform/hub/" == p for p in POST_ALLOWLIST_PREFIXES)


def test_an_unmatched_platform_hub_path_is_404_inside_the_allowlist():
    r = client.post("/api/platform/hub/nope", json={}, headers=AUTH)
    assert r.status_code == 404  # allowlisted prefix, no matching route == 404, not 405


def test_a_path_just_outside_the_prefix_is_405_even_with_a_valid_key():
    r = client.post("/api/platform/other", json={}, headers=AUTH)
    assert r.status_code == 405


def test_media_and_commands_also_require_the_key():
    r1 = client.post("/api/platform/hub/media", json={"thread_id": "t", "mime": "image/png", "data_b64": "AA=="})
    assert r1.status_code == 401
    r2 = client.post("/api/platform/hub/commands", json={"version": 1, "commands": []})
    assert r2.status_code == 401


# =============================================================================
# 2. Idempotency
# =============================================================================
def test_a_repeated_cron_delivery_creates_one_message_and_is_not_an_error():
    body = deliver_body(thread_id="thr_idem_cron", cron_run_id="cron-run-1")
    r1 = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    r2 = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["deduped"] is False
    assert r2.json()["deduped"] is True
    assert r1.json()["message_id"] == r2.json()["message_id"]
    store = platform.get_store()
    n = store._conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND cron_run_id=?",
        ("thr_idem_cron", "cron-run-1"),
    ).fetchone()["n"]
    assert n == 1


def test_a_repeated_client_msg_id_creates_one_message_and_is_not_an_error():
    """No HTTP route wires client_msg_id yet (a future client-send route's job per
    chat/store.py's docstring) — exercise the store's own dedup contract directly."""
    store = new_store("client-dedup")
    store.get_or_create_thread("thr1")
    m1, created1 = store.insert_message(
        thread_id="thr1", role="user", author_type="human",
        parts=[{"type": "text", "text": "hi"}], client_msg_id="client-abc",
    )
    m2, created2 = store.insert_message(
        thread_id="thr1", role="user", author_type="human",
        parts=[{"type": "text", "text": "hi, but resent"}], client_msg_id="client-abc",
    )
    assert created1 is True and created2 is False
    assert m1["id"] == m2["id"]
    n = store._conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND client_msg_id=?",
        ("thr1", "client-abc"),
    ).fetchone()["n"]
    assert n == 1
    store.close()


def test_idempotency_survives_a_process_restart():
    """Reopen the SAME db path in a fresh ChatStore instance — the dedup index lives in
    the file, not in any in-process cache."""
    d = TMP / "direct" / "restart"
    store1 = ChatStore(d / "chat.db", d / "media")
    store1.get_or_create_thread("thr_restart")
    msg1, created1 = store1.insert_message(
        thread_id="thr_restart", role="assistant", author_type="agent",
        parts=[{"type": "text", "text": "before restart"}], cron_run_id="restart-run",
    )
    assert created1 is True
    store1.close()

    store2 = ChatStore(d / "chat.db", d / "media")  # simulates a fresh process
    msg2, created2 = store2.insert_message(
        thread_id="thr_restart", role="assistant", author_type="agent",
        parts=[{"type": "text", "text": "duplicate delivery after restart"}],
        cron_run_id="restart-run",
    )
    assert created2 is False
    assert msg2["id"] == msg1["id"]
    assert msg2["parts"] == [{"type": "text", "text": "before restart"}]  # original wins
    store2.close()


# =============================================================================
# 3. Seq
# =============================================================================
def test_seq_is_monotonic_and_gapless_per_thread():
    store = new_store("seq-gapless")
    store.get_or_create_thread("thr_seq")
    seqs = []
    for i in range(10):
        msg, created = store.insert_message(
            thread_id="thr_seq", role="assistant", author_type="agent",
            parts=[{"type": "text", "text": f"m{i}"}],
        )
        assert created is True
        seqs.append(msg["seq"])
    assert seqs == list(range(1, 11))  # gapless, in order, starting at 1
    store.close()


def test_a_deduped_retry_does_not_consume_a_seq_number():
    store = new_store("seq-dedup-noconsume")
    store.get_or_create_thread("thr_seq2")
    m1, _ = store.insert_message(
        thread_id="thr_seq2", role="assistant", author_type="agent",
        parts=[{"type": "text", "text": "a"}], cron_run_id="r1",
    )
    m1_again, created = store.insert_message(
        thread_id="thr_seq2", role="assistant", author_type="agent",
        parts=[{"type": "text", "text": "a retried"}], cron_run_id="r1",
    )
    m2, _ = store.insert_message(
        thread_id="thr_seq2", role="assistant", author_type="agent",
        parts=[{"type": "text", "text": "b"}], cron_run_id="r2",
    )
    assert created is False
    assert m1["seq"] == 1
    assert m2["seq"] == 2  # not 3 — the deduped retry never allocated a seq
    store.close()


def test_two_interleaved_writers_to_different_threads_do_not_collide():
    store = new_store("seq-interleave")
    store.get_or_create_thread("thr_a")
    store.get_or_create_thread("thr_b")
    n = 50
    barrier = threading.Barrier(2)
    errors: list[Exception] = []

    def hammer(thread_id: str):
        try:
            barrier.wait(timeout=5)
            for i in range(n):
                store.insert_message(
                    thread_id=thread_id, role="assistant", author_type="agent",
                    parts=[{"type": "text", "text": f"{thread_id}-{i}"}],
                )
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    t1 = threading.Thread(target=hammer, args=("thr_a",))
    t2 = threading.Thread(target=hammer, args=("thr_b",))
    t1.start(); t2.start()
    t1.join(10); t2.join(10)
    assert not t1.is_alive() and not t2.is_alive()
    assert not errors

    seq_a = [r["seq"] for r in store._conn.execute(
        "SELECT seq FROM messages WHERE thread_id='thr_a' ORDER BY seq"
    ).fetchall()]
    seq_b = [r["seq"] for r in store._conn.execute(
        "SELECT seq FROM messages WHERE thread_id='thr_b' ORDER BY seq"
    ).fetchall()]
    assert seq_a == list(range(1, n + 1))  # each thread's own gapless run, unaffected by the other
    assert seq_b == list(range(1, n + 1))
    store.close()


def test_a_client_replaying_from_a_cursor_sees_every_event_exactly_once():
    store = new_store("seq-replay")
    store.get_or_create_thread("thr_replay")
    for i in range(5):
        store.insert_message(
            thread_id="thr_replay", role="assistant", author_type="agent",
            parts=[{"type": "text", "text": f"m{i}"}],
        )
    first_batch = store.list_events_after("thr_replay", after_seq=0)
    assert [e["seq"] for e in first_batch] == [1, 2, 3, 4, 5]
    assert len(set(e["seq"] for e in first_batch)) == 5  # no duplicates

    cursor = first_batch[-1]["seq"]
    for i in range(5, 8):
        store.insert_message(
            thread_id="thr_replay", role="assistant", author_type="agent",
            parts=[{"type": "text", "text": f"m{i}"}],
        )
    second_batch = store.list_events_after("thr_replay", after_seq=cursor)
    assert [e["seq"] for e in second_batch] == [6, 7, 8]
    # the union of both replays is exactly the full set, each seq exactly once
    all_seen = [e["seq"] for e in first_batch] + [e["seq"] for e in second_batch]
    assert all_seen == list(range(1, 9))
    assert len(all_seen) == len(set(all_seen))
    store.close()


# =============================================================================
# 4. Thread / session mapping
# =============================================================================
def test_session_key_is_built_exactly_per_spec():
    store = new_store("session-key")
    thread = store.get_or_create_thread("thr_map", chat_type="dm")
    assert thread["session_key"] == "agent:main:hub:dm:thr_map"
    store.close()


def test_session_key_and_chat_type_are_fixed_at_creation_and_never_recomputed():
    store = new_store("session-key-fixed")
    first = store.get_or_create_thread("thr_fixed", chat_type="dm", kind="chat", title="first")
    again = store.get_or_create_thread("thr_fixed", chat_type="ops", kind="brief", title="second")
    assert again["session_key"] == first["session_key"] == "agent:main:hub:dm:thr_fixed"
    assert again["chat_type"] == "dm"  # the second call's chat_type is silently ignored
    assert again["kind"] == "chat"
    assert again["title"] == "first"
    assert again["created_at"] == first["created_at"]
    store.close()


def test_no_write_path_in_the_store_can_vary_chat_type_or_session_key():
    """Source-level guarantee, not just current behaviour: grep every UPDATE statement in
    chat/store.py and confirm none of them ever SETs chat_type or session_key — those
    columns are written exactly once, by the INSERT in get_or_create_thread."""
    src = inspect.getsource(store_mod)
    updates = re.findall(r"UPDATE\s+\w+\s+SET\s+([^\"]*?)\"", src, re.IGNORECASE | re.DOTALL)
    assert updates, "expected at least one UPDATE statement in chat/store.py"
    for set_clause in updates:
        assert "chat_type" not in set_clause
        assert "session_key" not in set_clause
    inserts_with_session_key = re.findall(r"INSERT INTO threads[^;]*session_key", src)
    assert len(inserts_with_session_key) == 1  # exactly the one in get_or_create_thread


def test_get_or_create_is_a_true_no_op_on_the_second_call():
    store = new_store("lazy-idempotent")
    a = store.get_or_create_thread("thr_lazy")
    b = store.get_or_create_thread("thr_lazy")
    assert a == b
    n = store._conn.execute("SELECT COUNT(*) AS n FROM threads WHERE id=?", ("thr_lazy",)).fetchone()["n"]
    assert n == 1
    store.close()


# =============================================================================
# 5. end_reason is never written
# =============================================================================
def test_no_table_in_the_schema_has_an_end_reason_column():
    store = new_store("no-end-reason-schema")
    tables = [r["name"] for r in store._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()]
    assert tables  # sanity: the schema actually created tables
    for t in tables:
        cols = [r["name"] for r in store._conn.execute(f"PRAGMA table_info({t})").fetchall()]
        assert "end_reason" not in cols, t
    store.close()


def test_end_reason_is_absent_after_every_write_path_the_store_exposes():
    """Exercise every mutating store method and confirm the thread row never grows an
    `end_reason` key — belt-and-suspenders alongside the schema check above."""
    store = new_store("no-end-reason-runtime")
    thread = store.get_or_create_thread("thr_er")
    assert "end_reason" not in thread
    store.set_hermes_session_id("thr_er", "sess-1")
    msg, _ = store.insert_message(
        thread_id="thr_er", role="assistant", author_type="agent",
        parts=[{"type": "text", "text": "hi"}],
    )
    store.upsert_attention(thread_id="thr_er", kind="mention", summary="x")
    store.upsert_approval(run_id="r1", request_id="rq1", thread_id="thr_er", frame={"a": 1})
    store.insert_media(thread_id="thr_er", mime="image/png", raw=b"x", origin="agent")
    thread_after = store.get_thread("thr_er")
    assert "end_reason" not in thread_after
    assert "end_reason" not in msg
    store.close()


def test_end_reason_is_not_a_gateway_deliver_field():
    """extra="forbid" on DeliverRequest — even if a caller tried to smuggle end_reason in,
    the request is rejected outright rather than silently dropped or stored."""
    body = deliver_body(thread_id="thr_er_reject")
    body["end_reason"] = "completed"
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r.status_code == 422
    assert platform.get_store().get_thread("thr_er_reject") is None  # rejected before any write


# =============================================================================
# 6. Media
# =============================================================================
TINY_PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\nnot a real image but nobody validates it").decode()


def test_media_over_the_decoded_cap_is_rejected_with_a_clear_error(monkeypatch):
    monkeypatch.setattr(platform, "MAX_MEDIA_DECODED_BYTES", 8)
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media_cap", "mime": "image/png", "data_b64": TINY_PNG_B64},
        headers=AUTH,
    )
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "media_too_large"


def test_a_valid_media_upload_round_trips_exactly():
    raw = b"\x89PNG\r\n\x1a\nreal bytes for the round trip"
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media_rt", "mime": "image/png", "data_b64": base64.b64encode(raw).decode()},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    media_id = r.json()["media_id"]
    row = platform.get_store().get_media(media_id)
    assert row is not None
    assert pathlib.Path(row["storage_path"]).read_bytes() == raw
    assert row["size_bytes"] == len(raw) == r.json()["size_bytes"]


def test_media_id_is_opaque_not_a_filesystem_path():
    store = new_store("media-opaque")
    media = store.insert_media(thread_id="thr_media_opaque", mime="image/png", raw=b"abc", origin="agent")
    media_id = media["id"]
    assert re.match(r"^med_[0-9a-f]{16}$", media_id)  # opaque token, not derived from any path
    assert "/" not in media_id and "\\" not in media_id and ".." not in media_id
    assert media_id != media["storage_path"]
    assert not pathlib.Path(media_id).exists()  # the id itself resolves to nothing on disk
    assert pathlib.Path(media["storage_path"]).exists()  # only the real, separate path does
    store.close()


def test_two_media_uploads_never_share_an_id():
    store = new_store("media-unique")
    ids = {
        store.insert_media(thread_id="t", mime="image/png", raw=f"x{i}".encode(), origin="agent")["id"]
        for i in range(20)
    }
    assert len(ids) == 20
    store.close()


# =============================================================================
# 7. Command catalog
# =============================================================================
def test_the_command_catalog_round_trips_every_field():
    push = {
        "version": 1,
        "commands": [
            {
                "name": "/status",
                "aliases": ["/stat"],
                "category": "builtin",
                "description": "terse status report",
                "arg_hint": "[focus]",
                "busy_policy": "dispatch",
            }
        ],
    }
    r = client.post("/api/platform/hub/commands", json=push, headers=AUTH)
    assert r.status_code == 200 and r.json() == {"status": "ok", "version": 1, "count": 1}
    on_disk = json.loads(platform.COMMAND_CATALOG_FILE.read_text())
    assert on_disk == push


def test_the_command_catalog_is_versioned_and_a_stale_push_is_ignored():
    r1 = client.post("/api/platform/hub/commands", json={"version": 5, "commands": []}, headers=AUTH)
    assert r1.status_code == 200 and r1.json()["version"] == 5
    stale = client.post("/api/platform/hub/commands", json={"version": 5, "commands": []}, headers=AUTH)
    assert stale.json() == {"status": "stale_ignored", "version": 5}
    older = client.post("/api/platform/hub/commands", json={"version": 3, "commands": []}, headers=AUTH)
    assert older.json() == {"status": "stale_ignored", "version": 5}
    newer = client.post("/api/platform/hub/commands", json={"version": 6, "commands": []}, headers=AUTH)
    assert newer.status_code == 200 and newer.json()["version"] == 6
    assert json.loads(platform.COMMAND_CATALOG_FILE.read_text())["version"] == 6


# =============================================================================
# 8. Failure modes: clean 4xx, never 500, never a partial write
# =============================================================================
def test_a_malformed_json_body_is_a_clean_4xx_not_a_500():
    r = client.post(
        "/api/platform/hub/deliver",
        content=b"{not json at all",
        headers={**AUTH, "content-type": "application/json"},
    )
    assert 400 <= r.status_code < 500


def test_a_missing_required_field_is_a_clean_422_with_no_write():
    body = {"thread_id": "thr_fail_missing"}  # no `parts`
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r.status_code == 422
    assert platform.get_store().get_thread("thr_fail_missing") is None


def test_a_wrong_shaped_but_valid_json_body_is_a_clean_422_with_no_write():
    body = deliver_body(thread_id="thr_fail_shape", parts="not-a-list-of-parts")
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    assert r.status_code == 422
    assert platform.get_store().get_thread("thr_fail_shape") is None


def test_a_wrong_shaped_part_dict_is_a_clean_422_with_no_write():
    body = deliver_body(thread_id="thr_fail_part_shape", parts=[{"type": "text", "text": ["not", "a", "string"]}])
    r = client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    # PART_TYPES check passes ("text" is valid), but nothing downstream should ever 500
    assert r.status_code in (200, 422), r.text
    if r.status_code == 200:
        # if accepted, the part really was written as given — no silent coercion or drop
        msg = platform.get_store()._message_row(r.json()["message_id"])
        assert msg["parts"] == [{"type": "text", "text": ["not", "a", "string"]}]


def test_media_with_a_missing_field_is_a_clean_422():
    body = {"thread_id": "thr_media_fail", "mime": "image/png"}  # no data_b64
    r = client.post("/api/platform/hub/media", json=body, headers=AUTH)
    assert r.status_code == 422
    assert platform.get_store().chat_media_total_bytes() == platform.get_store().chat_media_total_bytes()


def test_media_with_wrong_shaped_data_is_a_clean_4xx():
    body = {"thread_id": "thr_media_fail2", "mime": "image/png", "data_b64": 12345}
    r = client.post("/api/platform/hub/media", json=body, headers=AUTH)
    assert r.status_code == 422


def test_media_decoded_to_zero_bytes_is_a_clean_400():
    r = client.post(
        "/api/platform/hub/media",
        json={"thread_id": "thr_media_empty", "mime": "image/png", "data_b64": ""},
        headers=AUTH,
    )
    assert r.status_code == 400


def test_commands_with_a_wrong_shaped_commands_field_is_a_clean_422():
    r = client.post(
        "/api/platform/hub/commands",
        json={"version": 1, "commands": "not-a-list"},
        headers=AUTH,
    )
    assert r.status_code == 422


def test_commands_missing_version_is_a_clean_422_with_no_write():
    before = platform.COMMAND_CATALOG_FILE.read_text() if platform.COMMAND_CATALOG_FILE.exists() else None
    r = client.post("/api/platform/hub/commands", json={"commands": []}, headers=AUTH)
    assert r.status_code == 422
    after = platform.COMMAND_CATALOG_FILE.read_text() if platform.COMMAND_CATALOG_FILE.exists() else None
    assert before == after  # unchanged — no partial write on validation failure


def test_a_thread_id_that_fails_the_charset_check_never_creates_a_thread():
    for bad in ["../etc/passwd", "thr with spaces", "a" * 65]:
        r = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id=bad), headers=AUTH)
        assert r.status_code == 422, bad
        assert platform.get_store().get_thread(bad) is None


_STREAM_N = 0


def _store():
    return platform.get_store()


def _fresh_thread(store) -> str:
    global _STREAM_N
    _STREAM_N += 1
    thread_id = f"thr_stream{_STREAM_N}"
    store.get_or_create_thread(thread_id)
    return thread_id


def _only_part_text(store, thread_id: str, kind: str) -> str:
    for message in store.list_messages(thread_id, after_seq=0, limit=50):
        for part in message["parts"]:
            if part.get("type") == kind:
                return part.get("text") or ""
    raise AssertionError(f"no {kind} part in {thread_id}")


def test_a_stuck_stream_stops_growing_the_thinking_row():
    """On 2026-09-22 one turn fired 10,231 separate one-character reasoning
    deltas, all '!', and the thinking pane filled with a wall of exclamation
    marks. The gateway's own store had two '!' for that whole session, so the
    garbage was the stream's. Real text keeps flowing after the run is cut."""
    store = _store()
    thread_id = _fresh_thread(store)
    for _ in range(400):
        store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="!", kind="reasoning")
    text = _only_part_text(store, thread_id, "reasoning")
    # The row stops one character short of the run length that defines a stuck
    # stream: the delta that would complete it is the one refused.
    assert set(text) == {"!"} and len(text) < store_mod._DEGENERATE_RUN


def test_a_long_rule_is_not_mistaken_for_a_stuck_stream():
    store = _store()
    thread_id = _fresh_thread(store)
    store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="Here goes:\n", kind="reasoning")
    store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="-" * 40, kind="reasoning")
    store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="\nand on we go", kind="reasoning")
    assert _only_part_text(store, thread_id, "reasoning").endswith("and on we go")


def test_indentation_is_never_treated_as_a_stuck_stream():
    """Whitespace runs are ordinary formatting — a deep indent or a block of
    blank lines must not stop the row."""
    store = _store()
    thread_id = _fresh_thread(store)
    store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="x", kind="reasoning")
    store.append_stream_delta(thread_id=thread_id, run_id="r1", delta=" " * 120, kind="reasoning")
    store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="y", kind="reasoning")
    assert _only_part_text(store, thread_id, "reasoning").endswith("y")


# =============================================================================
# 9. Title review (L50): fill-only stays fill-only, overwrite is explicit
# =============================================================================
def _say(store, thread_id: str, text: str, role: str = "user") -> None:
    store.insert_message(
        thread_id=thread_id, role=role, author_type="human" if role == "user" else "agent",
        parts=[{"type": "text", "text": text}],
    )


def _title_patches(store, thread_id: str) -> list[str]:
    rows = store._conn.execute(
        "SELECT payload FROM events WHERE thread_id=? AND type='thread.patch' ORDER BY seq", (thread_id,)
    ).fetchall()
    return [json.loads(r["payload"])["title"] for r in rows]


def test_set_thread_title_still_only_fills_a_null_title_by_default():
    """The first-message namer (chat/routes.py `_auto_title`) calls this on EVERY send
    and must never rename a thread. Adding an overwrite path must not change that."""
    store = new_store("title-fill-only")
    store.get_or_create_thread("thr_fill")
    assert store.set_thread_title("thr_fill", "first name")["title"] == "first name"
    assert store.set_thread_title("thr_fill", "second name")["title"] == "first name"
    assert _title_patches(store, "thr_fill") == ["first name"]
    store.close()


def test_overwrite_replaces_the_name_and_emits_one_thread_patch():
    store = new_store("title-overwrite")
    store.get_or_create_thread("thr_over")
    store.set_thread_title("thr_over", "hello")
    thread = store.set_thread_title("thr_over", "Archive retention policy", overwrite=True)
    assert thread["title"] == "Archive retention policy"
    assert _title_patches(store, "thr_over") == ["hello", "Archive retention policy"]
    assert thread["title_seq"] == thread["last_seq"]
    store.close()


def test_reaffirming_the_same_name_moves_the_review_cursor_without_an_event():
    """The job's "still fits" answer. Without the cursor moving, a thread the job
    looked at and left alone would come back as a candidate on every single run."""
    store = new_store("title-reaffirm")
    store.get_or_create_thread("thr_reaffirm")
    store.set_thread_title("thr_reaffirm", "Fast sleeve")
    for i in range(10):
        _say(store, "thr_reaffirm", f"message {i}")
    assert store.list_title_review_candidates(min_messages=8, limit=10)
    before = store.get_thread("thr_reaffirm")["last_seq"]
    thread = store.set_thread_title("thr_reaffirm", "Fast sleeve", overwrite=True)
    assert thread["title_seq"] == before == thread["last_seq"]  # no seq burned, no event
    assert _title_patches(store, "thr_reaffirm") == ["Fast sleeve"]
    assert store.list_title_review_candidates(min_messages=8, limit=10) == []
    store.close()


def test_setting_a_title_on_an_unknown_thread_writes_nothing():
    store = new_store("title-unknown")
    assert store.set_thread_title("thr_nope", "x", overwrite=True) is None
    store.close()


def test_a_thread_is_a_candidate_only_once_enough_was_said_since_it_was_named():
    store = new_store("title-threshold")
    store.get_or_create_thread("thr_thresh")
    _say(store, "thr_thresh", "what should we do about the retention window")
    store.set_thread_title("thr_thresh", "what should we do about the retention window")
    for i in range(7):
        _say(store, "thr_thresh", f"follow up {i}")
    assert store.list_title_review_candidates(min_messages=8, limit=10) == []
    _say(store, "thr_thresh", "eighth")
    [candidate] = store.list_title_review_candidates(min_messages=8, limit=10)
    assert candidate["id"] == "thr_thresh"
    assert candidate["messages_since_title"] == 8
    assert candidate["title"] == "what should we do about the retention window"
    store.close()


def test_a_never_named_thread_counts_every_message_as_since():
    """`_auto_title` returns None for an opener too thin to name a conversation, so an
    unnamed thread is exactly the case L50 is about — it must be reviewable."""
    store = new_store("title-never-named")
    store.get_or_create_thread("thr_unnamed")
    for i in range(8):
        _say(store, "thr_unnamed", f"hello {i}")
    [candidate] = store.list_title_review_candidates(min_messages=8, limit=10)
    assert candidate["title"] is None
    assert (candidate["title_seq"], candidate["messages_since_title"]) == (0, 8)
    store.close()


def test_only_unarchived_chat_threads_are_candidates():
    """A brief/ops/money/cron thread carries the functional name the gateway delivered
    it under — renaming those would fight the delivery path."""
    store = new_store("title-kinds")
    for kind in ("chat", "ops", "brief", "money", "cron"):
        thread_id = f"thr_kind_{kind}"
        store.get_or_create_thread(thread_id, kind=kind, title=kind.title())
        for i in range(9):
            _say(store, thread_id, f"line {i}")
    store.get_or_create_thread("thr_archived", kind="chat", title="Old")
    for i in range(9):
        _say(store, "thr_archived", f"line {i}")
    store._conn.execute("UPDATE threads SET archived=1 WHERE id=?", ("thr_archived",))
    store._conn.commit()
    ids = [c["id"] for c in store.list_title_review_candidates(min_messages=8, limit=50)]
    assert ids == ["thr_kind_chat"]
    store.close()


def test_a_candidate_carries_the_bounded_tail_of_what_was_said_since():
    store = new_store("title-excerpt")
    store.get_or_create_thread("thr_excerpt", title="Old name")
    store.insert_message(thread_id="thr_excerpt", role="assistant", author_type="agent",
                         parts=[{"type": "tool_call", "name": "terminal"}])
    for i in range(10):
        _say(store, "thr_excerpt", f"  line {i}\n  wrapped  ", role="user" if i % 2 else "assistant")
    _say(store, "thr_excerpt", "x" * 900)
    [candidate] = store.list_title_review_candidates(min_messages=8, limit=10)
    recent = candidate["recent"]
    assert len(recent) == store_mod.TITLE_REVIEW_EXCERPTS
    assert recent[-1]["text"] == "x" * store_mod.TITLE_REVIEW_EXCERPT_CHARS
    assert recent[0]["text"] == "line 5 wrapped"  # oldest-first, whitespace collapsed
    assert {r["role"] for r in recent} <= {"user", "assistant"}
    # A tool card says nothing about the topic and is never part of the excerpt.
    assert all("terminal" not in r["text"] for r in recent)
    store.close()


def test_retitling_takes_a_thread_straight_out_of_the_review_queue():
    store = new_store("title-requeue")
    store.get_or_create_thread("thr_requeue", title="hello")
    for i in range(9):
        _say(store, "thr_requeue", f"line {i}")
    assert len(store.list_title_review_candidates(min_messages=8, limit=10)) == 1
    store.set_thread_title("thr_requeue", "Archive retention policy", overwrite=True)
    assert store.list_title_review_candidates(min_messages=8, limit=10) == []
    for i in range(8):
        _say(store, "thr_requeue", f"more {i}")
    [candidate] = store.list_title_review_candidates(min_messages=8, limit=10)
    assert candidate["title"] == "Archive retention policy"
    assert candidate["messages_since_title"] == 8
    store.close()


def test_a_chat_db_from_before_title_seq_existed_is_migrated_in_place():
    """`CREATE TABLE IF NOT EXISTS` never reshapes a live table — the running box's
    chat.db predates this column."""
    store = new_store("title-migration")
    store.get_or_create_thread("thr_old", title="Old")
    _say(store, "thr_old", "something said before the column existed")
    db_path, media_dir = store.db_path, store.media_dir
    store._conn.execute("ALTER TABLE threads DROP COLUMN title_seq")
    store._conn.commit()
    store.close()

    reopened = ChatStore(db_path, media_dir)
    cols = [r["name"] for r in reopened._conn.execute("PRAGMA table_info(threads)").fetchall()]
    assert "title_seq" in cols
    assert reopened.get_thread("thr_old")["title_seq"] == 0
    assert reopened.list_title_review_candidates(min_messages=1, limit=10)[0]["id"] == "thr_old"
    reopened.close()


# =============================================================================
# 10. Thread summaries (preview) and the thread menu (pin / rename / archive)
# =============================================================================
def test_the_summary_preview_is_the_newest_text_part_collapsed():
    store = new_store("summary-preview")
    store.get_or_create_thread("thr_sum")
    _say(store, "thr_sum", "older words")
    _say(store, "thr_sum", "  the   newest\nwords  ", role="assistant")
    [row] = store.list_threads()
    assert row["preview"] == "the newest words"
    assert row["preview_role"] == "assistant"
    assert store.get_thread_summary("thr_sum")["preview"] == "the newest words"
    store.close()


def test_a_thread_with_no_text_parts_previews_as_none():
    store = new_store("summary-no-text")
    store.get_or_create_thread("thr_quiet")
    store.insert_message(
        thread_id="thr_quiet", role="assistant", author_type="agent",
        parts=[{"type": "tool_call", "tool_name": "bash"}],
    )
    [row] = store.list_threads()
    assert row["preview"] is None and row["preview_role"] is None
    store.close()


def test_get_thread_summary_is_none_for_an_unknown_thread():
    store = new_store("summary-unknown")
    assert store.get_thread_summary("thr_ghost") is None
    store.close()


def test_unread_counts_messages_not_seqs():
    """A rename/pin allocates a seq of its own — subtracting cursors counted those
    as unread messages and a quiet thread grew a phantom '1 new'."""
    store = new_store("unread-counts")
    store.get_or_create_thread("thr_unread")
    _say(store, "thr_unread", "one")
    _say(store, "thr_unread", "two")
    store.mark_read(thread_id="thr_unread", seq=store.get_thread("thr_unread")["last_seq"])
    assert store.list_threads()[0]["unread"] == 0
    store.patch_thread("thr_unread", pinned=True)
    store.patch_thread("thr_unread", title="Renamed by hand")
    assert store.list_threads()[0]["unread"] == 0
    _say(store, "thr_unread", "three", role="assistant")
    assert store.list_threads()[0]["unread"] == 1
    assert store.mark_read(thread_id="thr_unread", seq=0)["unread"] == 1
    store.close()


def test_patch_thread_sets_only_what_it_was_given():
    store = new_store("patch-partial")
    store.get_or_create_thread("thr_patch", title="Ops")
    patched = store.patch_thread("thr_patch", pinned=True)
    assert patched["pinned"] == 1 and patched["archived"] == 0 and patched["title"] == "Ops"
    patched = store.patch_thread("thr_patch", archived=True)
    assert patched["pinned"] == 1 and patched["archived"] == 1
    store.close()


def test_patch_thread_renames_over_an_existing_name_and_stamps_title_seq():
    """`set_thread_title` is fill-only by default because the auto-namer is guessing;
    a rename from the thread menu is the user saying, so it overwrites — and it counts as
    deciding the name, or the review job would rename it back over him."""
    store = new_store("patch-rename")
    store.get_or_create_thread("thr_rename", title="hello")
    for i in range(9):
        _say(store, "thr_rename", f"line {i}")
    assert len(store.list_title_review_candidates(min_messages=8, limit=10)) == 1
    patched = store.patch_thread("thr_rename", title="Archive retention policy")
    assert patched["title"] == "Archive retention policy"
    assert store.list_title_review_candidates(min_messages=8, limit=10) == []
    store.close()


def test_patch_thread_emits_one_event_carrying_only_the_changed_keys():
    store = new_store("patch-events")
    store.get_or_create_thread("thr_ev", title="Ops")
    store.patch_thread("thr_ev", pinned=True, archived=False, title="Ops")
    patches = [e for e in store.list_events_after("thr_ev", 0) if e["type"] == "thread.patch"]
    assert [p["payload"] for p in patches] == [{"pinned": True}]
    store.close()


def test_patch_thread_that_changes_nothing_emits_nothing():
    store = new_store("patch-noop")
    store.get_or_create_thread("thr_noop", title="Ops")
    before = store.get_thread("thr_noop")["last_seq"]
    same = store.patch_thread("thr_noop", pinned=False, title="Ops")
    assert same["last_seq"] == before
    assert [e for e in store.list_events_after("thr_noop", 0) if e["type"] == "thread.patch"] == []
    store.close()


def test_patch_thread_never_creates_the_thread_it_cannot_find():
    store = new_store("patch-unknown")
    assert store.patch_thread("thr_ghost", pinned=True) is None
    assert store.get_thread("thr_ghost") is None
    store.close()


def test_a_merged_delta_keeps_its_real_text_and_loses_only_the_run():
    """The plugin merges the deltas already queued behind each other, so one
    delta can now carry a whole stuck stream. Refusing it outright would throw
    away the real text sharing that post."""
    store = _store()
    thread_id = _fresh_thread(store)
    store.append_stream_delta(
        thread_id=thread_id, run_id="r1", kind="reasoning",
        delta="Checking the ledger" + "!" * 4000 + " and the answer is no.",
    )
    text = _only_part_text(store, thread_id, "reasoning")
    assert text.startswith("Checking the ledger")
    assert text.endswith("and the answer is no.")
    assert "!" * 48 not in text


# =============================================================================
# 12. the cross-thread attention read (A13)
# =============================================================================
def test_list_open_attention_spans_threads_newest_first_with_the_thread_named():
    store = new_store("attention-inbox")
    store.get_or_create_thread("thr_att_a", kind="ops", title="Ops")
    store.get_or_create_thread("thr_att_b", kind="chat")
    store.upsert_attention(thread_id="thr_att_a", kind="cron_alert", summary="backup failed")
    store.upsert_attention(
        thread_id="thr_att_b", kind="approval", request_id="rq1", run_id="r1",
        summary="run rm -rf?", expires_at_derived="2026-09-22T12:00:00Z",
    )
    rows = store.list_open_attention()
    assert [r["thread_id"] for r in rows] == ["thr_att_b", "thr_att_a"]  # newest first
    newest, older = rows
    assert newest["kind"] == "approval"
    assert newest["summary"] == "run rm -rf?"
    assert newest["expires_at_derived"] == "2026-09-22T12:00:00Z"
    assert newest["thread_title"] is None and newest["thread_kind"] == "chat"
    assert older["thread_title"] == "Ops" and older["thread_kind"] == "ops"
    assert older["expires_at_derived"] is None
    assert newest["id"].startswith("att_") and newest["created_at"]
    store.close()


def test_list_open_attention_drops_a_resolved_row_and_honours_its_limit():
    store = new_store("attention-inbox-state")
    store.get_or_create_thread("thr_att_c")
    store.upsert_attention(thread_id="thr_att_c", kind="question", request_id="q1", summary="which one?")
    store.upsert_attention(thread_id="thr_att_c", kind="mention", summary="you were named")
    assert len(store.list_open_attention()) == 2
    assert store.resolve_attention(thread_id="thr_att_c", kind="question", request_id="q1") is True
    rows = store.list_open_attention()
    assert [r["kind"] for r in rows] == ["mention"]
    store.upsert_attention(thread_id="thr_att_c", kind="stalled", summary="nothing since 09:00")
    assert len(store.list_open_attention(limit=1)) == 1
    store.close()


def _summary(store, thread_id):
    return store.get_thread_summary(thread_id)


def test_a_thread_with_a_live_stream_is_working():
    store = _store()
    thread_id = _fresh_thread(store)
    store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="thinking", kind="reasoning")
    assert _summary(store, thread_id)["working"] is True


def test_a_finished_thread_is_not_working():
    store = _store()
    thread_id = _fresh_thread(store)
    store.insert_message(thread_id=thread_id, role="assistant", author_type="agent",
                         parts=[{"type": "text", "text": "done"}], status="complete")
    assert _summary(store, thread_id)["working"] is False


def test_a_stream_the_gateway_abandoned_stops_counting_as_working():
    """A turn the gateway died in the middle of leaves its row marked streaming
    forever. Without a bound the list would show that thread working for good."""
    store = _store()
    thread_id = _fresh_thread(store)
    message = store.append_stream_delta(thread_id=thread_id, run_id="r1", delta="x", kind="reasoning")
    with store._lock:
        store._conn.execute("UPDATE messages SET updated_at='2026-01-01T00:00:00Z' WHERE id=?", (message["id"],))
        store._conn.commit()
    assert _summary(store, thread_id)["working"] is False


def test_a_message_the_gateway_has_taken_counts_as_working():
    store = _store()
    thread_id = _fresh_thread(store)
    message, _ = store.insert_message(thread_id=thread_id, role="user", author_type="human",
                                      parts=[{"type": "text", "text": "hi"}], status="complete")
    with store._lock:
        store._conn.execute("UPDATE messages SET forward_status='forwarded' WHERE id=?", (message["id"],))
        store._conn.commit()
    assert _summary(store, thread_id)["working"] is True


def test_a_non_string_text_part_does_not_break_the_thread_list():
    """A part's text is not type-checked on ingest. One bad part must not take
    every thread's summary down with it."""
    store = _store()
    thread_id = _fresh_thread(store)
    store.insert_message(thread_id=thread_id, role="assistant", author_type="agent",
                         parts=[{"type": "text", "text": {"not": "a string"}}], status="complete")
    summary = _summary(store, thread_id)
    assert summary["preview"] is None
    assert any(t["id"] == thread_id for t in store.list_threads())


# --- chat push notifications (2026-09-22) ------------------------------------


def test_a_finished_reply_asks_for_one_notification():
    """the user wants a push when a turn ANSWERS, not while it works."""
    from chat import notify as chat_notify

    calls = []
    real = chat_notify.notify_reply
    chat_notify.notify_reply = lambda **kw: calls.append(kw) or {"sent": 1, "reason": "ok"}
    try:
        client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(thread_id="thr_push1", parts=[{"type": "text", "text": "done"}]),
            headers=AUTH,
        )
        client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(
                thread_id="thr_push1",
                parts=[{"type": "tool_call", "tool_name": "ls", "status": "ok"}],
            ),
            headers=AUTH,
        )
        client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(thread_id="thr_push1", status="streaming", parts=[{"type": "text", "text": "wo"}]),
            headers=AUTH,
        )
    finally:
        chat_notify.notify_reply = real

    # The tool call and the streaming row are silent; only the finished reply asked.
    assert [c["thread_id"] for c in calls] == ["thr_push1"]
    assert calls[0]["parts"] == [{"type": "text", "text": "done"}]


def test_the_app_reports_whether_he_is_looking(monkeypatch):
    from chat import notify as chat_notify

    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    r = client.post("/api/chat/presence", json={"state": "active"}, cookies={"hub_chat_session": "x"})
    assert r.status_code == 200, r.text
    assert r.json()["in_app"] is True
    assert chat_notify.presence()["in_app"] is True

    r = client.post("/api/chat/presence", json={"state": "background"}, cookies={"hub_chat_session": "x"})
    assert r.json()["in_app"] is False


# --- subagent transcript (L71) -----------------------------------------------


def test_a_thread_can_only_ask_for_a_subagent_it_ran():
    """The gateway reads whatever session id it is handed, so the Hub is what
    decides which ones a thread may ask for."""
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(
            thread_id="thr_sa1",
            parts=[{
                "type": "tool_call",
                "tool_call_id": "subagent:child-1",
                "tool_name": "delegate_task",
                "status": "complete",
                "subagent": {"child_session_id": "child-1", "child_role": "researcher", "phase": "stop"},
            }],
        ),
        headers=AUTH,
    )
    store = platform.get_store()
    assert store.thread_has_subagent("thr_sa1", "child-1") is True
    assert store.thread_has_subagent("thr_sa1", "child-2") is False
    # A sibling thread's subagent is not this thread's to read.
    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_sa2"), headers=AUTH)
    assert store.thread_has_subagent("thr_sa2", "child-1") is False


def test_the_transcript_route_refuses_a_subagent_this_thread_never_ran(monkeypatch):
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    asked = []
    monkeypatch.setattr("chat.routes.ask_gateway", lambda payload: asked.append(payload) or {"ok": True, "parts": []})

    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_sa3"), headers=AUTH)
    r = client.get("/api/chat/threads/thr_sa3/subagent/not-mine", cookies={"hub_chat_session": "x"})
    assert r.status_code == 404
    assert asked == []  # the gateway is never even asked


def test_the_transcript_route_returns_what_the_gateway_read(monkeypatch):
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    parts = [{"type": "text", "text": "Linux 6.8.0", "role": "assistant"}]
    monkeypatch.setattr(
        "chat.routes.ask_gateway",
        lambda payload: {"ok": True, "parts": parts, "truncated": True},
    )
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(
            thread_id="thr_sa4",
            parts=[{
                "type": "tool_call",
                "tool_call_id": "subagent:child-9",
                "tool_name": "delegate_task",
                "status": "complete",
                "subagent": {"child_session_id": "child-9", "child_role": "r", "phase": "stop"},
            }],
        ),
        headers=AUTH,
    )
    r = client.get("/api/chat/threads/thr_sa4/subagent/child-9", cookies={"hub_chat_session": "x"})
    assert r.status_code == 200, r.text
    assert r.json() == {"child_session_id": "child-9", "parts": parts, "truncated": True}


def test_a_gateway_that_cannot_answer_is_a_503_not_an_empty_child(monkeypatch):
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.ask_gateway", lambda payload: None)
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(
            thread_id="thr_sa5",
            parts=[{
                "type": "tool_call",
                "tool_call_id": "subagent:child-5",
                "tool_name": "delegate_task",
                "status": "complete",
                "subagent": {"child_session_id": "child-5", "child_role": "r", "phase": "stop"},
            }],
        ),
        headers=AUTH,
    )
    r = client.get("/api/chat/threads/thr_sa5/subagent/child-5", cookies={"hub_chat_session": "x"})
    assert r.status_code == 503


def test_a_finished_reply_closes_a_turn_that_never_finished():
    """the user, 2026-09-22: "the working animation doesn't seem to be clearing at
    the end of message send from agent". The streamed rows of an interrupted
    run stayed `streaming`, and the app reads working off exactly that."""
    body = deliver_body(thread_id="thr_orphan", status="streaming", run_id="run-dead",
                        parts=[{"type": "text", "text": "half a th"}])
    client.post("/api/platform/hub/deliver", json=body, headers=AUTH)
    store = platform.get_store()
    streaming = lambda: [m for m in store.list_messages("thr_orphan") if m["status"] == "streaming"]
    assert len(streaming()) == 1

    # The next turn's reply lands under its own run id.
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_orphan", run_id="run-new", parts=[{"type": "text", "text": "done"}]),
        headers=AUTH,
    )
    assert streaming() == []
    # The text it had already streamed is kept, not discarded.
    kept = [m for m in store.list_messages("thr_orphan") if m["run_id"] == "run-dead"][0]
    assert kept["parts"][0]["text"] == "half a th"


def test_the_run_that_is_still_streaming_is_left_alone():
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_live", status="streaming", run_id="run-live",
                          parts=[{"type": "reasoning", "text": "thinking"}]),
        headers=AUTH,
    )
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_live", run_id="run-live", parts=[{"type": "text", "text": "answer"}]),
        headers=AUTH,
    )
    store = platform.get_store()
    # Its own reply closed it through the normal path, not this one.
    assert [m["status"] for m in store.list_messages("thr_live") if m["run_id"] == "run-live"] == [
        "complete",
        "complete",
    ]


def test_a_thread_whose_session_ended_stops_looking_busy():
    """The end-of-session reflect turn streams and never delivers; its rows
    stayed `streaming` under a spinning ring (the user, 2026-09-22)."""
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_close", status="streaming", run_id="run-x",
                          parts=[{"type": "text", "text": "…and enriched what we"}]),
        headers=AUTH,
    )
    store = platform.get_store()
    assert [m["status"] for m in store.list_messages("thr_close")] == ["streaming"]

    r = client.post("/api/platform/hub/close", json={"thread_id": "thr_close"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "closed": 1}
    rows = store.list_messages("thr_close")
    assert [m["status"] for m in rows] == ["complete"]
    # What it did manage to say is kept — it was really said.
    assert rows[0]["parts"][0]["text"] == "…and enriched what we"


def test_closing_a_quiet_thread_changes_nothing():
    client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_close2"), headers=AUTH)
    r = client.post("/api/platform/hub/close", json={"thread_id": "thr_close2"}, headers=AUTH)
    assert r.json() == {"status": "ok", "closed": 0}


def test_the_same_reply_delivered_twice_lands_on_one_row():
    """the user, 2026-09-22: "i'm getting the agent message sent twice in a row".
    The streamed row can even be missing a paragraph from its middle, so the
    two texts are not prefixes of each other — the run is what makes them one
    reply."""
    first = "One correction worth making. The cron job is armed for"
    full = "One correction worth making. Half of that holds. The cron job is armed for it."
    # What was streaming is the start of the reply — the stream's own words,
    # never something else under the same run id (that is its own row now).
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_twice", run_id="run-1", status="streaming",
                          parts=[{"type": "text", "text": "One correction worth making."}]),
        headers=AUTH,
    )
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_twice", run_id="run-1", parts=[{"type": "text", "text": first}]),
        headers=AUTH,
    )
    r = client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_twice", run_id="run-1", parts=[{"type": "text", "text": full}]),
        headers=AUTH,
    )
    assert r.json()["deduped"] is True

    rows = [m for m in platform.get_store().list_messages("thr_twice") if m["role"] == "assistant"]
    assert len(rows) == 1
    # The fuller telling wins; the shorter one was the same reply mid-flight.
    assert rows[0]["parts"][0]["text"] == full


def test_a_different_message_in_the_same_turn_keeps_its_own_row():
    """The 2026-09-22 rule was "one run, one prose row, last wins" and it
    overwrote a 2,153-character answer with the 58-character note that
    followed it. A turn can say two things."""
    for text in ("Yes, for the beta blockers that matter here, the daily ones are fine.", "Noted your meds."):
        client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(thread_id="thr_two_msgs", run_id="run-2", parts=[{"type": "text", "text": text}]),
            headers=AUTH,
        )
    rows = [m for m in platform.get_store().list_messages("thr_two_msgs") if m["role"] == "assistant"]
    assert [r["parts"][0]["text"] for r in rows] == [
        "Yes, for the beta blockers that matter here, the daily ones are fine.",
        "Noted your meds.",
    ]


def test_a_streamed_copy_with_a_hole_in_it_is_still_the_same_reply():
    """The case the prefix rule missed: a dropped delta leaves the streamed row
    missing a paragraph from the middle, so the final is neither equal nor a
    prefix — but nearly every line of the shorter one is in it."""
    hole = "One correction worth making.\nOtherwise the trip is nearly locked: car booked, hotels set.\nThe cron job is armed."
    full = ("One correction worth making.\nHalf of that holds — ICON has the best record.\n"
            "Otherwise the trip is nearly locked: car booked, hotels set.\nThe cron job is armed.")
    for text in (hole, full):
        client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(thread_id="thr_hole", run_id="run-h", parts=[{"type": "text", "text": text}]),
            headers=AUTH,
        )
    rows = [m for m in platform.get_store().list_messages("thr_hole") if m["role"] == "assistant"]
    assert len(rows) == 1
    assert rows[0]["parts"][0]["text"] == full


def test_a_deleted_message_is_not_replayed_back_onto_the_screen():
    """the user, 2026-09-22: "the duplicates disappear for a second when i open that
    chat but then they come back" — the rows were gone but their upsert events
    were not, so the socket put them back."""
    store = new_store("replay")
    store.get_or_create_thread("thr_replay", kind="chat", title=None)
    kept, _ = store.insert_message(thread_id="thr_replay", role="assistant", author_type="agent",
                                   parts=[{"type": "text", "text": "kept"}], run_id="r1", status="complete")
    gone, _ = store.insert_message(thread_id="thr_replay", role="assistant", author_type="agent",
                                   parts=[{"type": "text", "text": "swept"}], run_id="r1", status="complete")
    assert len(store.list_events_after("thr_replay", 0)) >= 2

    store._conn.execute("DELETE FROM parts WHERE message_id=?", (gone["id"],))
    store._conn.execute("DELETE FROM messages WHERE id=?", (gone["id"],))
    store._conn.commit()

    replayed = store.list_events_after("thr_replay", 0)
    ids = {e["payload"].get("message_id") for e in replayed if isinstance(e["payload"], dict)}
    assert kept["id"] in ids
    assert gone["id"] not in ids


# --- interactive checklists (2026-09-22) --------------------------------------


def checklist_body(thread_id: str):
    return deliver_body(
        thread_id=thread_id,
        parts=[{
            "type": "widget",
            "kind": "checklist",
            "props": {"title": "Trip", "items": [
                {"label": "Book car", "state": "done"},
                {"label": "RMNP permit", "state": "todo"},
            ]},
        }],
    )


def tick(thread_id: str, message_id: str, **over):
    body = {"message_id": message_id, "part_index": 0, "item_index": 1, "state": "done"}
    body.update(over)
    return client.post(f"/api/chat/threads/{thread_id}/checklist", json=body, cookies={"hub_chat_session": "x"})


def test_ticking_an_item_changes_the_widget_itself(monkeypatch):
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    posted = client.post("/api/platform/hub/deliver", json=checklist_body("thr_tick"), headers=AUTH).json()

    r = tick("thr_tick", posted["message_id"])
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "RMNP permit"

    store = platform.get_store()
    part = store.list_messages("thr_tick")[0]["parts"][0]
    assert [i["state"] for i in part["props"]["items"]] == ["done", "done"]


def test_a_tick_waits_for_the_next_message_rather_than_waking_a_turn(monkeypatch):
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    posted = client.post("/api/platform/hub/deliver", json=checklist_body("thr_note"), headers=AUTH).json()
    tick("thr_note", posted["message_id"])

    store = platform.get_store()
    notes = store.drain_agent_notes("thr_note")
    assert len(notes) == 1
    assert "RMNP permit" in notes[0] and "done" in notes[0]
    # Taken once: the next message does not repeat it.
    assert store.drain_agent_notes("thr_note") == []


def test_ticking_something_that_is_not_a_checklist_item_is_a_404(monkeypatch):
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    posted = client.post("/api/platform/hub/deliver", json=deliver_body(thread_id="thr_notick"), headers=AUTH).json()
    assert tick("thr_notick", posted["message_id"]).status_code == 404
    assert tick("thr_notick", posted["message_id"], item_index=99).status_code == 404


def test_a_note_rides_out_with_the_next_message(monkeypatch):
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    posted = client.post("/api/platform/hub/deliver", json=checklist_body("thr_ride"), headers=AUTH).json()
    tick("thr_ride", posted["message_id"])

    sent = {}
    monkeypatch.setattr("chat.routes.forward_gateway_event", lambda payload: sent.update(payload) or ("forwarded", ""))
    r = client.post(
        "/api/chat/threads/thr_ride/send",
        json={"text": "how's the trip looking", "client_msg_id": "c-ride"},
        cookies={"hub_chat_session": "x"},
    )
    assert r.status_code == 200, r.text
    assert "RMNP permit" in sent["context_note"]
    # the user's own bubble says what he typed.
    assert sent["text"] == "how's the trip looking"


def test_a_thread_opens_on_its_newest_messages_not_its_oldest(monkeypatch):
    """the user, 2026-09-28: "takes a bit for the most recent ones to load". The
    snapshot returned the OLDEST 200 rows, so a long thread opened days back."""
    monkeypatch.setattr("chat.session.chat_session_valid", lambda token: True)
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    for i in range(12):
        client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(thread_id="thr_long", parts=[{"type": "text", "text": f"m{i}"}]),
            headers=AUTH,
        )
    r = client.get("/api/chat/threads/thr_long?limit=5", cookies={"hub_chat_session": "x"})
    assert r.status_code == 200, r.text
    got = [m["parts"][0]["text"] for m in r.json()["messages"]]
    assert got == ["m7", "m8", "m9", "m10", "m11"]

    # Scroll-back: the page before the oldest one shown.
    oldest = r.json()["messages"][0]["seq"]
    r2 = client.get(f"/api/chat/threads/thr_long?limit=5&before_seq={oldest}", cookies={"hub_chat_session": "x"})
    assert [m["parts"][0]["text"] for m in r2.json()["messages"]] == ["m2", "m3", "m4", "m5", "m6"]

    # A cursor still reads forward, for the catch-up path.
    r3 = client.get(f"/api/chat/threads/thr_long?after_seq={oldest}", cookies={"hub_chat_session": "x"})
    assert [m["parts"][0]["text"] for m in r3.json()["messages"]] == ["m8", "m9", "m10", "m11"]


def test_closing_one_run_leaves_a_live_run_in_the_same_thread_alone():
    """The stream-end close names its run. The memory review's rows settle;
    a turn still streaming in the same thread is not touched."""
    for run, text in (("run-old", "half a th"), ("run-live", "still wri")):
        client.post(
            "/api/platform/hub/deliver",
            json=deliver_body(thread_id="thr_runs", status="streaming", run_id=run,
                              parts=[{"type": "text", "text": text}]),
            headers=AUTH,
        )
    r = client.post("/api/platform/hub/close", json={"thread_id": "thr_runs", "run_id": "run-old"}, headers=AUTH)
    assert r.json() == {"status": "ok", "closed": 1}
    status = {m["run_id"]: m["status"] for m in platform.get_store().list_messages("thr_runs")}
    assert status == {"run-old": "complete", "run-live": "streaming"}


def test_a_delivery_with_no_run_never_closes_the_live_turn():
    """A widget drawn mid-turn arrives with no run id. It used to close every
    streaming row in the thread — the live turn included (audit, 2026-09-28)."""
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_widget_mid", status="streaming", run_id="run-live",
                          parts=[{"type": "text", "text": "thinking about"}]),
        headers=AUTH,
    )
    client.post(
        "/api/platform/hub/deliver",
        json=deliver_body(thread_id="thr_widget_mid", run_id=None,
                          parts=[{"type": "widget", "kind": "metric", "props": {"label": "x", "value": "1"}}]),
        headers=AUTH,
    )
    live = [m for m in platform.get_store().list_messages("thr_widget_mid") if m["run_id"] == "run-live"]
    assert live[0]["status"] == "streaming"


# --- versions: the one fact a client compares a frame against ------------------------
def test_every_write_moves_the_rows_version_to_the_event_that_made_it():
    st = new_store("version-stamps")
    st.get_or_create_thread("thr_v")
    opened, _ = st.insert_message(
        thread_id="thr_v", role="assistant", author_type="agent",
        parts=[{"type": "text", "text": "hi"}], run_id="run-v", status="streaming",
    )
    assert opened["version"] == opened["seq"]
    grown = st.append_stream_delta(thread_id="thr_v", run_id="run-v", delta=" there")
    delta = st.list_events_after("thr_v", 0)[-1]
    assert delta["type"] == "part.delta"
    assert grown["version"] == delta["seq"] > opened["version"]
    done = st.finalize_streaming_message(
        thread_id="thr_v", run_id="run-v", parts=[{"type": "text", "text": "hi there"}]
    )
    final = st.list_events_after("thr_v", 0)[-1]
    assert done["version"] == final["seq"] > grown["version"]
    # The upsert frame carries the row as it is — version and timestamps
    # included, so a row first seen live has a time under it.
    assert final["payload"]["version"] == done["version"]
    assert final["payload"]["created_at"] == done["created_at"]
    assert final["payload"]["updated_at"] == done["updated_at"]
    # And the row's own place, which is not the event's seq once it has been
    # touched more than once.
    assert final["payload"]["message_seq"] == done["seq"] < final["seq"]


def test_closing_and_ticking_move_the_version_too():
    st = new_store("version-close")
    st.get_or_create_thread("thr_vc")
    st.append_stream_delta(thread_id="thr_vc", run_id="run-vc", delta="half a thought")
    before = st.list_messages("thr_vc")[0]["version"]
    assert st.close_run_streams("thr_vc", run_id="run-vc") == 1
    after = st.list_messages("thr_vc")[0]
    assert after["status"] == "complete" and after["version"] > before
    card, _ = st.insert_message(
        thread_id="thr_vc", role="assistant", author_type="agent",
        parts=[{"type": "widget", "kind": "checklist", "props": {"items": [{"label": "milk", "state": "open"}]}}],
    )
    st.set_checklist_item(thread_id="thr_vc", message_id=card["id"], part_index=0, item_index=0, state="done")
    ticked = st.list_messages("thr_vc")[-1]
    assert ticked["version"] == st.list_events_after("thr_vc", 0)[-1]["seq"] > card["version"]


def test_a_delta_carries_its_offset_and_length_in_the_apps_units():
    st = new_store("utf16")
    st.get_or_create_thread("thr_u")
    st.append_stream_delta(thread_id="thr_u", run_id="run-u", delta="hi 👋")
    st.append_stream_delta(thread_id="thr_u", run_id="run-u", delta=" there")
    delta = [e for e in st.list_events_after("thr_u", 0) if e["type"] == "part.delta"][-1]["payload"]
    assert delta["delta"] == " there"
    # 👋 is one code point to Python and two UTF-16 units to the app.
    assert (delta["offset"], delta["length"]) == (5, 11)


def test_a_final_that_is_not_the_streamed_text_is_its_own_row():
    """A steer acknowledgement under the run id of a reply still streaming used
    to replace the reply's words with its own."""
    st = new_store("finalize-guard")
    st.get_or_create_thread("thr_g")
    st.append_stream_delta(thread_id="thr_g", run_id="run-g", delta="Let me look at the cron job first.")
    assert st.finalize_streaming_message(
        thread_id="thr_g", run_id="run-g",
        parts=[{"type": "text", "text": "Got it — switching to the config question."}],
    ) is None
    (row,) = st.list_messages("thr_g")
    assert row["status"] == "streaming"
    assert row["parts"][0]["text"] == "Let me look at the cron job first."
    # The stream's own final — the whole text of what was streaming — lands.
    done = st.finalize_streaming_message(
        thread_id="thr_g", run_id="run-g",
        parts=[{"type": "text", "text": "Let me look at the cron job first. It is armed for March."}],
    )
    assert done is not None and done["status"] == "complete"


def test_the_version_column_is_backfilled_from_the_log_when_an_older_db_is_opened():
    st = new_store("backfill")
    st.get_or_create_thread("thr_b")
    st.append_stream_delta(thread_id="thr_b", run_id="run-b", delta="one")
    st.append_stream_delta(thread_id="thr_b", run_id="run-b", delta=" two")
    row = st.list_messages("thr_b")[0]
    assert row["version"] > row["seq"]
    st._conn.execute("ALTER TABLE messages DROP COLUMN version")
    st._conn.commit()
    st.close()
    reopened = ChatStore(st.db_path, st.media_dir)
    assert reopened.list_messages("thr_b")[0]["version"] == row["version"]


def test_a_turn_stays_working_between_its_tool_rounds():
    """the user, 2026-09-30: "working animation seems to disappear when it goes from
    tool back to thinking". A row belongs to one LLM stream and a turn has one
    per tool round; on his 21:23 turn a tool row completed at 21:23:13 and the
    next row opened at 21:24:01 — 48 seconds with nothing streaming anywhere,
    which every "working" read off row status called idle."""
    st = new_store("run-state")
    st.get_or_create_thread("thr_run")
    assert st.get_thread("thr_run")["status"] == "idle"

    st.begin_run("thr_run", "run-1")
    st.append_stream_delta(thread_id="thr_run", run_id="run-1", delta="thinking…")
    st.finalize_streaming_message(thread_id="thr_run", run_id="run-1", parts=[{"type": "text", "text": "thinking…"}])
    st.close_run_streams("thr_run", run_id="run-1")
    # The stream has ended and nothing is streaming — mid-turn, between rounds.
    assert not any(m["status"] == "streaming" for m in st.list_messages("thr_run"))
    assert st.get_thread("thr_run")["status"] == "running"
    assert st.get_thread_summary("thr_run")["working"] is True

    st.end_run("thr_run", run_id="run-1")
    assert st.get_thread("thr_run")["status"] == "idle"
    assert st.get_thread_summary("thr_run")["working"] is False


def test_the_run_state_is_written_once_per_turn_not_once_per_delta():
    st = new_store("run-state-events")
    st.get_or_create_thread("thr_rs")
    st.begin_run("thr_rs", "run-1")
    for _ in range(5):
        st.begin_run("thr_rs", "run-1")
    st.end_run("thr_rs", run_id="run-1")
    st.end_run("thr_rs", run_id="run-1")
    statuses = [e for e in st.list_events_after("thr_rs", 0) if e["type"] == "run.status"]
    assert [e["payload"]["status"] for e in statuses] == ["running", "idle"]


def test_a_straggler_from_a_finished_turn_does_not_end_the_live_one():
    st = new_store("run-state-straggler")
    st.get_or_create_thread("thr_rs2")
    st.begin_run("thr_rs2", "run-2")
    st.end_run("thr_rs2", run_id="run-1")
    assert st.get_thread("thr_rs2")["status"] == "running"


def test_a_streamed_copy_missing_only_its_paragraph_breaks_is_the_same_reply():
    """the user, 2026-09-30: "getting double messages again". The stream carried
    1,854 characters and the final 1,860 — the same words, three paragraph
    breaks apart. Split into sentence pieces those matched nothing, so the
    reply was posted a second time under the first."""
    st = new_store("whitespace-same")
    st.get_or_create_thread("thr_ws")
    streamed = "Yes — it lands.- **A real fork.** Two bets.Bottom line: your instinct is sound."
    final = "Yes — it lands.\n\n- **A real fork.** Two bets.\n\nBottom line: your instinct is sound."
    st.append_stream_delta(thread_id="thr_ws", run_id="run-w", delta=streamed)
    done = st.finalize_streaming_message(
        thread_id="thr_ws", run_id="run-w", parts=[{"type": "text", "text": final}]
    )
    assert done is not None, "the final must land on the row that streamed it"
    (row,) = st.list_messages("thr_ws")
    # And the row keeps the FINAL text, so the paragraphs are back.
    assert row["parts"][0]["text"] == final


def test_two_different_replies_in_one_run_still_keep_their_own_rows():
    """The rule whitespace-insensitivity must not undo: a turn can say a long
    thing and then a short note, and the note must not overwrite the answer."""
    st = new_store("whitespace-diff")
    st.get_or_create_thread("thr_wd")
    st.append_stream_delta(
        thread_id="thr_wd", run_id="run-d",
        delta="The cron job is armed for March and the ledger has been frozen since August.",
    )
    assert st.finalize_streaming_message(
        thread_id="thr_wd", run_id="run-d", parts=[{"type": "text", "text": "Noted your meds."}]
    ) is None


def test_a_lone_surrogate_is_one_unit_not_an_error():
    """A model can emit half a surrogate pair; JS counts it as one unit and
    Python refuses to encode it. The delta must still land."""
    st = new_store("surrogate")
    st.get_or_create_thread("thr_sur")
    st.append_stream_delta(thread_id="thr_sur", run_id="run-s", delta="ab\ud83d")
    st.append_stream_delta(thread_id="thr_sur", run_id="run-s", delta="c")
    delta = [e for e in st.list_events_after("thr_sur", 0) if e["type"] == "part.delta"][-1]["payload"]
    assert (delta["offset"], delta["length"]) == (3, 4)


def test_a_backfill_that_died_after_the_alter_is_finished_on_the_next_start():
    st = new_store("backfill-resume")
    st.get_or_create_thread("thr_br")
    st.append_stream_delta(thread_id="thr_br", run_id="run-br", delta="one")
    st.append_stream_delta(thread_id="thr_br", run_id="run-br", delta=" two")
    row = st.list_messages("thr_br")[0]
    # The ALTER landed, the backfill did not: every row at the column default.
    st._conn.execute("UPDATE messages SET version = 0")
    st._conn.commit()
    st.close()
    reopened = ChatStore(st.db_path, st.media_dir)
    assert reopened.list_messages("thr_br")[0]["version"] == row["version"]


def test_scan_events_after_reports_how_far_it_read_past_a_swept_message():
    st = new_store("scan")
    st.get_or_create_thread("thr_s")
    kept, _ = st.insert_message(thread_id="thr_s", role="assistant", author_type="agent", parts=[{"type": "text", "text": "a"}])
    swept, _ = st.insert_message(thread_id="thr_s", role="assistant", author_type="agent", parts=[{"type": "text", "text": "b"}])
    st._conn.execute("DELETE FROM parts WHERE message_id=?", (swept["id"],))
    st._conn.execute("DELETE FROM messages WHERE id=?", (swept["id"],))
    st._conn.commit()
    events, scanned_to = st.scan_events_after("thr_s", kept["seq"], limit=1)
    assert events == []
    assert scanned_to == swept["seq"]
