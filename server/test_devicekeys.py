"""Device-key gate tests — the native-app second verifier alongside WebAuthn.

Offline: everything runs against the FastAPI app in-process (TestClient), with the
passkey store, device-key store, topics config and decisions dir all pointed at a
tmpdir. No live hub-api, no bridge, no network.

The threat model these assert, in order:
  * enrolment is only possible with a live, unexpired, unused, passkey-vouched code
  * a device-key proof is bound to ONE challenge, ONE purpose and ONE context hash
  * an unknown key, a wrong key, a tampered payload or a replayed proof all fail closed
  * the device key can never mint another device key (no privilege propagation)
  * the existing WebAuthn path behaves exactly as before
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import pathlib
import sys
import tempfile
import threading
import time

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_PASSKEYS"] = str(TMP / "passkeys.json")
os.environ["HUB_DEVICEKEYS"] = str(TMP / "devicekeys.json")
os.environ["HUB_RP_ID"] = "hub.test"
os.environ["HUB_ORIGIN"] = "https://hub.test"
os.environ["HUB_TOPICS_CONFIG"] = str(TMP / "telegram-topics.json")
os.environ["HUB_TOPICS_LIVE"] = str(TMP / "telegram-topics.live.json")
os.environ["HUB_DECISIONS_DIR"] = str(TMP / "decisions")
os.environ["HUB_BRIEFING_RULES"] = str(TMP / "briefing_rules.json")
os.environ["HUB_BRIDGE_URL"] = ""

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

import app as mod  # noqa: E402
import devicekeys as dk  # noqa: E402
import webauthn_gate as wa  # noqa: E402

client = TestClient(mod.app)

RP_ID = "hub.test"
ORIGIN = "https://hub.test"


# --- helpers ---------------------------------------------------------------
def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def b64u_decode(val: str) -> bytes:
    return base64.urlsafe_b64decode(val + "=" * (-len(val) % 4))


PASSKEY = ec.generate_private_key(ec.SECP256R1())
CRED_ID = bytes(range(32))
APP_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


def cose_p256(pub: ec.EllipticCurvePublicKey) -> bytes:
    n = pub.public_numbers()
    return cbor2.dumps(
        {1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")}
    )


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
    """A real ES256 WebAuthn assertion over the cached challenge (UP|UV flags set)."""
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
    """The canonical device-key proof: ECDSA-P256-SHA256 over the RAW challenge bytes
    (base64url-decoded) — the same bytes a WebAuthn authenticator puts in clientDataJSON."""
    sig = priv.sign(b64u_decode(challenge_b64u), ec.ECDSA(hashes.SHA256()))
    return {
        "key_id": key_id or key_id_of(priv),
        "challenge_b64": challenge_b64u,
        "signature_b64": base64.b64encode(sig).decode(),
    }


WRITE_A = {"action": "config.set", "key": "model.default", "value": "claude-sonnet-4-6"}
WRITE_B = {"action": "config.set", "key": "model.default", "value": "claude-haiku-4-5"}


def action_challenge(body: dict) -> str:
    r = client.post("/api/action/challenge", json={"request": body})
    assert r.status_code == 200, r.text
    return r.json()["challenge"]


def terminal_challenge() -> str:
    r = client.post("/api/terminal/challenge")
    assert r.status_code == 200, r.text
    return r.json()["challenge"]


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
    # The env above only takes effect if THIS module imports app first; pin the module
    # globals too so the suite is independent of pytest's collection order.
    monkeypatch.setattr(wa, "PASSKEYS_JSON", TMP / "passkeys.json")
    monkeypatch.setattr(wa, "RP_ID", RP_ID)
    monkeypatch.setattr(wa, "ORIGIN", ORIGIN)
    monkeypatch.setattr(dk, "DEVICEKEYS_JSON", TMP / "devicekeys.json")
    monkeypatch.setattr(mod, "TOPICS_CONFIG_FILE", TMP / "telegram-topics.json")
    monkeypatch.setattr(mod, "TOPICS_LIVE_FILE", TMP / "telegram-topics.live.json")
    monkeypatch.setattr(mod, "DECISIONS_DIR", TMP / "decisions")
    monkeypatch.setattr(mod, "DECISIONS_LEDGER", TMP / "decisions" / "responses.jsonl")
    monkeypatch.setattr(mod, "BRIEFING_RULES", TMP / "briefing_rules.json")
    seed_passkey()
    (TMP / "devicekeys.json").unlink(missing_ok=True)
    (TMP / "briefing_rules.json").unlink(missing_ok=True)
    dk._enroll_codes.clear()
    dk._attempt_times.clear()
    dk._global_attempts.clear()
    wa._cache._store.clear()
    monkeypatch.setattr(mod, "_bridge_write", lambda argv, timeout=None: {"code": 0, "stdout": "ok", "stderr": ""})
    yield


# --- enrolment -------------------------------------------------------------
def test_register_with_a_valid_code_stores_the_key():
    key_id = enrol()
    assert key_id == key_id_of(APP_KEY)
    status = client.get("/api/devicekey/status").json()
    assert status["paired"] is True and status["count"] == 1
    assert status["devices"][0]["label"] == "iPhone"
    assert "key_id" not in status["devices"][0]
    # the store never holds anything but the PUBLIC key
    stored = json.loads((TMP / "devicekeys.json").read_text())
    assert set(stored[0]) == {"key_id", "spki_der_b64", "label", "created_at"}
    assert (TMP / "devicekeys.json").stat().st_mode & 0o777 == 0o600


def test_register_rejects_an_unknown_code():
    dk.mint_enroll_code()
    r = client.post(
        "/api/devicekey/register",
        json={"code": "ZZZZZZ", "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "enroll_code_invalid"
    assert not dk.has_devicekey()


def test_register_rejects_an_expired_code(monkeypatch):
    minted = dk.mint_enroll_code()
    real_monotonic = time.monotonic
    monkeypatch.setattr(dk.time, "monotonic", lambda: real_monotonic() + dk.ENROLL_CODE_TTL_S + 1)
    r = client.post(
        "/api/devicekey/register",
        json={"code": minted["code"], "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    )
    assert r.status_code == 403
    assert not dk.has_devicekey()


def test_register_rejects_a_replayed_code():
    code = dk.mint_enroll_code()["code"]
    body = {"code": code, "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()}
    assert client.post("/api/devicekey/register", json=body).status_code == 200
    replay = client.post(
        "/api/devicekey/register",
        json={"code": code, "spki_der_b64": base64.b64encode(spki_der(OTHER_KEY)).decode()},
    )
    assert replay.status_code == 403
    assert client.get("/api/devicekey/status").json()["count"] == 1


def test_minting_a_new_code_invalidates_the_previous_one():
    first = dk.mint_enroll_code()["code"]
    dk.mint_enroll_code()
    r = client.post(
        "/api/devicekey/register",
        json={"code": first, "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    )
    assert r.status_code == 403


def test_register_rate_limits_wrong_guesses_without_burning_the_code(monkeypatch):
    """A tailnet peer can DELAY a pairing but must not be able to destroy the code."""
    code = dk.mint_enroll_code()["code"]
    wrong = "A" * 6 if code != "A" * 6 else "B" * 6
    spki = base64.b64encode(spki_der(APP_KEY)).decode()
    for _ in range(dk.ENROLL_CODE_MAX_ATTEMPTS):
        assert client.post("/api/devicekey/register", json={"code": wrong, "spki_der_b64": spki}).status_code == 403
    # throttled: while the window is full even the CORRECT code is refused...
    assert client.post("/api/devicekey/register", json={"code": code, "spki_der_b64": spki}).status_code == 403
    assert not dk.has_devicekey()
    # ...but the code survived, and works as soon as the window drains.
    real_monotonic = time.monotonic
    monkeypatch.setattr(
        dk.time, "monotonic", lambda: real_monotonic() + dk.ENROLL_CODE_ATTEMPT_WINDOW_S + 1
    )
    assert client.post("/api/devicekey/register", json={"code": code, "spki_der_b64": spki}).status_code == 200


def test_a_correct_code_resets_the_throttle():
    code = dk.mint_enroll_code()["code"]
    spki = base64.b64encode(spki_der(APP_KEY)).decode()
    for _ in range(dk.ENROLL_CODE_MAX_ATTEMPTS - 1):
        client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": spki})
    assert client.post("/api/devicekey/register", json={"code": code, "spki_der_b64": spki}).status_code == 200
    assert dk._attempt_times == {} and dk._global_attempts == []


def test_every_enrol_failure_is_indistinguishable():
    """No liveness oracle: "no code outstanding" and "wrong code" must not be tellable
    apart, or an unauthenticated poller learns exactly when to start guessing."""
    spki = base64.b64encode(spki_der(APP_KEY)).decode()
    no_code = client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": spki})
    while dk.mint_enroll_code()["code"] == "ZZZZZZ":  # 1-in-2^30, but be deterministic
        pass
    wrong_code = client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": spki})
    dk._enroll_codes.clear()
    expired = client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": spki})
    assert no_code.status_code == wrong_code.status_code == expired.status_code == 403
    assert no_code.json() == wrong_code.json() == expired.json()


def test_register_refuses_to_overwrite_an_unparseable_store():
    (TMP / "devicekeys.json").write_text("{ this is not json")
    code = dk.mint_enroll_code()["code"]
    spki = base64.b64encode(spki_der(APP_KEY)).decode()
    r = client.post("/api/devicekey/register", json={"code": code, "spki_der_b64": spki})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "devicekey_store_unreadable"
    assert (TMP / "devicekeys.json").read_text() == "{ this is not json"  # untouched
    # the store check runs BEFORE the code is spent, so the code is still good
    (TMP / "devicekeys.json").unlink()
    assert client.post("/api/devicekey/register", json={"code": code, "spki_der_b64": spki}).status_code == 200


def test_revoke_refuses_to_overwrite_an_unparseable_store():
    enrol()
    (TMP / "devicekeys.json").write_text("[[[")
    req = {"action": "devicekey.revoke", "all": True}
    ch = action_challenge(req)
    r = client.post("/api/action/apply", json={"request": req, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "devicekey_store_unreadable"
    assert (TMP / "devicekeys.json").read_text() == "[[["


def test_register_rejects_a_non_p256_key():
    code = dk.mint_enroll_code()["code"]
    rsa_spki = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    r = client.post(
        "/api/devicekey/register",
        json={"code": code, "spki_der_b64": base64.b64encode(rsa_spki).decode()},
    )
    assert r.status_code == 400
    assert not dk.has_devicekey()


def test_register_rejects_garbage_spki():
    code = dk.mint_enroll_code()["code"]
    r = client.post(
        "/api/devicekey/register",
        json={"code": code, "spki_der_b64": base64.b64encode(b"not a key").decode()},
    )
    assert r.status_code == 400


def test_a_non_ascii_code_is_a_normal_failed_attempt_not_a_500():
    """hmac.compare_digest raises TypeError on a non-ASCII str: that was an unauthenticated
    500 AND an unmetered attempt. Every one of these must be an ordinary counted 403."""
    dk.mint_enroll_code()
    spki = base64.b64encode(spki_der(APP_KEY)).decode()
    baseline = client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": spki})
    assert baseline.status_code == 403
    # A lone surrogate survives JSON decoding as a str and would break a naive .encode().
    lone = client.post(
        "/api/devicekey/register",
        content=b'{"code": "\\ud800\\ud800", "spki_der_b64": "' + spki.encode() + b'"}',
        headers={"content-type": "application/json"},
    )
    assert lone.status_code == 403, lone.text
    assert lone.json() == baseline.json()
    for bad_code in ["\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9", "\u4f60\u597d", "\u00c9" * 30]:
        r = client.post("/api/devicekey/register", json={"code": bad_code, "spki_der_b64": spki})
        assert r.status_code == 403, (bad_code, r.status_code, r.text)
        assert r.json() == baseline.json()
    # ...and every one of those was METERED, not bypassed: the peer bucket is now full.
    assert sum(len(v) for v in dk._attempt_times.values()) == dk.ENROLL_CODE_MAX_ATTEMPTS


def test_the_limiter_is_keyed_per_peer():
    """One flooding caller must not consume another caller's budget."""
    code = dk.mint_enroll_code()["code"]
    spki = base64.b64encode(spki_der(APP_KEY)).decode()
    flooder = {"X-Forwarded-For": "203.0.113.9"}
    for _ in range(dk.ENROLL_CODE_MAX_ATTEMPTS):
        assert client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": spki},
                           headers=flooder).status_code == 403
    assert client.post("/api/devicekey/register", json={"code": code, "spki_der_b64": spki},
                       headers=flooder).status_code == 403          # flooder is throttled
    r = client.post("/api/devicekey/register", json={"code": code, "spki_der_b64": spki},
                    headers={"X-Forwarded-For": "203.0.113.2"})      # a different peer is not
    assert r.status_code == 200, r.text


