"""Server-side iMessage draft approval wiring.

A draft the Mac creates (`POST /api/chat/imessage/draft`) is mirrored into the Hub as:
  * a thread card whose `tool_call` part is named `draft_imessage` and carries the
    recipient/body/Mac draft id in `args` (what chat/drafts.ts + DraftApprovalCard read),
  * a centralized needs-you `attention` row of kind `imessage_draft`, and
  * a stored `approvals` row keyed (run_id, request_id) — the SAME store the Hub
    apply route, the Discord button and the web approval link all answer through.

The contract this asserts:
  * creating a draft needs an authenticated caller (the chat session cookie or the
    platform key) and is rate-limited — it used to be open to anyone who could reach
    the port;
  * the Hub apply route (`/api/chat/approval/apply`) answers a draft with once
    (send) / deny (discard), because its stored frame offers exactly those;
  * a draft's Home decision card answers only through the proof-gated
    `/api/decisions/{id}/answer` — the old proof-free `/draft-answer` is gone;
  * `answer_approval`'s CAS is the ONE first-answer-wins store — whichever surface
    answers first sends once, and every later answer (Discord, web link, a second
    Hub tap) is `already_answered` and never reaches the Mac;
  * an outcome the Mac did not confirm is never claimed as a send.

Offline: TestClient in-process, chat.db under a tmpdir, no live hub-api, no network.
Own process, like every chat test file (requirements-dev.txt).
"""
from __future__ import annotations

import asyncio
import base64
import os
import pathlib
import sys
import tempfile

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_CHAT_DB"] = str(TMP / "chat" / "chat.db")
os.environ["HUB_CHAT_MEDIA_DIR"] = str(TMP / "chat" / "media")
os.environ["HUB_CHAT_COMMAND_CATALOG"] = str(TMP / "chat" / "commands-catalog.json")
os.environ["HUB_CHAT_SESSIONS_FILE"] = str(TMP / "chat" / "sessions.json")
os.environ["HUB_PLATFORM_KEY_FILE"] = str(TMP / "hub-platform-key")
os.environ["HUB_PASSKEYS"] = str(TMP / "passkeys.json")
os.environ["HUB_DEVICEKEYS"] = str(TMP / "devicekeys.json")
os.environ["HUB_PUSH_TOKENS"] = str(TMP / "push_tokens.json")
os.environ["HUB_TOPICS_CONFIG"] = str(TMP / "telegram-topics.json")
os.environ["HUB_TOPICS_LIVE"] = str(TMP / "telegram-topics.live.json")
os.environ["HUB_DECISIONS_DIR"] = str(TMP / "decisions")
os.environ["HUB_BRIDGE_URL"] = ""
# The iMessage side: no live Mac, a token file that does not exist, a private HMAC
# file, and a missing Discord approvals token (the notice is dormant by design).
os.environ["IMESSAGE_MCP_URL"] = "http://mac.invalid:8400/mcp"
os.environ["IMESSAGE_TOKEN_FILE"] = str(TMP / "imessage-token")
os.environ["COMPOSE_HMAC_FILE"] = str(TMP / "compose-hmac")
os.environ["IMESSAGE_QUEUE_DIR"] = str(TMP / "imessage-queue")
os.environ["HUB_PUBLIC_BASE"] = "https://hub.test"
os.environ["HUB_DISCORD_APPROVALS_TOKEN"] = str(TMP / "discord-approvals-token-missing")
(TMP / "hub-platform-key").write_text("test-platform-secret\n")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

import app as hub_app  # noqa: E402
import chat.approval as chat_approval  # noqa: E402
import chat.imessage_draft as chat_imessage_draft  # noqa: E402
import chat.platform as platform
import chat.session as chat_session  # noqa: E402
import chat.store as hub_store  # noqa: E402
import devicekeys as dk  # noqa: E402
import webauthn_gate as wa  # noqa: E402
from chat.store import ATTENTION_KIND_IMESSAGE_DRAFT, ChatStore  # noqa: E402

client = TestClient(hub_app.app)
COOKIE = {"hub_chat_session": "x"}
APPROVER = "424242"
ATT_THREAD = hub_app.IMESSAGE_ATTENTION_THREAD
PLATFORM_AUTH = {"authorization": "Bearer test-platform-secret"}
DRAFT_URL = "/api/chat/imessage/draft"


