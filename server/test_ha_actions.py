"""HA action endpoints (/api/ha/challenge, /api/ha/apply) — these now route their
cryptographic verification through the primary webauthn_gate instead of carrying a
second, weaker implementation (see server/ha_actions.py, server/webauthn_gate.py).

Offline: everything runs against the FastAPI app in-process (TestClient), with the
passkey store pointed at a tmpdir. No live hub-api, no HA, no network.

The threat model this asserts, in order:
  * /api/ha/challenge 412s with no passkey enrolled, same as every other gate
  * a valid assertion for the exact proposal it was challenged for is accepted
  * a stale/unknown challenge, and an assertion for a DIFFERENT proposal than the one
    challenged, are both rejected (the proposal-hash binding still works)
  * a challenge minted under another purpose ("action", "terminal", "chat") cannot
    unlock an HA apply, and an HA-purpose challenge cannot unlock those paths either —
    purposes don't cross now that everything shares one cache
  * a successful apply advances the authoritative passkey's sign_count — the specific
    regression this consolidation closes, since the old ha_actions._verify_assertion
    never wrote the sign_count back, silently disabling clone-authenticator detection
    on this one path
  * a replayed assertion (same signed challenge used twice) is rejected — the
    challenge is single-use via the shared cache's take()
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
os.environ["HUB_BRIEFING_RULES"] = str(TMP / "briefing_rules.json")
os.environ["HUB_BRIDGE_URL"] = ""
os.environ["HUB_LOG_DIR"] = str(TMP / "logs")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

import ha_actions as ha  # noqa: E402
import webauthn_gate as wa  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)

RP_ID = "hub.test"
ORIGIN = "https://hub.test"

PASSKEY = ec.generate_private_key(ec.SECP256R1())
CRED_ID = bytes(range(32))


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def cose_p256(pub: ec.EllipticCurvePublicKey) -> bytes:
    import cbor2

    n = pub.public_numbers()
    return cbor2.dumps({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")})


def seed_passkey(sign_count: int = 0) -> None:
    (TMP / "passkeys.json").write_text(
        json.dumps(
            [
                {
                    "credential_id": b64u(CRED_ID),
                    "public_key": b64u(cose_p256(PASSKEY.public_key())),
                    "sign_count": sign_count,
                    "transports": [],
                    "label": "Face ID",
                    "created_at": "2026-09-09T00:00:00Z",
                }
            ]
        )
    )


def webauthn_assertion(challenge_b64u: str, priv=PASSKEY, cred_id: bytes = CRED_ID, counter: int = 0) -> dict:
    auth_data = hashlib.sha256(RP_ID.encode()).digest() + bytes([0x05]) + counter.to_bytes(4, "big")
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


def make_proposal(id_: str = "p1", **overrides) -> dict:
    body = {
        "id": id_,
        "source": "pill",
        "request_text": "turn on the lamp",
        "agent": "concierge",
        "model": "test-model",
        "changes": [
            {
                "entity_id": "light.lamp",
                "entity_label": "Lamp",
                "entity_icon": "lightbulb",
                "kind": "on_off",
                "on_off": {"state": "on"},
            }
        ],
        "created_at": "2026-10-02T00:00:00Z",
        "service_call_count": 1,
    }
    body.update(overrides)
    return body


def ha_challenge(proposal: dict) -> str:
    r = client.post("/api/ha/challenge", json={"proposal": proposal})
    assert r.status_code == 200, r.text
    return r.json()["challenge"]


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.setattr(wa, "PASSKEYS_JSON", TMP / "passkeys.json")
    monkeypatch.setattr(wa, "RP_ID", RP_ID)
    monkeypatch.setattr(wa, "ORIGIN", ORIGIN)
    seed_passkey()
    wa._cache._store.clear()
    yield


# --- challenge -----------------------------------------------------------------
def test_challenge_412_with_no_passkey(monkeypatch):
    monkeypatch.setattr(wa, "PASSKEYS_JSON", TMP / "no-such-file.json")
    r = client.post("/api/ha/challenge", json={"proposal": make_proposal()})
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_passkey"


def test_challenge_returns_assertion_options_for_the_shared_gate():
    r = client.post("/api/ha/challenge", json={"proposal": make_proposal()})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rp_id"] == RP_ID
    assert body["allowed_credentials"][0]["id"] == b64u(CRED_ID)
    # The challenge actually landed in the ONE shared cache, under the HA purpose.
    entry = wa._cache._store.get(body["challenge"])
    assert entry is not None
    purpose, ctx, _exp = entry
    assert purpose == ha.HA_APPLY_PURPOSE
    assert ctx == ha._proposal_hash(ha.Proposal(**make_proposal()))


# --- apply: happy path -----------------------------------------------------------
def test_apply_succeeds_for_the_exact_proposal_it_was_challenged_for():
    proposal = make_proposal()
    ch = ha_challenge(proposal)
    r = client.post("/api/ha/apply", json={"proposal": proposal, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "dry_run_ok"


def test_apply_412_with_no_passkey(monkeypatch):
    proposal = make_proposal()
    ch = ha_challenge(proposal)
    monkeypatch.setattr(wa, "PASSKEYS_JSON", TMP / "no-such-file.json")
    r = client.post("/api/ha/apply", json={"proposal": proposal, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_passkey"


# --- apply: binding ---------------------------------------------------------------
def test_apply_rejects_an_assertion_for_a_different_proposal():
    """The challenge is bound to proposal p1's hash; signing it and then submitting a
    changed proposal (different hash) must fail — this is the proposal/payload binding
    the HA path specifically needs, preserved through the shared gate's context_hash."""
    proposal = make_proposal()
    ch = ha_challenge(proposal)
    tampered = make_proposal(request_text="turn OFF the lamp instead")
    r = client.post("/api/ha/apply", json={"proposal": tampered, "assertion": webauthn_assertion(ch)})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "assertion_invalid"