def test_the_global_tier_bounds_a_peer_key_rotating_attacker():
    """Per-peer keying is evadable by forging the header; the global tier is not."""
    monkey = base64.b64encode(spki_der(APP_KEY)).decode()
    dk.mint_enroll_code()
    for i in range(dk.ENROLL_CODE_GLOBAL_MAX_ATTEMPTS):
        r = client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": monkey},
                        headers={"X-Forwarded-For": f"203.0.113.{i % 254 + 1}"})
        assert r.status_code == 403
    assert len(dk._global_attempts) == dk.ENROLL_CODE_GLOBAL_MAX_ATTEMPTS
    blocked = client.post("/api/devicekey/register", json={"code": "ZZZZZZ", "spki_der_b64": monkey},
                          headers={"X-Forwarded-For": "203.0.113.99"})
    assert blocked.status_code == 403
    assert len(dk._global_attempts) == dk.ENROLL_CODE_GLOBAL_MAX_ATTEMPTS  # blocked attempts are not recorded
    assert len(dk._attempt_times) <= dk.ENROLL_PEER_TABLE_MAX              # peer table stays bounded


def test_a_concurrent_revoke_is_not_lost_to_an_in_flight_register(monkeypatch):
    """The whole load -> mutate -> save must be serialized. Guarding only the save let a
    revoke land between another caller's load and save, resurrecting the revoked key."""
    enrol()  # APP_KEY paired
    code = dk.mint_enroll_code()["code"]
    register_reached_the_critical_section = threading.Event()
    revoke_result: dict[str, Any] = {}

    def revoke_all() -> None:
        register_reached_the_critical_section.wait(5)
        revoke_result["r"] = dk.revoke_devicekey(all_keys=True)

    real_parse = dk._load_p256_public

    def parse_but_yield(der: bytes):
        register_reached_the_critical_section.set()
        time.sleep(0.25)  # the revoke thread is now blocked on _store_lock
        return real_parse(der)

    monkeypatch.setattr(dk, "_load_p256_public", parse_but_yield)
    thread = threading.Thread(target=revoke_all)
    thread.start()
    dk.register_devicekey(code, base64.b64encode(spki_der(OTHER_KEY)).decode(), "iPad")
    thread.join(10)
    assert not thread.is_alive()
    # The revoke was serialized AFTER the register, so it swept both keys and said so.
    assert revoke_result["r"]["count"] == 0 and revoke_result["r"]["revoked"] == 2
    assert dk.load_devicekeys() == []  # nothing resurrected