class FakeMac:
    """The one seam to the Mac: records every call, mints draft ids, answers sends."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self._ids = iter(range(9001, 9100))
        self.send_result: dict = {"structuredContent": {"status": "sent"},
                                  "content": [{"type": "text", "text": "sent"}]}

    def __call__(self, name: str, arguments: dict) -> dict:
        self.calls.append((name, arguments))
        if name == "draft_imessage":
            did = next(self._ids)
            return {"structuredContent": {"draft_id": did, "status": "drafted"},
                    "content": [{"type": "text", "text": f"draft {did}"}]}
        if name == "decide_draft":
            return {"structuredContent": {"draft_id": arguments.get("draft_id"),
                                          "applied": True,
                                          "status": "approved" if arguments.get("decision") == "approve" else "denied"},
                    "content": [{"type": "text", "text": "ok"}]}
        if name == "send_draft":
            return self.send_result
        raise AssertionError(f"unexpected tool {name}")

    @property
    def decides(self) -> list[tuple[int, str]]:
        return [(a["draft_id"], a["decision"]) for n, a in self.calls if n == "decide_draft"]

    @property
    def sends(self) -> list[int]:
        return [a["draft_id"] for n, a in self.calls if n == "send_draft"]


@pytest.fixture()
def mac(monkeypatch):
    fake = FakeMac()
    monkeypatch.setattr(hub_app, "_imessage_tool_call", fake)
    monkeypatch.setattr(hub_app, "_notify_approvals", lambda *a, **k: None)
    return fake


@pytest.fixture()
def store(monkeypatch, tmp_path):
    """A fresh store behind the live app, with the cookie + proof gates opened."""
    st = ChatStore(tmp_path / "chat.db", tmp_path / "media")
    monkeypatch.setattr(platform, "_store", st)
    monkeypatch.setattr(hub_app, "DECISIONS_DIR", tmp_path / "decisions")
    monkeypatch.setattr(hub_app, "DECISIONS_LEDGER", (tmp_path / "decisions") / "responses.jsonl")
    monkeypatch.setattr("chat.routes.chat_session_valid", lambda token: True)
    monkeypatch.setattr(chat_approval, "_require_enrolled", lambda _dk: None)
    monkeypatch.setattr(chat_approval, "_verify_proof", lambda req, purpose, ctx: "test-cred")
    yield st
    st.close()


@pytest.fixture(autouse=True)
def fresh_draft_budget():
    """The draft rate limit is process-wide; every test starts with a full budget."""
    hub_app._IM_DRAFT_TIMES.clear()
    yield


# --- a real paired device key: the decision answers below go through the REAL proof ---
APP_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


def _b64u_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


@pytest.fixture()
def paired(monkeypatch):
    """A device-key-only install (no passkey), the native app's normal state."""
    monkeypatch.setattr(wa, "PASSKEYS_JSON", TMP / "no-passkeys.json")
    monkeypatch.setattr(dk, "DEVICEKEYS_JSON", TMP / "devicekeys.json")
    (TMP / "devicekeys.json").unlink(missing_ok=True)
    dk._enroll_codes.clear()
    dk._attempt_times.clear()
    dk._global_attempts.clear()
    wa._cache._store.clear()
    spki = APP_KEY.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    r = client.post("/api/devicekey/register", json={
        "code": dk.mint_enroll_code()["code"], "spki_der_b64": base64.b64encode(spki).decode(), "label": "t"})
    assert r.status_code == 200, r.text
    return r.json()["key_id"]


def device_proof(challenge_b64u: str, key_id: str, priv=APP_KEY) -> dict:
    sig = priv.sign(_b64u_decode(challenge_b64u), ec.ECDSA(hashes.SHA256()))
    return {"key_id": key_id, "challenge_b64": challenge_b64u, "signature_b64": base64.b64encode(sig).decode()}


def decision_challenge(did: str, option_key: str | None, note: str | None = None) -> str:
    r = client.post(f"/api/decisions/{did}/challenge", json={"option_key": option_key, "note": note})
    assert r.status_code == 200, r.text
    return r.json()["challenge"]


