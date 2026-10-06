"""Brief push-device registration.

Env is set at module scope BEFORE app is imported (the test_brief_api.py
pattern). The WebAuthn/device-key crypto itself is test_devicekeys.py's job —
these tests monkeypatch the proof check and cover what is ours: the token
validation, the store, what the listing is allowed to reveal, and the POST
allowlist that silently 405s any endpoint nobody remembered to register.
"""

import json
import os
import pathlib
import sys
import tempfile

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
DATA = TMP / "hub" / "data"
DATA.mkdir(parents=True)
TOKENS = DATA / "push_tokens.json"

os.environ["HUB_PUSH_TOKENS"] = str(TOKENS)

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402
import app as mod  # noqa: E402

client = TestClient(mod.app)

TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"
TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]"
PROOF = {"devicekey_assertion": {"key_id": "a" * 64, "challenge_b64": "x", "signature_b64": "y"}}


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    mod.PUSH_TOKENS_FILE = TOKENS
    if TOKENS.exists():
        TOKENS.unlink()
    monkeypatch.setattr(mod, "_require_enrolled", lambda _a: None)
    monkeypatch.setattr(mod, "_verify_proof", lambda req, purpose, ctx: "test")
    yield


def register(token=TOKEN_A, label=None):
    body = {"token": token, **({"label": label} if label else {}), **PROOF}
    return client.post("/api/push/register", json=body)


def test_a_registered_device_is_what_the_pipeline_will_read():
    assert register(label="iPhone").json() == {"status": "registered", "label": "iPhone",
                                               "devices": 1}
    stored = json.loads(TOKENS.read_text())["tokens"]
    assert [t["token"] for t in stored] == [TOKEN_A]
    assert stored[0]["registered_at"].endswith("Z")


def test_registering_the_same_device_again_refreshes_it_rather_than_duplicating():
    """The app registers on every launch; that must not grow the list."""
    register()
    register()
    assert register().json()["devices"] == 1
    assert len(json.loads(TOKENS.read_text())["tokens"]) == 1


def test_a_second_device_is_added_not_replaced():
    register(TOKEN_A)
    assert register(TOKEN_B).json()["devices"] == 2


def test_the_listing_never_hands_back_a_token():
    """An Expo push token is a capability — anyone holding it can push to his
    phone — so the listing shows only what identifies a device."""
    register(label="iPhone")
    body = client.get("/api/push/devices").json()
    assert body["devices"] == [{"label": "iPhone", "registered_at": body["devices"][0]["registered_at"]}]
    assert TOKEN_A not in json.dumps(body)


@pytest.mark.parametrize("bad", [
    "https://evil.example/webhook",
    "ExponentPushToken[]",
    "ExpoPushToken[aaaa]",
    "",
    "ExponentPushToken[" + "a" * 100 + "]",
])
def test_anything_that_is_not_an_expo_token_is_refused(bad):
    assert register(bad).status_code == 400
    assert not TOKENS.exists()


def test_a_label_is_clipped_not_stored_unbounded():
    register(label="x" * 200)
    assert len(json.loads(TOKENS.read_text())["tokens"][0]["label"]) == 40


def test_the_challenge_binds_to_the_exact_token_being_registered():
    """Otherwise a proof captured for one device registers another."""
    assert mod._push_hash(TOKEN_A, "iPhone") != mod._push_hash(TOKEN_B, "iPhone")
    assert mod._push_hash(TOKEN_A, "iPhone") != mod._push_hash(TOKEN_A, "iPad")
    assert mod._push_hash(TOKEN_A, "iPhone") == mod._push_hash(TOKEN_A, "iPhone")


def test_register_without_a_proof_is_rejected_by_the_gate_model():
    """GatedRequest requires exactly one proof; neither is a 422."""
    assert client.post("/api/push/register", json={"token": TOKEN_A}).status_code == 422


def test_both_proofs_at_once_is_also_rejected():
    body = {"token": TOKEN_A, "assertion": {"id": "x", "raw_id": "x", "client_data_json": "x",
                                            "authenticator_data": "x", "signature": "x"}, **PROOF}
    assert client.post("/api/push/register", json=body).status_code == 422


def test_the_post_allowlist_admits_the_push_endpoints():
    """The middleware 405s any POST path nobody added to POST_ALLOWLIST_PREFIXES,
    which is a silent way for a new endpoint to never work."""
    assert any("/api/push/".startswith(p) or p == "/api/push/"
               for p in mod.POST_ALLOWLIST_PREFIXES)
    assert register().status_code == 200
    assert client.post("/api/push/challenge", json={"token": TOKEN_A}).status_code != 405


def test_an_unreadable_store_reads_as_no_devices_not_a_crash():
    TOKENS.write_text("{not json")
    assert client.get("/api/push/devices").json() == {"devices": []}