# --- the enrol code is minted ONLY behind the human passkey gate ------------
def test_enroll_code_action_via_webauthn_mints_a_usable_code():
    req = {"action": "devicekey.enroll_code"}
    ch = action_challenge(req)
    r = client.post("/api/action/apply", json={"request": req, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["code"]) == 6 and body["expires_at"]
    reg = client.post(
        "/api/devicekey/register",
        json={"code": body["code"], "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    )
    assert reg.status_code == 200


def test_enroll_code_action_refuses_a_devicekey_proof():
    """No privilege propagation: a paired device can never mint another pairing."""
    enrol()
    req = {"action": "devicekey.enroll_code"}
    ch = action_challenge(req)
    r = client.post("/api/action/apply", json={"request": req, "devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "webauthn_required"


def test_revoke_action_refuses_a_devicekey_proof_and_works_via_webauthn():
    key_id = enrol()
    req = {"action": "devicekey.revoke", "key_id": key_id}
    ch = action_challenge(req)
    assert client.post("/api/action/apply", json={"request": req, "devicekey_assertion": dk_assertion(ch)}).status_code == 403
    ch = action_challenge(req)
    r = client.post("/api/action/apply", json={"request": req, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 200, r.text
    assert not dk.has_devicekey()


def test_revoke_all_when_key_id_is_omitted():
    """The status endpoint discloses no key ids, so "unpair everything" must not need one."""
    enrol()
    enrol(priv=OTHER_KEY, label="iPad")
    assert client.get("/api/devicekey/status").json()["count"] == 2
    req = {"action": "devicekey.revoke", "all": True}
    ch = action_challenge(req)
    r = client.post("/api/action/apply", json={"request": req, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 200, r.text
    assert r.json()["revoked"] == 2 and r.json()["count"] == 0
    assert not dk.has_devicekey()


def test_revoke_refuses_a_request_with_no_explicit_target():
    """A dropped or misspelled key_id must NOT silently mean revoke-everything."""
    enrol()
    assert client.post("/api/action/challenge", json={"request": {"action": "devicekey.revoke"}}).status_code == 422
    typo = {"action": "devicekey.revoke", "keyid": key_id_of(APP_KEY)}
    assert client.post("/api/action/challenge", json={"request": typo}).status_code == 422
    assert dk.has_devicekey()


def test_revoke_refuses_both_targets_at_once():
    enrol()
    both = {"action": "devicekey.revoke", "key_id": key_id_of(APP_KEY), "all": True}
    assert client.post("/api/action/challenge", json={"request": both}).status_code == 422


def test_write_request_rejects_unknown_fields():
    """extra="forbid" — a typo must fail loudly, not be silently dropped."""
    bad = {"action": "config.set", "key": "model.default", "value": "x", "valu": "y"}
    assert client.post("/api/action/challenge", json={"request": bad}).status_code == 422
    # ...and every field the PWA actually sends still validates.
    assert client.post("/api/action/challenge", json={"request": WRITE_A}).status_code == 200


def test_revoke_rejects_a_malformed_key_id():
    enrol()
    req = {"action": "devicekey.revoke", "key_id": "nope"}
    assert client.post("/api/action/challenge", json={"request": req}).status_code == 400


def test_devicekey_status_discloses_no_more_than_passkey_status():
    enrol()
    device = client.get("/api/devicekey/status").json()["devices"][0]
    credential = client.get("/api/passkey/status").json()["credentials"][0]
    assert set(device) == set(credential) == {"label", "created_at"}


# --- the per-action gate ---------------------------------------------------
def test_apply_with_a_good_devicekey_signature_succeeds():
    enrol()
    ch = action_challenge(WRITE_A)
    r = client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "applied"


def test_apply_with_a_tampered_context_fails():
    """Challenge issued for WRITE_A, applied against WRITE_B — context hash mismatch."""
    enrol()
    ch = action_challenge(WRITE_A)
    r = client.post("/api/action/apply", json={"request": WRITE_B, "devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "assertion_invalid"


def test_apply_with_an_unknown_key_id_fails():
    enrol()
    ch = action_challenge(WRITE_A)
    proof = dk_assertion(ch)
    proof["key_id"] = "0" * 64
    assert client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": proof}).status_code == 403


def test_apply_with_a_wrong_key_signature_fails():
    """Correct key_id, signature from a different P-256 key."""
    enrol()
    ch = action_challenge(WRITE_A)
    proof = dk_assertion(ch, priv=OTHER_KEY, key_id=key_id_of(APP_KEY))
    assert client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": proof}).status_code == 403


def test_apply_with_a_signature_over_a_different_purpose_fails():
    """A terminal-purpose challenge signed correctly is useless against an action."""
    enrol()
    ch = terminal_challenge()
    r = client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 403


def test_apply_with_an_unminted_challenge_fails():
    enrol()
    forged = b64u(os.urandom(32))
    assert client.post(
        "/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": dk_assertion(forged)}
    ).status_code == 403


def test_devicekey_proof_is_single_use():
    enrol()
    ch = action_challenge(WRITE_A)
    proof = dk_assertion(ch)
    assert client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": proof}).status_code == 200
    assert client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": proof}).status_code == 403


def test_hostile_strings_in_a_proof_are_403_not_500():
    """The apply models validate BEFORE any proof is checked, so a constrained-str field
    there would hand an unauthenticated caller a 500 on every gated endpoint."""
    enrol()
    for field, value in [
        ("key_id", "\ud800\ud800"), ("challenge_b64", "\ud800"), ("signature_b64", "\ud800"),
        ("key_id", "\u00e9" * 500), ("challenge_b64", "A" * 5000), ("signature_b64", "A" * 5000),
    ]:
        ch = action_challenge(WRITE_A)
        proof = dk_assertion(ch)
        proof[field] = value
        # json.dumps(ensure_ascii=True) emits \ud800 as an ASCII escape: httpx cannot
        # encode a lone surrogate itself, but the server must survive decoding one.
        body = json.dumps({"request": WRITE_A, "devicekey_assertion": proof}).encode()
        r = client.post("/api/action/apply", content=body, headers={"content-type": "application/json"})
        assert r.status_code == 403, (field, r.status_code, r.text[:200])
    # a surrogate in the register payload is likewise an ordinary 403, never a 500
    dk.mint_enroll_code()
    r = client.post(
        "/api/devicekey/register",
        content=b'{"code": "AAAAAA", "spki_der_b64": "\\ud800", "label": "\\ud800"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 403, r.text[:200]


def test_apply_with_a_flipped_signature_bit_fails():
    enrol()
    ch = action_challenge(WRITE_A)
    proof = dk_assertion(ch)
    raw = bytearray(base64.b64decode(proof["signature_b64"]))
    raw[-1] ^= 0x01
    proof["signature_b64"] = base64.b64encode(bytes(raw)).decode()
    assert client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": proof}).status_code == 403


def test_apply_with_no_devicekey_enrolled_fails_closed():
    ch = action_challenge(WRITE_A)
    r = client.post("/api/action/apply", json={"request": WRITE_A, "devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_devicekey"


def test_apply_requires_exactly_one_proof():
    enrol()
    ch = action_challenge(WRITE_A)
    assert client.post("/api/action/apply", json={"request": WRITE_A}).status_code == 422
    ch2 = action_challenge(WRITE_A)
    both = {"request": WRITE_A, "assertion": webauthn_assertion(ch2), "devicekey_assertion": dk_assertion(ch)}
    assert client.post("/api/action/apply", json=both).status_code == 422


# --- terminal --------------------------------------------------------------
def _cookie_shape(set_cookie: str) -> dict[str, str | bool]:
    parts = [p.strip() for p in set_cookie.split(";")]
    name, _, _value = parts[0].partition("=")
    shape: dict[str, str | bool] = {"name": name}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        shape[k.lower()] = v or True
    return shape


def test_terminal_session_via_devicekey_mints_the_same_cookie_shape():
    enrol()
    ch = terminal_challenge()
    wa_resp = client.post("/api/terminal/session", json={"assertion": webauthn_assertion(ch)})
    assert wa_resp.status_code == 200, wa_resp.text
    ch = terminal_challenge()
    dk_resp = client.post("/api/terminal/session", json={"devicekey_assertion": dk_assertion(ch)})
    assert dk_resp.status_code == 200, dk_resp.text
    assert dk_resp.json() == {"ok": True}
    wa_shapes = [_cookie_shape(c) for c in wa_resp.headers.get_list("set-cookie")]
    dk_shapes = [_cookie_shape(c) for c in dk_resp.headers.get_list("set-cookie")]
    assert wa_shapes == dk_shapes
    # one session, two paths: the ttyd proxy and the tmux reads
    assert sorted(s["path"] for s in wa_shapes) == ["/api/tmux", "/terminal"]
    for shape in wa_shapes:
        assert shape["name"] == "hub_term_session"
        assert shape["httponly"] is True and shape["secure"] is True
        assert shape["samesite"].lower() == "strict"


def _terminal_token() -> str:
    r = client.post("/api/terminal/session", json={"devicekey_assertion": dk_assertion(terminal_challenge())})
    assert r.status_code == 200, r.text
    raw = r.headers.get_list("set-cookie")[0]
    return raw.split(";", 1)[0].partition("=")[2]


@pytest.mark.parametrize("path", ["/api/tmux/sessions", "/api/tmux/history"])
def test_tmux_reads_need_the_terminal_session(path, monkeypatch):
    """Host session names, working directories and transcript titles used to be served
    to anyone who could reach the port. They now need the terminal session cookie."""
    calls = []
    monkeypatch.setattr(mod, "_tmuxd_request",
                        lambda method, p, body=None: calls.append(p) or (200, {"sessions": [], "history": []}))
    enrol()
    r = client.get(path)
    assert r.status_code == 401, r.text
    assert r.json()["detail"]["code"] == "terminal_locked"
    r = client.get(path, headers={"Cookie": "hub_term_session=not-a-session"})
    assert r.status_code == 401, r.text
    assert calls == []  # the daemon is never asked on behalf of a locked caller

    r = client.get(path, headers={"Cookie": f"hub_term_session={_terminal_token()}"})
    assert r.status_code == 200, r.text
    assert calls == ["/" + path.rsplit("/", 1)[1]]


def test_terminal_session_rejects_an_action_purpose_proof():
    enrol()
    ch = action_challenge(WRITE_A)
    assert client.post("/api/terminal/session", json={"devicekey_assertion": dk_assertion(ch)}).status_code == 403


# --- the other two gated write paths accept the same proof ------------------
TOPICS = {"chat_id": "1001234567890", "topics": {"work": 12}, "routes": {"healthcheck": "work"}}


def test_topics_apply_accepts_a_devicekey_proof_and_rejects_a_tampered_one():
    enrol()
    r = client.post("/api/config/topics/challenge", json={"config": TOPICS})
    assert r.status_code == 200, r.text
    ch = r.json()["challenge"]
    tampered = {**TOPICS, "topics": {"work": 13}}
    assert client.post(
        "/api/config/topics", json={"config": tampered, "devicekey_assertion": dk_assertion(ch)}
    ).status_code == 403
    r = client.post("/api/config/topics/challenge", json={"config": TOPICS})
    ch = r.json()["challenge"]
    ok = client.post("/api/config/topics", json={"config": TOPICS, "devicekey_assertion": dk_assertion(ch)})
    assert ok.status_code == 200, ok.text
    assert json.loads((TMP / "telegram-topics.json").read_text())["pending_sync"] is True


def test_briefing_rules_round_trip_add_list_remove():
    """Ruling 146: 'teach the brief' — the user's own standing rules. Add/list/
    remove all go through the SAME device-key gate topics/decisions use."""
    assert client.get("/api/briefing/rules.json").json() == {"rules": []}
    enrol()

    r = client.post("/api/briefing/rules.json/challenge", json={"text": "my manager owns OKRs, never me"})
    assert r.status_code == 200, r.text
    ch = r.json()["challenge"]
    add = client.post(
        "/api/briefing/rules.json",
        json={"text": "my manager owns OKRs, never me", "devicekey_assertion": dk_assertion(ch)},
    )
    assert add.status_code == 200, add.text
    rules = add.json()["rules"]
    assert len(rules) == 1 and rules[0]["text"] == "my manager owns OKRs, never me"
    rule_id = rules[0]["id"]
    assert client.get("/api/briefing/rules.json").json()["rules"] == rules

    r = client.post("/api/briefing/rules.json/challenge", json={"remove": rule_id})
    ch = r.json()["challenge"]
    rm = client.post(
        "/api/briefing/rules.json", json={"remove": rule_id, "devicekey_assertion": dk_assertion(ch)}
    )
    assert rm.status_code == 200, rm.text
    assert rm.json()["rules"] == []
    assert client.get("/api/briefing/rules.json").json() == {"rules": []}


def test_briefing_rules_apply_is_never_ungated():
    r = client.post("/api/briefing/rules.json", json={"text": "no proof attached at all"})
    assert r.status_code == 422
    assert client.get("/api/briefing/rules.json").json() == {"rules": []}


def test_briefing_rules_challenge_rejects_an_over_long_rule():
    r = client.post("/api/briefing/rules.json/challenge", json={"text": "a" * 301})
    assert r.status_code == 400
    # the apply endpoint re-derives the same 400, so a signed-but-tampered
    # over-long rule cannot slip through either.
    enrol()
    ch = client.post("/api/briefing/rules.json/challenge", json={"text": "a short one"}).json()["challenge"]
    r = client.post(
        "/api/briefing/rules.json", json={"text": "a" * 301, "devicekey_assertion": dk_assertion(ch)}
    )
    assert r.status_code == 400


def test_decision_answer_accepts_a_devicekey_proof():
    enrol()
    (TMP / "decisions").mkdir(parents=True, exist_ok=True)
    (TMP / "decisions" / "d1.json").write_text(
        json.dumps({"id": "d1", "title": "t", "status": "open", "options": [{"key": "yes", "label": "Yes"}]})
    )
    r = client.post("/api/decisions/d1/challenge", json={"option_key": "yes"})
    assert r.status_code == 200, r.text
    ch = r.json()["challenge"]
    ok = client.post("/api/decisions/d1/answer", json={"option_key": "yes", "devicekey_assertion": dk_assertion(ch)})
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "answered"


# --- validation errors never echo input, and never 500 ---------------------
SURROGATE = "\ud800"
MARKER = "MARKER_DO_NOT_ECHO"


def _raw_post(path: str, body: dict[str, Any]):
    """json.dumps(ensure_ascii=True) escapes the lone surrogate to ASCII so httpx can send
    it; the server reconstitutes the real surrogate when it decodes the body."""
    return client.post(path, content=json.dumps(body).encode(), headers={"content-type": "application/json"})


def _assert_clean_422(r, where: str) -> None:
    assert r.status_code == 422, (where, r.status_code, r.text[:300])
    assert MARKER not in r.text, f"{where}: the submitted value was echoed back"
    body = r.json()
    assert isinstance(body["detail"], list) and body["detail"], where
    for item in body["detail"]:
        assert set(item) == {"loc", "msg", "type"}, where   # no `input`, no `ctx`
    r.text.encode("utf-8")  # the response really is encodable


@pytest.mark.parametrize(
    "where,path,body",
    [
        # the two triggers this change introduced
        ("extra field, surrogate in the NAME", "/api/action/challenge",
         {"request": {"action": "config.set", SURROGATE: MARKER}}),
        ("extra field, surrogate in the VALUE", "/api/action/challenge",
         {"request": {"action": "config.set", "bogus": MARKER + SURROGATE}}),
        ("devicekey.revoke xor validator", "/api/action/challenge",
         {"request": {"action": "devicekey.revoke", "key": MARKER + SURROGATE}}),
        # the pre-existing half: wrong type / Literal mismatch on every gated endpoint
        ("wrong type, /api/action/challenge", "/api/action/challenge",
         {"request": {"action": "config.set", "key": [MARKER + SURROGATE]}}),
        ("Literal mismatch, /api/action/challenge", "/api/action/challenge",
         {"request": {"action": MARKER + SURROGATE}}),
        ("wrong type, /api/action/apply", "/api/action/apply",
         {"request": {"action": "config.set"},
          "devicekey_assertion": {"key_id": [MARKER + SURROGATE], "challenge_b64": "a", "signature_b64": "b"}}),
        ("wrong type, /api/devicekey/register", "/api/devicekey/register",
         {"code": [MARKER + SURROGATE], "spki_der_b64": "x"}),
        ("wrong type, /api/terminal/session", "/api/terminal/session",
         {"assertion": {"id": [MARKER + SURROGATE], "raw_id": "a", "client_data_json": "b",
                        "authenticator_data": "c", "signature": "d"}}),
        ("no proof at all, /api/terminal/session", "/api/terminal/session", {}),
        ("unparseable nesting", "/api/action/challenge",
         {"request": {"action": "config.set", "key": {"a": {"b": [MARKER + SURROGATE]}}}}),
    ],
)
def test_validation_errors_are_clean_422s(where, path, body):
    """A validation error must never be an unauthenticated 500, and must never echo the
    submitted value — the models validate BEFORE any gate, so these are reachable without
    a passkey or a device key."""
    _assert_clean_422(_raw_post(path, body), where)


def test_the_validation_handler_cannot_raise():
    """The handler claims it cannot raise; prove it for the two ways the body construction
    itself could — errors() blowing up, and a loc that is not iterable."""
    class ErrorsRaises:
        def errors(self):
            raise RuntimeError("boom")

    class NonIterableLoc:
        def errors(self):
            return [{"loc": 5, "msg": "x", "type": "y"}]

    for hostile in (ErrorsRaises(), NonIterableLoc()):
        response = asyncio.run(mod.validation_error_handler(None, hostile))
        assert response.status_code == 422
        assert json.loads(response.body) == {
            "detail": [{"loc": ["body"], "msg": "request validation failed", "type": "invalid"}]
        }


def test_the_validation_handler_reports_where_and_what_kind():
    r = _raw_post("/api/action/challenge", {"request": {"action": "config.set", "bogus": 1}})
    assert r.status_code == 422
    item = r.json()["detail"][0]
    assert item["loc"] == ["body", "request", "bogus"] and item["type"] == "extra_forbidden"


# --- the WebAuthn path is unchanged ----------------------------------------
def test_webauthn_apply_still_works():
    ch = action_challenge(WRITE_A)
    r = client.post("/api/action/apply", json={"request": WRITE_A, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "applied"


def test_webauthn_apply_still_rejects_a_tampered_context():
    ch = action_challenge(WRITE_A)
    r = client.post("/api/action/apply", json={"request": WRITE_B, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 403


def test_webauthn_apply_still_rejects_an_unknown_credential():
    ch = action_challenge(WRITE_A)
    bogus = webauthn_assertion(ch, priv=OTHER_KEY, cred_id=b"\x09" * 32)
    assert client.post("/api/action/apply", json={"request": WRITE_A, "assertion": bogus}).status_code == 403


def test_webauthn_terminal_session_still_works():
    ch = terminal_challenge()
    r = client.post("/api/terminal/session", json={"assertion": webauthn_assertion(ch)})
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_challenge_endpoints_are_byte_identical_in_shape():
    """/api/action/challenge still returns the WebAuthn assertion options unchanged."""
    body = action_challenge(WRITE_A)
    assert isinstance(body, str)
    r = client.post("/api/action/challenge", json={"request": WRITE_A}).json()
    assert set(r) == {"challenge", "rp_id", "user_verification", "allowed_credentials", "timeout_ms"}
    assert r["user_verification"] == "required"
    assert r["allowed_credentials"] == [{"id": b64u(CRED_ID), "type": "public-key"}]


def test_unconfigured_origin_refuses_webauthn_with_an_actionable_message(monkeypatch):
    """An unconfigured host must name the variable to set, not fail in the browser."""
    monkeypatch.setattr(wa, "ORIGIN", None)
    monkeypatch.setattr(wa, "RP_ID", None)
    with pytest.raises(wa.ConfigError) as exc:
        wa.registration_options()
    assert "HUB_ORIGIN" in str(exc.value)

    r = client.post("/api/passkey/register/options", json={})
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail["code"] == "webauthn_unconfigured" and "HUB_ORIGIN" in detail["detail"]

    # The status GET must stay a 200 that reports the state, never a 500.
    status = client.get("/api/passkey/status").json()
    assert status["configured"] is False and status["rp_id"] is None


def test_rp_id_defaults_to_the_origin_hostname(monkeypatch):
    monkeypatch.setattr(wa, "ORIGIN", "https://hub.example.com")
    monkeypatch.setattr(wa, "RP_ID", "hub.example.com")  # what the module derives from ORIGIN
    assert wa.registration_options()["rp"]["id"] == "hub.example.com"

    # A hand-set RP_ID that no browser could complete a ceremony for is refused too.
    monkeypatch.setattr(wa, "RP_ID", "other.test")
    with pytest.raises(wa.ConfigError):
        wa.registration_options()


# --- re-enrolment is gated (adversarial review 2026-10-03) --------------------
# /api/passkey/register/{options,verify} used to be reachable with no proof even
# when a passkey already existed, so any peer that could reach the origin could
# append its own credential and then pass every gated surface. Enrolment stays
# open only while nothing at all is enrolled (bootstrap); once a passkey OR a
# paired device key exists, every enrolment needs a fresh proof.


def test_reenrol_refuses_a_proofless_body_and_accepts_a_device_key_proof():
    assert wa.has_passkey()
    r = client.post("/api/passkey/register/options", json={})
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "register_proof_required"

    enrol()  # a paired device key is a legitimate re-enrol proof holder
    ch = client.post("/api/passkey/register/challenge")
    assert ch.status_code == 200
    proof = dk_assertion(ch.json()["challenge"])
    r = client.post("/api/passkey/register/options", json={"devicekey_assertion": proof})
    assert r.status_code == 200, r.text

    # the challenge is single-use: replaying the same proof is a 403, not a second options
    r = client.post("/api/passkey/register/options", json={"devicekey_assertion": proof})
    assert r.status_code == 403, r.text


def test_reenrol_accepts_a_webauthn_proof_and_rejects_a_foreign_purpose():
    action = action_challenge(WRITE_A)
    # an "action" proof must not satisfy re-enrolment (purpose binding)
    r = client.post("/api/passkey/register/options", json={"assertion": webauthn_assertion(action)})
    assert r.status_code == 403, r.text

    reauth = client.post("/api/passkey/register/challenge").json()["challenge"]
    r = client.post("/api/passkey/register/options", json={"assertion": webauthn_assertion(reauth)})
    assert r.status_code == 200, r.text


def test_first_enrolment_still_needs_no_proof():
    (TMP / "passkeys.json").write_text("[]")
    r = client.post("/api/passkey/register/options", json={})
    assert r.status_code == 200, r.text
    assert r.json()["rp"]["id"] == RP_ID


def test_a_device_key_only_install_does_not_leave_passkey_enrolment_open():
    """A native-app install pairs a device key and never holds a passkey. Enrolment used
    to ask only whether a PASSKEY existed, so on such an install it stayed open for good:
    anyone who could reach the origin could enrol a passkey and pass every gate."""
    (TMP / "passkeys.json").write_text("[]")
    enrol()
    assert not wa.has_passkey() and dk.has_devicekey()
    r = client.post("/api/passkey/register/options", json={})
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "register_proof_required"

    # The paired phone can still add one: the challenge route now issues a challenge
    # the device key can sign, where it used to answer 412 for having no passkey.
    ch = client.post("/api/passkey/register/challenge")
    assert ch.status_code == 200, ch.text
    r = client.post(
        "/api/passkey/register/options", json={"devicekey_assertion": dk_assertion(ch.json()["challenge"])}
    )
    assert r.status_code == 200, r.text
    assert r.json()["rp"]["id"] == RP_ID

    # A proof minted for another purpose is still refused.
    r = client.post("/api/passkey/register/options", json={"devicekey_assertion": dk_assertion(terminal_challenge())})
    assert r.status_code == 403, r.text


def test_every_gated_write_the_app_makes_works_on_a_device_key_only_install(monkeypatch, tmp_path):
    """The app pairs a device key and never holds a passkey. These challenge routes once
    minted only for passkeys and answered 412, so push, brief rules and routing failed."""
    monkeypatch.setattr(mod, "PUSH_TOKENS_FILE", tmp_path / "push_tokens.json")
    (TMP / "passkeys.json").write_text("[]")
    enrol()
    cases = [
        ("/api/push/challenge", "/api/push/register",
         {"token": "ExponentPushToken[abcdefghij123456]", "label": "iPhone"}),
        ("/api/briefing/rules.json/challenge", "/api/briefing/rules.json", {"text": "Skip weather on Sundays"}),
        ("/api/config/topics/challenge", "/api/config/topics", {"config": TOPICS}),
    ]
    for challenge_path, apply_path, body in cases:
        ch = client.post(challenge_path, json=body)
        assert ch.status_code == 200, (challenge_path, ch.text)
        r = client.post(apply_path, json={**body, "devicekey_assertion": dk_assertion(ch.json()["challenge"])})
        assert r.status_code == 200, (apply_path, r.text)


def test_a_connector_login_needs_a_proof_and_its_code_needs_the_poll_token(monkeypatch):
    """Whoever approves the device code decides whose account the agent logs into, so
    starting a login takes a proof and reading its code takes the token /connect returned."""
    monkeypatch.setattr(mod, "_bridge_oauth_start", lambda provider, timeout=None: {"stage": "pending"})
    monkeypatch.setattr(
        mod, "_bridge_oauth_status",
        lambda provider, timeout=None: {"stage": "pending", "url": "https://p.example/device", "code": "ABCD-1234"},
    )
    mod._connect_poll_tokens.clear()
    enrol()
    assert client.post("/api/connectors/openrouter/challenge").status_code == 400
    assert client.post("/api/connectors/nous/connect", json={}).status_code == 422
    r = client.post("/api/connectors/nous/connect", json={"devicekey_assertion": dk_assertion(terminal_challenge())})
    assert r.status_code == 403, r.text
    other = client.post("/api/connectors/openai-codex/challenge").json()["challenge"]
    assert client.post("/api/connectors/nous/connect", json={"devicekey_assertion": dk_assertion(other)}).status_code == 403
    assert client.post("/api/connectors/nous/oauth-status", json={"poll_token": "guess"}).status_code == 403

    ch = client.post("/api/connectors/nous/challenge").json()["challenge"]
    r = client.post("/api/connectors/nous/connect", json={"devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 200, r.text
    token = r.json()["poll_token"]
    assert client.post("/api/connectors/nous/oauth-status", json={"poll_token": "guess"}).status_code == 403
    assert client.post("/api/connectors/openai-codex/oauth-status", json={"poll_token": token}).status_code == 403
    r = client.post("/api/connectors/nous/oauth-status", json={"poll_token": token})
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "ABCD-1234"

    mod._connect_poll_tokens["nous"] = (token, time.monotonic() - 1)
    assert client.post("/api/connectors/nous/oauth-status", json={"poll_token": token}).status_code == 403


def test_register_challenge_is_412_only_when_nothing_is_enrolled():
    (TMP / "passkeys.json").write_text("[]")
    r = client.post("/api/passkey/register/challenge")
    assert r.status_code == 412, r.text
    assert r.json()["detail"]["code"] == "no_passkey"