def answer_decision(did: str, option_key: str, key_id: str):
    """The app's Home card: challenge -> Face ID (the device key signs) -> answer."""
    proof = device_proof(decision_challenge(did, option_key), key_id)
    return client.post(f"/api/decisions/{did}/answer",
                       json={"option_key": option_key, "note": None, "devicekey_assertion": proof})


def automation_draft(store) -> tuple[int, str]:
    r = client.post(DRAFT_URL, headers=PLATFORM_AUTH,
                    data={"chat_id": "15551234567", "contact": "Dana", "text": "cron says hi"})
    assert r.status_code == 200, r.text
    draft_id = _draft_ids(store)[-1]
    return draft_id, f"imessage-draft-{draft_id}"


def card(did: str) -> dict:
    import json as _json
    return _json.loads((hub_app.DECISIONS_DIR / f"{did}.json").read_text())


def apply_draft(draft_id: int, choice: str):
    """The Hub card's own call: /api/chat/approval/apply (chat/approval.py)."""
    return client.post("/api/chat/approval/apply", json={
        "decisions": [{"run_id": f"imessage_draft_{draft_id}",
                       "request_id": f"imessage_draft_{draft_id}", "choice": choice}],
        "assertion": {"id": "x", "raw_id": "x", "client_data_json": "x",
                      "authenticator_data": "x", "signature": "x"},
    })


def press_draft(draft_id: int, action: str, monkeypatch) -> list[tuple]:
    """The Discord button's own call: `_approval_press` with a real HMAC custom_id."""
    calls: list[tuple] = []
    monkeypatch.setattr(hub_app, "DISCORD_APPROVER_ID", APPROVER)
    monkeypatch.setattr(hub_app, "_discord_api",
                        lambda method, path, payload=None, token=None: calls.append((method, path, payload)) or {})
    inter = {
        "id": "1", "application_id": "app", "token": "tok",
        "data": {"custom_id": f"im:{action}:{draft_id}:{hub_app._draft_token(draft_id)[:32]}"},
        "member": {"user": {"id": APPROVER}},
    }
    asyncio.run(hub_app._approval_press(inter))
    return calls


# =============================================================================
# 1. delivery: the Hub card, the needs-you row, and the stored approval
# =============================================================================
def test_a_created_draft_surfaces_in_a_thread_and_as_a_needs_you_row(store, mac):
    thread_id = "thr_draft"
    row = store.upsert_imessage_draft(
        draft_id=555, thread_id=thread_id, contact="Dana", text="see you at 8",
        expires_at_derived="2099-01-01T00:00:00Z", summary="Approve iMessage to Dana",
    )
    assert row["run_id"] == row["request_id"] == "imessage_draft_555"
    assert row["choice"] is None and row["outcome"] is None

    # the thread card: a text line + the draft tool_call the client matches on
    message = store._message_row(row["message_id"])
    tool = next(p for p in message["parts"] if p.get("type") == "tool_call")
    assert tool["tool_name"] == "draft_imessage"
    assert tool["state"] == "approval_requested"
    assert tool["tool_call_id"] == "imessage_draft_555"
    assert tool["choices"] == ["once", "deny"]
    assert tool["args"] == {"to": "Dana", "text": "see you at 8", "draft_id": 555}

    # the centralized needs-you row
    rows = store.list_open_attention()
    assert len(rows) == 1
    assert rows[0]["kind"] == ATTENTION_KIND_IMESSAGE_DRAFT
    assert rows[0]["expires_at_derived"] == "2099-01-01T00:00:00Z"
    assert rows[0]["thread_title"] == "iMessage drafts"
    # ... and it rides thread detail too, linked to the card's own message
    thread_rows = store.thread_open_attention(thread_id)
    assert [a["kind"] for a in thread_rows] == [ATTENTION_KIND_IMESSAGE_DRAFT]
    assert thread_rows[0]["message_id"] == row["message_id"]
    assert thread_rows[0]["request_id"] == "imessage_draft_555"
    assert thread_rows[0]["run_id"] == "imessage_draft_555"

    # the stored approval the apply route validates against
    approval = store.get_approval(run_id="imessage_draft_555", request_id="imessage_draft_555")
    assert approval is not None and approval["answered"] == 0


