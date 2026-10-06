"""Hub chat approval gate (chat/approval.py) — VERDICT-V2 §4.3, T3 in §7.

Offline: TestClient in-process, passkey/devicekey/chat stores all under a tmpdir, no
live hub-api, no network. Run separately from the other test files (requirements-
dev.txt explains why: several modules set env vars at import time before importing
`app`, and only the first module pytest collects gets to set them).

The threat model this asserts, in order — the task's contract (a)-(e), verbatim:
  (a) `choice` is a server-side Literal["once","session","always","deny"] — a garbage
      string is a 422 before any handler code runs.
  (b) the allowed choices are re-derived from the STORED approval's own frame, never
      trusted from the client: no explicit `choices` on the frame -> only once/deny
      are ever accepted; an explicit `choices` list on the frame -> exactly that set,
      intersected with the fixed universe.
  (c) the context hash binds the exact {request_id, run_id, choice} set — a proof
      minted for one choice/set cannot be replayed against a different one.
  (d) an answered decision is a dead end: challenging or applying it again is a 409,
      never a second write, and `forward_status` stays 'pending' (nothing in this
      slice forwards).
  (e) no `all` field exists anywhere in the request shape — top-level or nested —
      and one is a 422, never silently dropped or actioned.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import sys
import tempfile

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_PASSKEYS"] = str(TMP / "passkeys.json")
os.environ["HUB_DEVICEKEYS"] = str(TMP / "devicekeys.json")
os.environ["HUB_RP_ID"] = "hub.test"
os.environ["HUB_ORIGIN"] = "https://hub.test"
os.environ["HUB_TOPICS_CONFIG"] = str(TMP / "telegram-topics.json")
os.environ["HUB_TOPICS_LIVE"] = str(TMP / "telegram-topics.live.json")
os.environ["HUB_DECISIONS_DIR"] = str(TMP / "decisions")
os.environ["HUB_BRIDGE_URL"] = ""
os.environ["HUB_CHAT_DB"] = str(TMP / "chat" / "chat.db")
os.environ["HUB_CHAT_MEDIA_DIR"] = str(TMP / "chat" / "media")
os.environ["HUB_CHAT_COMMAND_CATALOG"] = str(TMP / "chat" / "commands-catalog.json")
os.environ["HUB_PLATFORM_KEY_FILE"] = str(TMP / "hub-platform-key")
(TMP / "hub-platform-key").write_text("test-platform-secret\n")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

import chat.approval as chat_approval  # noqa: E402
import chat.platform as chat_platform  # noqa: E402
import devicekeys as dk  # noqa: E402
import webauthn_gate as wa  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)
PLATFORM_AUTH = {"Authorization": "Bearer test-platform-secret"}
PLATFORM_SECRET = "test-platform-secret"
RP_ID = "hub.test"
ORIGIN = "https://hub.test"

# Substrings that must never appear in any error body this file provokes: the tmpdir
# root (an absolute host path), the platform bearer secret, and the literal env var
# name the user's real secret lives under.
FORBIDDEN_IN_ERRORS = (str(TMP), PLATFORM_SECRET, "HUB_PLATFORM_KEY", "/home/user", "/srv/hub-data")


# --- webauthn/devicekey fixtures (same idiom as test_chat_session.py / test_devicekeys.py)
def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def b64u_decode(val: str) -> bytes:
    return base64.urlsafe_b64decode(val + "=" * (-len(val) % 4))


PASSKEY = ec.generate_private_key(ec.SECP256R1())
CRED_ID = bytes(range(32))
APP_KEY = ec.generate_private_key(ec.SECP256R1())


def cose_p256(pub: ec.EllipticCurvePublicKey) -> bytes:
    import cbor2

    n = pub.public_numbers()
    return cbor2.dumps({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")})


def spki_der(priv: ec.EllipticCurvePrivateKey) -> bytes:
    return priv.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def key_id_of(priv: ec.EllipticCurvePrivateKey) -> str:
    return hashlib.sha256(spki_der(priv)).hexdigest()


def seed_passkey() -> None:
    (TMP / "passkeys.json").write_text(
        json.dumps(
            [
                {
                    "credential_id": b64u(CRED_ID),
                    "public_key": b64u(cose_p256(PASSKEY.public_key())),
                    "sign_count": 0,
                    "transports": [],
                    "label": "Face ID",
                    "created_at": "2026-09-09T00:00:00Z",
                }
            ]
        )
    )


def webauthn_assertion(challenge_b64u: str, priv=PASSKEY, cred_id: bytes = CRED_ID) -> dict:
    auth_data = hashlib.sha256(RP_ID.encode()).digest() + bytes([0x05]) + (0).to_bytes(4, "big")
    client_data = json.dumps(
        {"type": "webauthn.get", "challenge": challenge_b64u, "origin": ORIGIN, "crossOrigin": False},
        separators=(",", ":"),
    ).encode()
    sig = priv.sign(auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
    return {
        "id": b64u(cred_id),
        "raw_id": b64u(cred_id),
        "client_data_json": b64u(client_data),
        "authenticator_data": b64u(auth_data),
        "signature": b64u(sig),
        "user_handle": None,
    }


def dk_assertion(challenge_b64u: str, priv=APP_KEY, key_id: str | None = None) -> dict:
    sig = priv.sign(b64u_decode(challenge_b64u), ec.ECDSA(hashes.SHA256()))
    return {
        "key_id": key_id or key_id_of(priv),
        "challenge_b64": challenge_b64u,
        "signature_b64": base64.b64encode(sig).decode(),
    }


def enrol(priv=APP_KEY, label: str = "iPhone") -> str:
    code = dk.mint_enroll_code()["code"]
    r = client.post(
        "/api/devicekey/register",
        json={"code": code, "spki_der_b64": base64.b64encode(spki_der(priv)).decode(), "label": label},
    )
    assert r.status_code == 200, r.text
    return r.json()["key_id"]


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.setattr(wa, "PASSKEYS_JSON", TMP / "passkeys.json")
    monkeypatch.setattr(wa, "RP_ID", RP_ID)
    monkeypatch.setattr(wa, "ORIGIN", ORIGIN)
    monkeypatch.setattr(dk, "DEVICEKEYS_JSON", TMP / "devicekeys.json")
    seed_passkey()
    (TMP / "devicekeys.json").unlink(missing_ok=True)
    dk._enroll_codes.clear()
    dk._attempt_times.clear()
    dk._global_attempts.clear()
    wa._cache._store.clear()
    yield


# --- helpers ---------------------------------------------------------------------
_N = 0


def _fresh_ids() -> tuple[str, str, str]:
    """A never-reused (thread_id, run_id, request_id) triple per test — the approvals
    table is keyed (run_id, request_id), so reusing one across tests would leak
    answered-state between them."""
    global _N
    _N += 1
    return f"thr_ap{_N}", f"run_{_N}", f"req_{_N}"


def deliver_approval(thread_id: str, run_id: str, request_id: str, *, choices: list[str] | None = None) -> None:
    part: dict = {"type": "tool_call", "tool_name": "terminal", "state": "approval_requested"}
    if choices is not None:
        part["choices"] = choices
    body = {
        "thread_id": thread_id,
        "run_id": run_id,
        "parts": [part],
        "attention": {"kind": "approval", "request_id": request_id, "run_id": run_id, "summary": "terminal: ls"},
    }
    r = client.post("/api/platform/hub/deliver", json=body, headers=PLATFORM_AUTH)
    assert r.status_code == 200, r.text


def challenge(decisions: list[dict]) -> dict:
    r = client.post("/api/chat/approval/challenge", json={"decisions": decisions})
    return r


def apply(decisions: list[dict], *, priv=PASSKEY, assertion_fn=None) -> tuple:
    """Runs the full challenge->sign->apply ceremony and returns (challenge_resp, apply_resp)."""
    ch = challenge(decisions)
    assert ch.status_code == 200, ch.text
    fn = assertion_fn or (lambda c: {"assertion": webauthn_assertion(c, priv=priv)})
    proof = fn(ch.json()["challenge"])
    r = client.post("/api/chat/approval/apply", json={"decisions": decisions, **proof})
    return ch, r


# --- (a) choice literal -----------------------------------------------------------
def test_choice_must_be_a_known_literal():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    r = challenge([{"run_id": run_id, "request_id": request_id, "choice": "approve_forever"}])
    assert r.status_code == 422


# --- (b) offered-set re-derivation --------------------------------------------------
def test_default_offered_choices_are_once_and_deny_only():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)  # no explicit `choices` on the part
    r = challenge([{"run_id": run_id, "request_id": request_id, "choice": "session"}])
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "bad_request"

    r2 = challenge([{"run_id": run_id, "request_id": request_id, "choice": "always"}])
    assert r2.status_code == 400


def test_once_and_deny_are_accepted_with_no_explicit_choices_on_the_frame():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    r = challenge([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    assert r.status_code == 200, r.text


def test_frame_supplied_choices_widen_the_offered_set():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id, choices=["once", "session", "always", "deny"])
    ch, r = apply([{"run_id": run_id, "request_id": request_id, "choice": "always"}])
    assert r.status_code == 200, r.text
    assert r.json()["decisions"][0]["status"] == "answered"
    assert r.json()["decisions"][0]["choice"] == "always"


def test_frame_choices_still_excludes_anything_outside_the_fixed_universe():
    """A poisoned/malformed `choices` entry in the stored frame can never smuggle in a
    value outside the Literal universe (a) already constrains `choice` to — the
    intersection in `_offered_choices` is defence in depth, not the only gate."""
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id, choices=["once", "sudo_forever", 42])
    r = challenge([{"run_id": run_id, "request_id": request_id, "choice": "always"}])
    assert r.status_code == 400


def test_unknown_decision_is_404():
    r = challenge([{"run_id": "no-such-run", "request_id": "no-such-req", "choice": "once"}])
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"


def test_offered_set_rejection_happens_before_proof_verification_on_apply():
    """The ordering assertion T3 is actually about: `approval_apply` calls
    `_validate_approval_decisions` (400 on an unoffered-but-in-the-Literal choice)
    BEFORE `_verify_proof` ever runs. Proven here with a deliberately bogus assertion
    that would fail verification anyway — if the code verified the proof first, this
    would come back 403 ("assertion_invalid"); it must come back 400 ("bad_request")
    instead, because the choice check runs first and short-circuits before the
    signature is ever inspected."""
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)  # no explicit `choices` -> once/deny only
    garbage_proof = {
        "id": "not-a-real-credential",
        "raw_id": "bm90LWEtcmVhbC1jcmVkZW50aWFs",
        "client_data_json": "eyJnYXJiYWdlIjp0cnVlfQ==",
        "authenticator_data": "Z2FyYmFnZQ==",
        "signature": "Z2FyYmFnZQ==",
        "user_handle": None,
    }
    r = client.post(
        "/api/chat/approval/apply",
        json={
            "decisions": [{"run_id": run_id, "request_id": request_id, "choice": "always"}],
            "assertion": garbage_proof,
        },
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "bad_request"


# --- (c) context-hash binding -------------------------------------------------------
def test_apply_rejects_a_signature_minted_for_a_different_choice():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    ch = challenge([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    assert ch.status_code == 200
    proof = webauthn_assertion(ch.json()["challenge"])
    # Tamper: apply with a DIFFERENT choice than what was signed.
    r = client.post(
        "/api/chat/approval/apply",
        json={"decisions": [{"run_id": run_id, "request_id": request_id, "choice": "deny"}], "assertion": proof},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "assertion_invalid"


def test_apply_rejects_a_signature_replayed_against_a_different_request_id():
    t1, r1, q1 = _fresh_ids()
    t2, r2, q2 = _fresh_ids()
    deliver_approval(t1, r1, q1)
    deliver_approval(t2, r2, q2)
    ch = challenge([{"run_id": r1, "request_id": q1, "choice": "once"}])
    assert ch.status_code == 200
    proof = webauthn_assertion(ch.json()["challenge"])
    r = client.post(
        "/api/chat/approval/apply",
        json={"decisions": [{"run_id": r2, "request_id": q2, "choice": "once"}], "assertion": proof},
    )
    assert r.status_code == 403


def test_a_chat_cookie_purpose_signature_cannot_satisfy_an_approval_apply():
    """Purpose binding, inherited from webauthn_gate's shared challenge cache: a proof
    minted under a different purpose (here "chat") is rejected outright."""
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    chat_ch = client.post("/api/chat/challenge")
    assert chat_ch.status_code == 200
    proof = webauthn_assertion(chat_ch.json()["challenge"])
    r = client.post(
        "/api/chat/approval/apply",
        json={"decisions": [{"run_id": run_id, "request_id": request_id, "choice": "once"}], "assertion": proof},
    )
    assert r.status_code == 403


def test_batch_signature_binds_the_exact_set_not_a_subset():
    t1, r1, q1 = _fresh_ids()
    t2, r2, q2 = _fresh_ids()
    deliver_approval(t1, r1, q1)
    deliver_approval(t2, r2, q2)
    full = [
        {"run_id": r1, "request_id": q1, "choice": "once"},
        {"run_id": r2, "request_id": q2, "choice": "deny"},
    ]
    ch = challenge(full)
    assert ch.status_code == 200
    proof = webauthn_assertion(ch.json()["challenge"])
    # Apply with only ONE of the two decisions the signature actually covered.
    r = client.post(
        "/api/chat/approval/apply",
        json={"decisions": [full[0]], "assertion": proof},
    )
    assert r.status_code == 403


# --- (d) answered-set / CAS ---------------------------------------------------------
def test_applying_twice_is_a_409_not_a_second_write():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    _, r1 = apply([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    assert r1.status_code == 200, r1.text

    r2 = challenge([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "already_answered"
    assert r2.json()["detail"]["choice"] == "once"


def test_double_tap_cannot_flip_an_already_answered_decision_to_a_different_choice():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    apply([{"run_id": run_id, "request_id": request_id, "choice": "once"}])

    r = challenge([{"run_id": run_id, "request_id": request_id, "choice": "deny"}])
    assert r.status_code == 409  # can't even mint a challenge to flip it


def test_answer_approval_cas_is_a_noop_on_an_already_answered_row():
    """Store-level: the second `answer_approval` call for the same key must not
    overwrite the first choice, and must report applied=False."""
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    store.get_or_create_thread(thread_id)
    store.upsert_approval(run_id=run_id, request_id=request_id, thread_id=thread_id, frame={"parts": []})
    row1, applied1 = store.answer_approval(run_id=run_id, request_id=request_id, choice="once")
    assert applied1 is True and row1["choice"] == "once"
    row2, applied2 = store.answer_approval(run_id=run_id, request_id=request_id, choice="deny")
    assert applied2 is False
    assert row2["choice"] == "once"  # unchanged — the second call never overwrote it


def test_forward_status_stays_pending_after_answer():
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    apply([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    row = store.get_approval(run_id=run_id, request_id=request_id)
    assert row["forward_status"] == "pending"


# --- (e) no `all` shortcut, anywhere -------------------------------------------------
def test_top_level_all_field_is_rejected():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    r = client.post(
        "/api/chat/approval/challenge",
        json={"decisions": [{"run_id": run_id, "request_id": request_id, "choice": "once"}], "all": True},
    )
    assert r.status_code == 422


def test_nested_all_field_on_a_decision_is_rejected():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    r = client.post(
        "/api/chat/approval/challenge",
        json={"decisions": [{"run_id": run_id, "request_id": request_id, "choice": "once", "all": True}]},
    )
    assert r.status_code == 422


def test_all_true_on_apply_is_also_rejected():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    ch = challenge([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    assert ch.status_code == 200
    proof = webauthn_assertion(ch.json()["challenge"])
    r = client.post(
        "/api/chat/approval/apply",
        json={
            "decisions": [{"run_id": run_id, "request_id": request_id, "choice": "once"}],
            "assertion": proof,
            "all": True,
        },
    )
    assert r.status_code == 422


# --- batch shape ---------------------------------------------------------------------
def test_empty_decisions_list_is_rejected():
    r = challenge([])
    assert r.status_code == 422


def test_duplicate_decision_in_one_batch_is_rejected():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    dup = {"run_id": run_id, "request_id": request_id, "choice": "once"}
    r = challenge([dup, dict(dup)])
    assert r.status_code == 422


def test_batch_over_the_cap_is_rejected():
    decisions = []
    for _ in range(chat_approval.MAX_DECISIONS_PER_CARD + 1):
        t, run_id, request_id = _fresh_ids()
        deliver_approval(t, run_id, request_id)
        decisions.append({"run_id": run_id, "request_id": request_id, "choice": "once"})
    r = challenge(decisions)
    assert r.status_code == 422


def test_a_multi_decision_batch_applies_every_row_under_one_signature():
    t1, r1, q1 = _fresh_ids()
    t2, r2, q2 = _fresh_ids()
    deliver_approval(t1, r1, q1)
    deliver_approval(t2, r2, q2)
    decisions = [
        {"run_id": r1, "request_id": q1, "choice": "once"},
        {"run_id": r2, "request_id": q2, "choice": "deny"},
    ]
    _, r = apply(decisions)
    assert r.status_code == 200, r.text
    out = {d["request_id"]: d for d in r.json()["decisions"]}
    assert out[q1]["status"] == "answered" and out[q1]["choice"] == "once"
    assert out[q2]["status"] == "answered" and out[q2]["choice"] == "deny"


# --- device-key proof works exactly like the passkey path -----------------------------
def test_devicekey_signature_also_satisfies_an_approval_apply():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    enrol()
    _, r = apply(
        [{"run_id": run_id, "request_id": request_id, "choice": "once"}],
        assertion_fn=lambda c: {"devicekey_assertion": dk_assertion(c)},
    )
    assert r.status_code == 200, r.text


def test_an_approval_works_on_a_device_key_only_install():
    """The app pairs a device key and never holds a passkey, so the challenge must not
    require one. The test above passes with a passkey seeded and hid this (412)."""
    (TMP / "passkeys.json").write_text("[]")
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    enrol()
    _, r = apply(
        [{"run_id": run_id, "request_id": request_id, "choice": "once"}],
        assertion_fn=lambda c: {"devicekey_assertion": dk_assertion(c)},
    )
    assert r.status_code == 200, r.text


def test_apply_412s_with_neither_passkey_nor_devicekey_enrolled(monkeypatch):
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    monkeypatch.setattr(dk, "DEVICEKEYS_JSON", TMP / "no-such-devicekeys.json")
    ch = challenge([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    assert ch.status_code == 200
    r = client.post(
        "/api/chat/approval/apply",
        json={
            "decisions": [{"run_id": run_id, "request_id": request_id, "choice": "once"}],
            "devicekey_assertion": dk_assertion(ch.json()["challenge"]),
        },
    )
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_devicekey"


# --- no secret, host path, or credential in any error body --------------------------
def _assert_no_secrets_leaked(resp) -> None:
    body = resp.text
    for forbidden in FORBIDDEN_IN_ERRORS:
        assert forbidden not in body, f"{forbidden!r} leaked into error body: {body}"


def test_no_secrets_leak_across_every_approval_failure_path():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)

    _assert_no_secrets_leaked(challenge([{"run_id": run_id, "request_id": request_id, "choice": "approve_forever"}]))
    _assert_no_secrets_leaked(challenge([{"run_id": run_id, "request_id": request_id, "choice": "always"}]))
    _assert_no_secrets_leaked(challenge([{"run_id": "no-such-run", "request_id": "no-such-req", "choice": "once"}]))

    ch, apply_resp = apply([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    _assert_no_secrets_leaked(apply_resp)
    _assert_no_secrets_leaked(challenge([{"run_id": run_id, "request_id": request_id, "choice": "once"}]))  # 409 now

    t2, r2, q2 = _fresh_ids()
    deliver_approval(t2, r2, q2)
    ch2 = challenge([{"run_id": r2, "request_id": q2, "choice": "once"}])
    tampered = client.post(
        "/api/chat/approval/apply",
        json={"decisions": [{"run_id": r2, "request_id": q2, "choice": "deny"}], "assertion": webauthn_assertion(ch2.json()["challenge"])},
    )
    _assert_no_secrets_leaked(tampered)

    t3, r3, q3 = _fresh_ids()
    deliver_approval(t3, r3, q3)
    _assert_no_secrets_leaked(
        client.post(
            "/api/chat/approval/apply",
            json={"decisions": [{"run_id": r3, "request_id": q3, "choice": "once"}], "assertion": {
                "id": "x", "raw_id": "eA==", "client_data_json": "e30=", "authenticator_data": "eA==", "signature": "eA==",
            }},
        )
    )


# --- phase 3: the answered decision reaches the gateway --------------------------------

import http.server  # noqa: E402
import socket  # noqa: E402
import threading  # noqa: E402

import chat.routes as chat_routes  # noqa: E402


class _RecordHandler(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        type(self).seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true, "resolved": 1}')

    def log_message(self, *a):
        pass


def _serve():
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _RecordHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def test_apply_forwards_the_decision_and_flips_forward_status(monkeypatch):
    _RecordHandler.seen = []
    httpd = _serve()
    try:
        monkeypatch.setattr(chat_routes, "HERMES_API_BASE", f"http://127.0.0.1:{httpd.server_address[1]}")
        thread_id, run_id, request_id = _fresh_ids()
        deliver_approval(thread_id, run_id, request_id)
        _, r = apply([{"run_id": run_id, "request_id": request_id, "choice": "deny"}])
        assert r.status_code == 200, r.text
        d = r.json()["decisions"][0]
        assert d["status"] == "answered" and d["choice"] == "deny"
        assert d["forward_status"] == "forwarded" and d["forward_reason"] == ""
        sent = _RecordHandler.seen[-1]
        assert sent["path"] == "/api/platforms/hub/events"
        assert sent["auth"] == f"Bearer {PLATFORM_SECRET}"
        assert sent["body"] == {"kind": "approval_decision", "thread_id": thread_id, "run_id": run_id,
                                "request_id": request_id, "choice": "deny"}
        store = chat_platform.get_store()
        row = store.get_approval(run_id=run_id, request_id=request_id)
        assert row["forward_status"] == "forwarded"
        answered = [e for e in store.list_events_after(thread_id, 0) if e["type"] == "approval.answered"]
        assert answered and answered[-1]["payload"] == {"run_id": run_id, "request_id": request_id,
                                                        "choice": "deny", "forward_status": "forwarded"}
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_apply_without_a_gateway_stays_answered_but_pending():
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    _, r = apply([{"run_id": run_id, "request_id": request_id, "choice": "once"}])
    assert r.status_code == 200, r.text
    d = r.json()["decisions"][0]
    assert d["status"] == "answered"
    assert d["forward_status"] == "pending" and d["forward_reason"] == "gateway not configured"
    row = chat_platform.get_store().get_approval(run_id=run_id, request_id=request_id)
    assert row["answered"] == 1 and row["choice"] == "once" and row["forward_status"] == "pending"


def test_forward_failure_never_echoes_the_gateway_or_key(monkeypatch):
    monkeypatch.setattr(chat_routes, "HERMES_API_BASE", "http://127.0.0.1:1")
    thread_id, run_id, request_id = _fresh_ids()
    deliver_approval(thread_id, run_id, request_id)
    _, r = apply([{"run_id": run_id, "request_id": request_id, "choice": "deny"}])
    assert r.status_code == 200, r.text
    assert r.json()["decisions"][0]["forward_reason"] == "gateway unreachable"
    for needle in FORBIDDEN_IN_ERRORS:
        assert needle not in r.text


def test_answering_closes_the_transcripts_own_copy_of_the_approval():
    """The approvals table and the transcript are two records of the same event.
    Answering used to write only the former, so the card in the thread still read
    "Waiting for your approval" long after it had been approved (the user, 2026-09-22)."""
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    body = {
        "thread_id": thread_id,
        "run_id": run_id,
        "parts": [{
            "type": "tool_call",
            "tool_name": "terminal",
            "tool_call_id": request_id,
            "state": "approval_requested",
            "status": "running",
        }],
        "attention": {"kind": "approval", "request_id": request_id, "run_id": run_id, "summary": "terminal: ls"},
    }
    assert client.post("/api/platform/hub/deliver", json=body, headers=PLATFORM_AUTH).status_code == 200

    def transcript_part() -> dict:
        for message in store.list_messages(thread_id, after_seq=0, limit=100):
            for part in message["parts"]:
                if part.get("tool_call_id") == request_id:
                    return part
        raise AssertionError("approval part missing from the transcript")

    assert transcript_part()["state"] == "approval_requested"

    store.answer_approval(run_id=run_id, request_id=request_id, choice="once")

    part = transcript_part()
    assert part["state"] == "answered"
    assert part["resolved_choice"] == "once"
    assert part["status"] == "complete"


def test_answering_tells_every_open_client_to_close_the_card():
    """The phone that answered already knows; a second client only finds out from
    the event log, so the part change has to be an event, not just a row edit."""
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    body = {
        "thread_id": thread_id,
        "run_id": run_id,
        "parts": [{"type": "tool_call", "tool_name": "terminal", "tool_call_id": request_id,
                   "state": "approval_requested", "status": "running"}],
        "attention": {"kind": "approval", "request_id": request_id, "run_id": run_id, "summary": "terminal: ls"},
    }
    assert client.post("/api/platform/hub/deliver", json=body, headers=PLATFORM_AUTH).status_code == 200
    before = store.list_events_after(thread_id, 0)

    store.answer_approval(run_id=run_id, request_id=request_id, choice="deny")

    new = store.list_events_after(thread_id, before[-1]["seq"] if before else 0)
    upserts = [e for e in new if e["type"] == "part.upsert"]
    assert len(upserts) == 1, [e["type"] for e in new]
    assert upserts[0]["payload"]["part"]["state"] == "answered"
    assert upserts[0]["payload"]["part"]["resolved_choice"] == "deny"


def test_a_second_answer_does_not_re_emit_the_part_change():
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    body = {
        "thread_id": thread_id,
        "run_id": run_id,
        "parts": [{"type": "tool_call", "tool_name": "terminal", "tool_call_id": request_id,
                   "state": "approval_requested", "status": "running"}],
        "attention": {"kind": "approval", "request_id": request_id, "run_id": run_id, "summary": "terminal: ls"},
    }
    assert client.post("/api/platform/hub/deliver", json=body, headers=PLATFORM_AUTH).status_code == 200
    store.answer_approval(run_id=run_id, request_id=request_id, choice="once")
    mid = store.list_events_after(thread_id, 0)[-1]["seq"]
    store.answer_approval(run_id=run_id, request_id=request_id, choice="deny")
    after = store.list_events_after(thread_id, mid)
    assert [e for e in after if e["type"] == "part.upsert"] == []


def _approval_part(request_id: str) -> dict:
    return {"type": "tool_call", "tool_name": "terminal", "tool_call_id": request_id,
            "state": "approval_requested", "status": "running"}


def _open_approval(thread_id: str, run_id: str, request_id: str) -> None:
    body = {
        "thread_id": thread_id, "run_id": run_id, "parts": [_approval_part(request_id)],
        "attention": {"kind": "approval", "request_id": request_id, "run_id": run_id, "summary": "terminal: ls"},
    }
    assert client.post("/api/platform/hub/deliver", json=body, headers=PLATFORM_AUTH).status_code == 200


def _card_state(store, thread_id: str, request_id: str) -> dict:
    for message in store.list_messages(thread_id, after_seq=0, limit=100):
        for part in message["parts"]:
            if part.get("tool_call_id") == request_id and part.get("state") in ("approval_requested", "answered"):
                return part
    raise AssertionError("approval part missing")


def test_an_approval_answered_elsewhere_closes_when_its_tool_runs():
    """A Discord button, a typed /approve or the agent's own timeout sends no
    event this Hub would recognise. What eventually arrives is the tool call
    itself, carrying the same id — and until that closed the card, the thread
    read "Waiting for your approval" forever (gap A26)."""
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    _open_approval(thread_id, run_id, request_id)
    assert _card_state(store, thread_id, request_id)["state"] == "approval_requested"

    done = {"thread_id": thread_id, "run_id": run_id, "parts": [
        {"type": "tool_call", "tool_name": "terminal", "tool_call_id": request_id,
         "status": "complete", "result": "ok"}]}
    assert client.post("/api/platform/hub/deliver", json=done, headers=PLATFORM_AUTH).status_code == 200

    card = _card_state(store, thread_id, request_id)
    assert card["state"] == "answered"
    assert card["resolved_choice"] == "elsewhere"


def test_closing_elsewhere_never_invents_a_choice_in_the_approvals_table():
    """The Hub never learns WHICH choice was made elsewhere. Recording a guess
    would make the local answered-set lie."""
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    _open_approval(thread_id, run_id, request_id)
    done = {"thread_id": thread_id, "run_id": run_id, "parts": [
        {"type": "tool_call", "tool_name": "terminal", "tool_call_id": request_id, "status": "complete"}]}
    client.post("/api/platform/hub/deliver", json=done, headers=PLATFORM_AUTH)
    row = store.get_approval(run_id=run_id, request_id=request_id)
    assert row["answered"] == 0
    assert row["choice"] is None


def test_the_inbox_row_closes_too_so_the_badge_clears():
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    _open_approval(thread_id, run_id, request_id)
    assert any(a["thread_id"] == thread_id for a in store.list_open_attention(limit=200))
    done = {"thread_id": thread_id, "run_id": run_id, "parts": [
        {"type": "tool_call", "tool_name": "terminal", "tool_call_id": request_id, "status": "error", "error": "denied"}]}
    client.post("/api/platform/hub/deliver", json=done, headers=PLATFORM_AUTH)
    assert not any(a["thread_id"] == thread_id for a in store.list_open_attention(limit=200))


def test_the_approval_card_itself_does_not_close_the_card_it_just_opened():
    """The delivery that OPENS an approval also carries a tool_call part with
    that id. Closing on it would settle the card before the user ever saw it."""
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    _open_approval(thread_id, run_id, request_id)
    assert _card_state(store, thread_id, request_id)["state"] == "approval_requested"


def test_closing_does_not_stamp_the_tools_own_result_row():
    """The completion carries the same tool_call_id and is not an approval;
    stamping it would print "Answered somewhere else" under a plain result."""
    store = chat_platform.get_store()
    thread_id, run_id, request_id = _fresh_ids()
    _open_approval(thread_id, run_id, request_id)
    done = {"thread_id": thread_id, "run_id": run_id, "parts": [
        {"type": "tool_call", "tool_name": "terminal", "tool_call_id": request_id, "status": "complete", "result": "ok"}]}
    client.post("/api/platform/hub/deliver", json=done, headers=PLATFORM_AUTH)
    stamped = [
        part
        for message in store.list_messages(thread_id, after_seq=0, limit=100)
        for part in message["parts"]
        if part.get("resolved_choice") == "elsewhere"
    ]
    assert len(stamped) == 1, stamped
