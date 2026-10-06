"""Local (non-web) enrolment-code minting — the AF_UNIX pair socket + its CLI.

Offline: the FastAPI app runs in-process (TestClient), the passkey/device-key
stores point at a tmpdir, and the pair server binds a tmpdir socket. No live
hub-api, no network.

What these assert:
  * the local socket mints a code the real /api/devicekey/register accepts
  * the code is single-use and expires, exactly like the WebAuthn-minted one
  * the listener is an AF_UNIX socket (a filesystem path, not a TCP port), so it
    is not reachable over the network, and no HTTP route was added to mint
  * writes are still refused with no enrolled key
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import socket
import stat
import sys
import tempfile
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_PASSKEYS"] = str(TMP / "passkeys.json")
os.environ["HUB_DEVICEKEYS"] = str(TMP / "devicekeys.json")
os.environ["HUB_RP_ID"] = "hub.test"
os.environ["HUB_ORIGIN"] = "https://hub.test"
os.environ["HUB_BRIDGE_URL"] = ""

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

import app as mod  # noqa: E402
import devicekeys as dk  # noqa: E402
import pair_cli  # noqa: E402
import pair_local  # noqa: E402

client = TestClient(mod.app)

PAIR_SOCK = TMP / "hub" / "pair.sock"
APP_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


def spki_der(priv: ec.EllipticCurvePrivateKey) -> bytes:
    return priv.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def key_id_of(priv: ec.EllipticCurvePrivateKey) -> str:
    return hashlib.sha256(spki_der(priv)).hexdigest()


def mint_over_socket(path: str | os.PathLike = PAIR_SOCK) -> dict:
    """Connect to the local pair socket and mint, exactly as the CLI does."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5.0)
        s.connect(str(path))
        s.sendall(json.dumps({"cmd": "pair"}).encode() + b"\n")
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
    return json.loads(buf.decode())


# One listener for the whole module (the app binds one at startup).
LISTENER = pair_local.start_local_pair_server(str(PAIR_SOCK))


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.setattr(dk, "DEVICEKEYS_JSON", TMP / "devicekeys.json")
    (TMP / "devicekeys.json").unlink(missing_ok=True)
    dk._enroll_codes.clear()
    dk._attempt_times.clear()
    dk._global_attempts.clear()
    yield
    (TMP / "devicekeys.json").unlink(missing_ok=True)


# --- minting ---------------------------------------------------------------
def test_pair_server_bound():
    assert LISTENER is not None, "local pair server failed to bind"


def test_local_socket_mints_a_usable_code():
    minted = mint_over_socket()
    assert minted["ok"] is True
    code = minted["code"]
    # Same alphabet/length/TTL the app's PairSheet expects.
    assert len(code) == dk._CODE_LEN == 6
    assert set(code) <= set(dk._CODE_ALPHABET)
    assert minted["ttl_s"] == int(dk.ENROLL_CODE_TTL_S)

    # The real registration endpoint accepts it — proving a usable code.
    r = client.post(
        "/api/devicekey/register",
        json={"code": code, "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    )
    assert r.status_code == 200, r.text
    assert dk.has_devicekey()


def test_local_code_is_single_use():
    code = mint_over_socket()["code"]
    assert client.post(
        "/api/devicekey/register",
        json={"code": code, "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    ).status_code == 200
    replay = client.post(
        "/api/devicekey/register",
        json={"code": code, "spki_der_b64": base64.b64encode(spki_der(OTHER_KEY)).decode()},
    )
    assert replay.status_code == 403
    assert client.get("/api/devicekey/status").json()["count"] == 1


def test_local_code_expires(monkeypatch):
    minted = mint_over_socket()
    real_monotonic = time.monotonic
    monkeypatch.setattr(dk.time, "monotonic", lambda: real_monotonic() + dk.ENROLL_CODE_TTL_S + 1)
    r = client.post(
        "/api/devicekey/register",
        json={"code": minted["code"], "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    )
    assert r.status_code == 403
    assert not dk.has_devicekey()


def test_minting_locally_replaces_the_previous_code():
    first = mint_over_socket()["code"]
    second = mint_over_socket()["code"]
    r = client.post(
        "/api/devicekey/register",
        json={"code": first, "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    )
    assert r.status_code == 403, "the superseded code must not register"
    assert client.post(
        "/api/devicekey/register",
        json={"code": second, "spki_der_b64": base64.b64encode(spki_der(APP_KEY)).decode()},
    ).status_code == 200


# --- not reachable over the network ---------------------------------------
def test_pair_listener_is_a_unix_socket_not_a_port():
    assert pair_local.SOCKET_FAMILY == socket.AF_UNIX
    assert LISTENER.family == socket.AF_UNIX
    # an AF_UNIX listener's address is a filesystem path, never a (host, port)
    assert isinstance(LISTENER.getsockname(), str)
    assert os.path.lexists(str(PAIR_SOCK))
    assert stat.S_ISSOCK(os.stat(str(PAIR_SOCK)).st_mode)
    # mode 0600: only the hub's own uid can open it
    assert os.stat(str(PAIR_SOCK)).st_mode & 0o777 == 0o600


def test_no_http_route_mints_an_enrol_code():
    # No HTTP route enrols a device code (the unrelated GET /api/pairing is the
    # assistant's DM-pairing read, not device enrolment). The only HTTP path that
    # mints is the WebAuthn-gated devicekey.enroll_code action — and it still
    # demands a passkey proof, with no device-key substitute.
    paths = [getattr(r, "path", "") for r in mod.app.routes]
    assert not any("enroll" in p.lower() or "enrol" in p.lower() for p in paths)
    req = {"request": {"action": "devicekey.enroll_code"}}
    assert client.post("/api/action/apply", json=req).status_code == 422
    forged = {
        **req,
        "devicekey_assertion": {
            "key_id": "0" * 64,
            "challenge_b64": "AAAA",
            "signature_b64": base64.b64encode(b"x").decode(),
        },
    }
    # no device key enrolled → refused with the no-devicekey precondition
    assert client.post("/api/action/apply", json=forged).status_code == 412


# --- the write gate is unchanged ------------------------------------------
def test_writes_are_refused_with_no_enrolled_key():
    body = {"request": {"action": "config.set", "key": "model.default", "value": "x"}}
    # No proof at all → rejected at the model boundary.
    assert client.post("/api/action/apply", json=body).status_code == 422
    # A well-formed device-key proof for a key that was never enrolled → refused.
    forged = {
        **body,
        "devicekey_assertion": {
            "key_id": key_id_of(APP_KEY),
            "challenge_b64": "AAAA",
            "signature_b64": base64.b64encode(b"x").decode(),
        },
    }
    r = client.post("/api/action/apply", json=forged)
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_devicekey"


# --- the CLI --------------------------------------------------------------
def test_cli_prints_the_code(capsys):
    rc = pair_cli.main(["--socket", str(PAIR_SOCK)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Enrolment code" in out
    line = next(ln for ln in out.splitlines() if "Enrolment code" in ln)
    code = line.split(":", 1)[1].strip()
    assert len(code) == 6 and set(code) <= set(dk._CODE_ALPHABET)


def test_cli_json_mode(capsys):
    rc = pair_cli.main(["--socket", str(PAIR_SOCK), "--json"])
    payload = json.loads(capsys.readouterr().out.strip())
    assert rc == 0 and payload["ok"] is True


def test_cli_missing_socket_is_an_honest_error(capsys):
    rc = pair_cli.main(["--socket", str(TMP / "nope.sock")])
    err = capsys.readouterr().err
    assert rc == 2
    assert "install.sh --pair" in err