def _thread_messages(store, thread_id: str) -> list:
    try:
        return store.list_messages(thread_id)
    except Exception:
        return []


def test_post_imessage_draft_without_a_thread_is_home_decision_only(store, mac):
    """No thread_id (an automation's draft): NO chat surface at all — no
    message, no needs-you row — the draft surfaces on the HOME page as a
    Decision-Inbox card answerable through the draft's own CAS."""
    r = client.post(DRAFT_URL, headers=PLATFORM_AUTH,
                    data={"chat_id": "15551234567", "contact": "Dana", "text": "running late"})
    assert r.status_code == 200, r.text
    assert mac.calls and mac.calls[0][0] == "draft_imessage"

    # nothing in any chat inbox — the home page is the surface
    attention = client.get("/api/chat/attention", cookies=COOKIE).json()["attention"]
    assert attention == []
    assert _thread_messages(store, hub_store.ATTENTION_THREAD_ANCHOR) == []

    draft_id = _draft_ids(store)[-1]
    import json as _json
    card = _json.loads((hub_app.DECISIONS_DIR / f"imessage-draft-{draft_id}.json").read_text())
    assert card["status"] == "open" and card["draft_id"] == draft_id


def test_post_imessage_draft_cards_into_the_requesting_thread(store, mac):
    r = client.post(DRAFT_URL, headers=PLATFORM_AUTH,
                    data={"chat_id": "15551234567", "contact": "Dana", "text": "running late",
                          "thread_id": "thr_request"})
    assert r.status_code == 200, r.text

    attention = client.get("/api/chat/attention", cookies=COOKIE).json()["attention"]
    assert len(attention) == 1
    assert attention[0]["thread_id"] == "thr_request"

    # the card lives in the requesting thread and carries the Mac's draft id
    thread_msgs = store.list_messages("thr_request")
    assert len(thread_msgs) == 1
    tool = next(p for p in thread_msgs[0]["parts"] if p["type"] == "tool_call")
    draft_id = tool["args"]["draft_id"]
    assert tool["args"]["to"] == "Dana" and tool["args"]["text"] == "running late"
    assert store.get_imessage_draft(draft_id) is not None
    assert store.get_approval(run_id=f"imessage_draft_{draft_id}",
                              request_id=f"imessage_draft_{draft_id}") is not None
    # no stray message in the attention anchor thread
    assert _thread_messages(store, ATT_THREAD) == []


def test_a_malformed_thread_id_is_refused_before_the_mac_is_called(store, mac):
    r = client.post(DRAFT_URL, headers=PLATFORM_AUTH,
                    data={"chat_id": "15551234567", "contact": "Dana", "text": "hi",
                          "thread_id": "bad thread id!"})
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "bad_thread_id"
    assert mac.calls == []