def test_apply_rejects_an_unknown_challenge():
    proposal = make_proposal()
    r = client.post(
        "/api/ha/apply",
        json={"proposal": proposal, "assertion": webauthn_assertion("not-a-real-challenge")},
    )
    assert r.status_code == 403


def test_apply_rejects_a_replayed_assertion():
    """Single-use challenge: the same signed assertion can't apply twice."""
    proposal = make_proposal()
    ch = ha_challenge(proposal)
    assertion = webauthn_assertion(ch)
    r1 = client.post("/api/ha/apply", json={"proposal": proposal, "assertion": assertion})
    assert r1.status_code == 200, r1.text
    r2 = client.post("/api/ha/apply", json={"proposal": proposal, "assertion": assertion})
    assert r2.status_code == 403


# --- apply: purposes don't cross ---------------------------------------------------
def test_other_purpose_challenge_cannot_unlock_ha_apply():
    """A challenge minted for the write-action gate can't be replayed to approve an
    HA proposal — purposes are checked, not just "some valid challenge exists"."""
    opts = wa.assertion_options("action", None)
    proposal = make_proposal()
    r = client.post("/api/ha/apply", json={"proposal": proposal, "assertion": webauthn_assertion(opts["challenge"])})
    assert r.status_code == 403


def test_ha_challenge_cannot_unlock_the_write_action_gate():
    """And the reverse: an HA-purpose assertion can't verify under the "action"
    purpose via the shared gate directly."""
    proposal = make_proposal()
    ch = ha_challenge(proposal)
    phash = ha._proposal_hash(ha.Proposal(**proposal))
    cred_id = wa.verify_assertion(webauthn_assertion(ch), "action", phash)
    assert cred_id is None


# --- the regression this consolidation closes --------------------------------------
def test_apply_advances_sign_count_on_success():
    """This is the specific bug being fixed: the old ha_actions._verify_assertion
    never wrote verification.new_sign_count back to passkeys.json, so a cloned
    authenticator replaying a captured signature counter would go undetected on the
    HA path even though the primary gate already defends every other surface. Routing
    through webauthn_gate.verify_assertion must advance it here too."""
    assert wa.load_passkeys()[0]["sign_count"] == 0
    proposal = make_proposal()
    ch = ha_challenge(proposal)
    r = client.post(
        "/api/ha/apply",
        json={"proposal": proposal, "assertion": webauthn_assertion(ch, counter=7)},
    )
    assert r.status_code == 200, r.text
    passkeys_after = wa.load_passkeys()
    assert passkeys_after[0]["sign_count"] == 7, (
        "sign_count was not persisted after a successful HA apply — the cloned-"
        "authenticator defense is not wired on this path"
    )


def test_apply_rejects_a_stale_sign_count():
    """A signature whose embedded counter does not exceed the stored sign_count is a
    clone-detection hit and must fail closed — this only works because the HA path's
    verification and sign-count bookkeeping are now the SAME code as every other
    passkey-gated surface."""
    seed_passkey(sign_count=10)
    proposal = make_proposal()
    ch = ha_challenge(proposal)
    r = client.post(
        "/api/ha/apply",
        json={"proposal": proposal, "assertion": webauthn_assertion(ch, counter=3)},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "assertion_invalid"