def test_mirror_endpoint_401s_without_the_platform_key(store):
    r = client.post("/api/imessage/drafts/mirror",
                    json={"draft_id": 700, "thread_id": None, "contact": "Dana", "text": "hi"})
    assert r.status_code == 401, r.text
    r = client.post("/api/imessage/drafts/mirror",
                    json={"draft_id": 700, "thread_id": None, "contact": "Dana", "text": "hi"},
                    headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401, r.text


def test_mirror_endpoint_records_an_attention_only_draft(store):
    """A gateway-mirrored draft with no thread: recorded in the store + a home
    Decision-Inbox card — never a chat attention row (the home page is the
    surface for automation drafts)."""
    r = client.post("/api/imessage/drafts/mirror",
                    json={"draft_id": 701, "thread_id": None, "contact": "Dana", "text": "hi"},
                    headers=PLATFORM_AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["attention_id"] == "imessage_draft_701"
    attention = client.get("/api/chat/attention", cookies=COOKIE).json()["attention"]
    assert attention == []
    assert _thread_messages(store, ATT_THREAD) == []
    # the CAS row exists (the card answers through it) and the card is filed
    assert store.get_approval(run_id="imessage_draft_701", request_id="imessage_draft_701")
    import json as _json
    card = _json.loads((hub_app.DECISIONS_DIR / "imessage-draft-701.json").read_text())
    assert card["draft_id"] == 701 and card["status"] == "open"
    # a second mirror is idempotent: same request id, nothing duplicates
    r2 = client.post("/api/imessage/drafts/mirror",
                     json={"draft_id": 701, "thread_id": None, "contact": "Dana", "text": "hi"},
                     headers=PLATFORM_AUTH)
    assert r2.status_code == 200, r2.text
    assert client.get("/api/chat/attention", cookies=COOKIE).json()["attention"] == []


def test_mirror_endpoint_with_a_thread_records_the_thread_card(store):
    r = client.post("/api/imessage/drafts/mirror",
                    json={"draft_id": 702, "thread_id": "thr_mirror", "contact": "Dana", "text": "hi"},
                    headers=PLATFORM_AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    attention = client.get("/api/chat/attention", cookies=COOKIE).json()["attention"]
    assert attention[0]["thread_id"] == "thr_mirror"
    assert attention[0]["message_id"]
    tool = next(p for p in store.list_messages("thr_mirror")[0]["parts"]
                if p["type"] == "tool_call")
    assert tool["args"]["draft_id"] == 702


def test_a_mirrored_draft_still_answers_once_through_the_cas(store, mac):
    r = client.post("/api/imessage/drafts/mirror",
                    json={"draft_id": 703, "thread_id": "thr_cas", "contact": "Dana", "text": "hi"},
                    headers=PLATFORM_AUTH)
    assert r.status_code == 200, r.text
    assert apply_draft(703, "once").status_code == 200
    second = apply_draft(703, "once")
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "already_answered"
    assert mac.sends == [703]


# =============================================================================
# 2. the Hub apply route answers a draft (once = send, deny = discard)
# =============================================================================
def test_offered_choices_for_a_draft_are_send_and_discard_only(store, mac):
    store.upsert_imessage_draft(draft_id=601, thread_id="thr_d", contact="Dana", text="hi")
    ch = client.post("/api/chat/approval/challenge", json={
        "decisions": [{"run_id": "imessage_draft_601", "request_id": "imessage_draft_601", "choice": "always"}]
    })
    assert ch.status_code == 400, ch.text  # `always` was never offered


def test_hub_apply_sends_once_and_records_the_outcome(store, mac):
    store.upsert_imessage_draft(draft_id=602, thread_id="thr_d", contact="Dana", text="hi")
    r = apply_draft(602, "once")
    assert r.status_code == 200, r.text
    decision = r.json()["decisions"][0]
    assert decision["status"] == "answered" and decision["choice"] == "once"
    assert decision["forward_status"] == "local"  # a draft has no gateway to forward to

    assert mac.sends == [602]
    # the Mac's own gate is told FIRST, so its send_draft accepts the draft
    assert mac.decides == [(602, "approve")]
    assert [n for n, _ in mac.calls].index("decide_draft") < [n for n, _ in mac.calls].index("send_draft")
    row = store.get_imessage_draft(602)
    assert row["choice"] == "once" and row["outcome"] == "sent"
    assert store.list_open_attention() == []
    # the card's part is answered, not left pending
    message = store._message_row(row["message_id"])
    tool = next(p for p in message["parts"] if p["type"] == "tool_call")
    assert tool["state"] == "answered" and tool["resolved_choice"] == "once"
    assert "sent" in message["parts"][0]["text"]


def test_hub_apply_deny_never_sends(store, mac):
    store.upsert_imessage_draft(draft_id=603, thread_id="thr_d", contact="Dana", text="hi")
    r = apply_draft(603, "deny")
    assert r.status_code == 200, r.text
    # the Mac is told the decision (so its own gate clears) but nothing sends
    assert mac.decides == [(603, "deny")]
    assert mac.sends == []
    row = store.get_imessage_draft(603)
    assert row["choice"] == "deny" and row["outcome"] == "denied"
    assert store.list_open_attention() == []


def test_a_second_hub_apply_is_a_409_and_never_sends_again(store, mac):
    store.upsert_imessage_draft(draft_id=604, thread_id="thr_d", contact="Dana", text="hi")
    assert apply_draft(604, "once").status_code == 200
    second = apply_draft(604, "once")
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "already_answered"
    assert mac.sends == [604]


# =============================================================================
# 3. first-answer-wins across surfaces — one store, one send
# =============================================================================
def test_a_hub_decision_then_a_discord_press_is_already_answered(store, mac, monkeypatch):
    store.upsert_imessage_draft(draft_id=605, thread_id="thr_d", contact="Dana", text="hi")
    assert apply_draft(605, "once").status_code == 200
    calls = press_draft(605, "ok", monkeypatch)
    assert mac.sends == [605]  # the Discord press did NOT send a second time
    finish = [p for m, path, p in calls if path.endswith("/messages/@original")]
    assert finish and "already answered" in finish[0]["content"]


def test_a_hub_decision_then_the_web_link_is_already_answered(store, mac):
    store.upsert_imessage_draft(draft_id=606, thread_id="thr_d", contact="Dana", text="hi")
    assert apply_draft(606, "once").status_code == 200
    r = client.post("/api/imessage/send/606", data={"t": hub_app._draft_token(606)})
    assert r.status_code == 200
    assert "Already answered" in r.text
    assert mac.sends == [606]


def test_a_discord_press_then_the_hub_apply_is_refused(store, mac, monkeypatch):
    store.upsert_imessage_draft(draft_id=607, thread_id="thr_d", contact="Dana", text="hi")
    press_draft(607, "no", monkeypatch)  # discard from Discord
    assert mac.sends == []
    r = apply_draft(607, "once")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_answered"
    assert mac.sends == []


def test_the_web_link_still_sends_a_draft_with_no_prior_answer(store, mac):
    store.upsert_imessage_draft(draft_id=608, thread_id="thr_d", contact="Dana", text="hi")
    r = client.post("/api/imessage/send/608", data={"t": hub_app._draft_token(608)})
    assert r.status_code == 200
    assert "Message sent" in r.text
    assert mac.sends == [608]
    assert store.get_imessage_draft(608)["outcome"] == "sent"


def test_a_mac_that_refuses_the_send_is_not_claimed_as_sent(store, mac, monkeypatch):
    mac.send_result = {"isError": True, "content": [{"type": "text", "text": "draft expired"}]}
    store.upsert_imessage_draft(draft_id=609, thread_id="thr_d", contact="Dana", text="hi")
    r = apply_draft(609, "once")
    assert r.status_code == 200
    row = store.get_imessage_draft(609)
    assert row["choice"] == "once" and row["outcome"] == "error"
    message = store._message_row(row["message_id"])
    assert "not sent" in message["parts"][0]["text"].lower()
    assert "— sent" not in message["parts"][0]["text"]


def test_an_unmirrored_draft_is_not_in_the_store(store):
    assert store.get_imessage_draft(999999) is None
    assert chat_imessage_draft.resolve_imessage_draft(999999, "approve") is None


# =============================================================================
# 6. expiry: a draft the Mac timed out stops being "waiting on you"
# =============================================================================
def test_an_expired_draft_row_leaves_the_needs_you_inbox(store):
    from chat.store import _expiry_passed

    # unparseable / missing expiry values never expire
    assert not _expiry_passed(None, "2026-10-04T12:00:00Z")
    assert not _expiry_passed("", "2026-10-04T12:00:00Z")
    assert not _expiry_passed("not-a-timestamp", "2026-10-04T12:00:00Z")
    assert _expiry_passed("2026-10-04T11:00:00Z", "2026-10-04T12:00:00Z")
    assert not _expiry_passed("2026-10-04T13:00:00Z", "2026-10-04T12:00:00Z")

    store.upsert_imessage_draft(
        draft_id=710, thread_id="thr_exp", contact="Dana", text="hi",
        expires_at_derived="2020-01-01T00:00:00Z",   # long past
    )
    store.upsert_imessage_draft(
        draft_id=711, thread_id="thr_fresh", contact="Dana", text="hi",
        expires_at_derived="2099-01-01T00:00:00Z",   # still open
    )

    open_rows = store.list_open_attention()
    kinds = [(r["thread_id"], r["kind"]) for r in open_rows]
    assert ("thr_exp", ATTENTION_KIND_IMESSAGE_DRAFT) not in kinds
    assert ("thr_fresh", ATTENTION_KIND_IMESSAGE_DRAFT) in kinds

    # the expired row is marked expired — NOT answered: no decision was made,
    # and the approvals CAS the other surfaces share is untouched
    with store._lock:
        state = store._conn.execute(
            "SELECT state FROM attention WHERE kind=? AND thread_id='thr_exp'",
            (ATTENTION_KIND_IMESSAGE_DRAFT,),
        ).fetchone()[0]
    assert state == "expired"
    approval = store.get_approval(run_id="imessage_draft_710", request_id="imessage_draft_710")
    assert approval is not None and approval["answered"] == 0

    # the read settles it for thread detail too
    assert store.thread_open_attention("thr_exp") == []

    # ... and a second read is stable (no double-event, no resurrection)
    assert store.list_open_attention() == open_rows


# =============================================================================
# 7. automation drafts: a Home-page decision card, never a chat thread
# =============================================================================
def _draft_ids(st):
    with st._lock:
        rows = st._conn.execute("SELECT draft_id FROM imessage_drafts").fetchall()
    return [int(r["draft_id"]) for r in rows]


def test_an_automation_draft_files_a_home_decision_card_and_no_visible_thread(store, mac, monkeypatch):
    """No thread_id: the draft lands on the app's HOME page as a Decision-Inbox
    card (the pinned banner reads /api/decisions), the anchor thread is archived
    out of the thread list, and no chat message exists anywhere."""
    r = client.post(DRAFT_URL, headers=PLATFORM_AUTH,
                    data={"chat_id": "15551234567", "contact": "Dana", "text": "cron says hi"})
    assert r.status_code == 200, r.text
    draft_id = _draft_ids(store)[-1]

    did = f"imessage-draft-{draft_id}"
    import json as _json
    card = _json.loads((hub_app.DECISIONS_DIR / f"{did}.json").read_text())
    assert card["status"] == "open"
    assert card["draft_id"] == draft_id
    assert [o["key"] for o in card["options"]] == ["once", "deny", "dismiss"]

    # the anchor thread exists (the attention row needs one) but is archived:
    # invisible in the app's thread list
    ANCHOR = hub_store.ATTENTION_THREAD_ANCHOR
    assert store.get_thread(ANCHOR)["archived"] == 1
    assert _thread_messages(store, ANCHOR) == []


def test_a_draft_decision_card_answers_through_the_gated_route_exactly_once(store, mac, paired):
    """The Home card answers through the proof-gated /answer: the proof is verified,
    THEN the draft's own first-answer-wins record sends it — once."""
    draft_id, did = automation_draft(store)
    r = answer_decision(did, "once", paired)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "answered"
    assert r.json()["draft"] == {"draft_id": draft_id, "status": "approved", "outcome": "sent"}
    assert mac.sends == [draft_id]
    assert store.get_imessage_draft(draft_id)["choice"] == "once"
    assert card(did)["status"] == "answered"
    ledger = (hub_app.DECISIONS_LEDGER).read_text().splitlines()
    assert len(ledger) == 1 and did in ledger[0]

    # the card is closed: a second answer is refused before any challenge is issued
    r2 = client.post(f"/api/decisions/{did}/challenge", json={"option_key": "deny"})
    assert r2.status_code == 400
    assert mac.sends == [draft_id]


def test_a_draft_answered_elsewhere_first_is_not_sent_again(store, mac, paired):
    draft_id, did = automation_draft(store)
    assert apply_draft(draft_id, "once").status_code == 200   # the chat card won the race
    r = answer_decision(did, "once", paired)
    assert r.status_code == 200, r.text
    assert r.json()["draft"]["status"] == "already_answered"
    assert mac.sends == [draft_id]


@pytest.mark.parametrize("option", ["deny", "dismiss"])
def test_a_draft_decision_card_deny_or_dismiss_never_sends(store, mac, paired, option):
    draft_id, did = automation_draft(store)
    r = answer_decision(did, option, paired)
    assert r.status_code == 200, r.text
    assert r.json()["draft"]["status"] == "denied"
    assert mac.sends == []
    assert store.get_imessage_draft(draft_id)["choice"] == "deny"
    assert card(did)["status"] == ("dismissed" if option == "dismiss" else "answered")


def test_a_draft_answer_without_a_proof_is_refused(store, mac, paired):
    draft_id, did = automation_draft(store)
    r = client.post(f"/api/decisions/{did}/answer", json={"option_key": "once"})
    assert r.status_code == 422, r.text
    assert mac.sends == []
    assert store.get_imessage_draft(draft_id)["choice"] is None
    assert card(did)["status"] == "open"


def test_a_draft_answer_with_an_invalid_proof_is_refused(store, mac, paired):
    draft_id, did = automation_draft(store)
    # signed by a key that was never paired
    forged = device_proof(decision_challenge(did, "once"), paired, priv=OTHER_KEY)
    r = client.post(f"/api/decisions/{did}/answer", json={"option_key": "once", "devicekey_assertion": forged})
    assert r.status_code == 403, r.text
    # a real proof, but for a different answer ("deny"), cannot approve
    other_answer = device_proof(decision_challenge(did, "deny"), paired)
    r = client.post(f"/api/decisions/{did}/answer", json={"option_key": "once", "devicekey_assertion": other_answer})
    assert r.status_code == 403, r.text
    assert mac.sends == []
    assert store.get_imessage_draft(draft_id)["choice"] is None
    assert card(did)["status"] == "open"


def test_a_note_alone_cannot_answer_a_draft(store, mac, paired):
    _draft_id, did = automation_draft(store)
    r = client.post(f"/api/decisions/{did}/challenge", json={"option_key": None, "note": "later"})
    assert r.status_code == 400, r.text
    assert mac.sends == []


def test_the_proof_free_draft_answer_route_is_gone(store, mac):
    draft_id, did = automation_draft(store)
    r = client.post(f"/api/decisions/{did}/draft-answer", json={"option_key": "once"})
    assert r.status_code in (404, 405), r.text
    assert mac.sends == []
    assert card(did)["status"] == "open"


# =============================================================================
# 8. creating a draft needs an authenticated caller, and is rate-limited
# =============================================================================
JSON_ACCEPT = {"Accept": "application/json"}
BROWSER_ACCEPT = {"Accept": "text/html,application/xhtml+xml"}
FORM = {"chat_id": "15551234567", "contact": "Dana", "text": "hi"}


def test_drafting_without_credentials_never_reaches_the_mac(store, mac):
    for headers in ({}, {"authorization": "Bearer wrong"}, {"authorization": "test-platform-secret"}):
        r = client.post(DRAFT_URL, data=FORM, headers={**JSON_ACCEPT, **headers})
        assert r.status_code == 401, r.text
        assert r.json()["detail"]["code"] == "unauthenticated"
    r = client.post(DRAFT_URL, data=FORM, cookies={"hub_chat_session": "not-a-session"})
    assert r.status_code == 401, r.text
    # a browser form gets the page, not JSON
    r = client.post(DRAFT_URL, data=FORM, headers=BROWSER_ACCEPT)
    assert r.status_code == 401 and r.headers["content-type"].startswith("text/html")
    assert "Unlock chat first" in r.text
    assert mac.calls == []
    assert _draft_ids(store) == []


def test_an_unlocked_chat_session_may_draft(store, mac):
    """The compose page is a no-JS form: the chat cookie is the credential it carries."""
    token = chat_session._chat_session_new()
    r = client.post(DRAFT_URL, data=FORM, cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    assert [n for n, _ in mac.calls] == ["draft_imessage"]


def test_the_old_open_draft_path_is_gone(store, mac):
    r = client.post("/api/imessage/draft", data=FORM, headers=PLATFORM_AUTH)
    assert r.status_code in (404, 405), r.text
    assert mac.calls == []


def test_drafting_is_rate_limited(store, mac, monkeypatch):
    monkeypatch.setattr(hub_app, "_IM_DRAFT_RATE_MAX", 2)
    for _ in range(2):
        assert client.post(DRAFT_URL, data=FORM, headers=PLATFORM_AUTH).status_code == 200
    r = client.post(DRAFT_URL, data=FORM, headers={**PLATFORM_AUTH, **JSON_ACCEPT})
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "rate_limited"
    assert int(r.headers["retry-after"]) >= 1
    assert [n for n, _ in mac.calls] == ["draft_imessage", "draft_imessage"]
