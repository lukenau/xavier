"""The Hub chat cookie gate (chat/session.py) + cookie-gated reads (chat/routes.py) +
the chat WebSocket (chat/ws.py) — one file, since the WebSocket's auth-in-handler is
just the session gate applied a second time where `@app.middleware("http")` can't
reach (no middleware ever runs on a WebSocket scope).

Offline: TestClient in-process, passkey/devicekey/chat stores all under a tmpdir, no
live hub-api, no network. Run separately from the other test files (requirements-
dev.txt explains why: several modules set env vars at import time before importing
`app`, and only the first module pytest collects gets to set them).

The threat model this asserts, in order:
  * the chat cookie is minted only after a real WebAuthn or device-key assertion,
    bound to purpose "chat" (a terminal/action/topics/decisions proof can't unlock it)
  * the cookie is scoped Path=/api/chat, HttpOnly, Secure, SameSite=Strict
  * an expired token is refused exactly like an unknown one — `chat_session_valid`
    pops it from `_CHAT_SESSIONS` the moment it notices, so it can never be "half
    valid" on a later request either
  * /api/chat/logout REVOKES server-side — a captured cookie stops working immediately,
    not at the end of its hour (the correction VERDICT-V2 calls out over the terminal's
    own logout)
  * a hub-api restart (simulated: clearing the in-process token dict) invalidates every
    outstanding chat cookie, same as the terminal
  * every read route 401s without a valid cookie, and never lazily creates a thread
  * mark-read only ever advances the cursor, and caps at the thread's own last_seq
  * `/send` 401s without a cookie, 404s for an unknown thread (same never-lazily-
    creates rule as the reads), and is idempotent on a repeated `client_msg_id`
  * `/send` records the human message durably before it ever attempts the gateway
    forward, and a forward that is unreachable, 503s, or times out never loses it —
    the forward outcome (today, always "pending": the hub adapter is Phase 1,
    observer-only) is recorded truthfully, never faked as delivered
  * the WebSocket closes 1008 — the exact code, not just "some disconnect" — with no
    cookie, a garbage cookie, and a cookie revoked mid-connection
  * subscribe{after_seq} replays exactly the events after that cursor, oldest first,
    exactly once, and new events keep streaming without a reconnect
  * a subscribe whose cursor predates the surviving event log gets snapshot_required,
    never a silently-holed replay
  * no error body from any failure path here leaks a secret, a credential, or an
    absolute host path
"""
from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import WebSocketDisconnect

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
# Fast poll/heartbeat so the WS tests don't need real-world sleeps longer than ~0.2s.
os.environ["HUB_CHAT_WS_POLL_INTERVAL_S"] = "0.05"
os.environ["HUB_CHAT_WS_HEARTBEAT_INTERVAL_S"] = "0.15"

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

import chat.platform as chat_platform  # noqa: E402
import chat.routes as chat_routes  # noqa: E402
import chat.session as chat_session  # noqa: E402
import chat.ws as chat_ws  # noqa: E402
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


# --- webauthn/devicekey fixtures (same idiom as test_devicekeys.py) ------------
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


def chat_challenge() -> str:
    r = client.post("/api/chat/challenge")
    assert r.status_code == 200, r.text
    return r.json()["challenge"]


def terminal_challenge() -> str:
    r = client.post("/api/terminal/challenge")
    assert r.status_code == 200, r.text
    return r.json()["challenge"]


def chat_login_via_passkey() -> str:
    """Full unlock ceremony -> the minted hub_chat_session token (extracted from the
    Set-Cookie header, not relied on via the client's own cookie jar — see module
    docstring on why later tests pass cookies explicitly)."""
    ch = chat_challenge()
    r = client.post("/api/chat/session", json={"assertion": webauthn_assertion(ch)})
    assert r.status_code == 200, r.text
    return r.cookies["hub_chat_session"]


def _cookie_shape(set_cookie: str) -> dict[str, str | bool]:
    parts = [p.strip() for p in set_cookie.split(";")]
    name, _, _value = parts[0].partition("=")
    shape: dict[str, str | bool] = {"name": name}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        shape[k.lower()] = v or True
    return shape


def deliver(thread_id: str, **overrides) -> dict:
    body = {"thread_id": thread_id, "parts": [{"type": "text", "text": "hi"}]}
    body.update(overrides)
    r = client.post("/api/platform/hub/deliver", json=body, headers=PLATFORM_AUTH)
    assert r.status_code == 200, r.text
    return r.json()


# --- send: local fake gateways -----------------------------------------------------
# `/send`'s forward leg talks to `HERMES_API_BASE` over real urllib — these fixtures
# give it something real to talk to (or deliberately not talk to) without a live
# example-gateway, same offline posture as the rest of this file.
FAKE_HERMES_KEY = "fake-hermes-key-should-never-leak"


def _unused_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Respond503Handler(http.server.BaseHTTPRequestHandler):
    """Stands in for the live gateway's generic platform-events callback answering
    `503 platform_http_events_unsupported` — Phase 1's hub adapter implements neither
    `verify_http_event_request` nor `dispatch_http_event` (the hub-platform
    adapter)."""

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler's own naming)
        body = b'{"code":"platform_http_events_unsupported"}'
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass  # keep test output quiet


class _SlowHandler(http.server.BaseHTTPRequestHandler):
    """Accepts the connection but never answers within any sane test timeout —
    simulates a gateway that is up but hung, exercising the read-timeout path
    distinct from both "unreachable" (connection refused) and "503"."""

    def do_POST(self) -> None:  # noqa: N802
        import time

        time.sleep(0.5)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args) -> None:
        pass


def _spawn_http_server(handler_cls) -> http.server.HTTPServer:
    httpd = http.server.HTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return httpd


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
    chat_session._CHAT_SESSIONS.clear()
    yield


def assert_no_secrets_leaked(resp) -> None:
    body = resp.text
    for forbidden in FORBIDDEN_IN_ERRORS:
        assert forbidden not in body, f"{forbidden!r} leaked into error body: {body}"


# --- challenge -------------------------------------------------------------------
def test_challenge_412_with_no_passkey(monkeypatch):
    monkeypatch.setattr(wa, "PASSKEYS_JSON", TMP / "no-such-file.json")
    r = client.post("/api/chat/challenge")
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_passkey"
    assert_no_secrets_leaked(r)


def test_challenge_returns_assertion_options():
    r = client.post("/api/chat/challenge")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rp_id"] == RP_ID
    assert body["allowed_credentials"][0]["id"] == b64u(CRED_ID)


# --- session: cookie minting ------------------------------------------------------
def test_session_mints_a_scoped_cookie():
    ch = chat_challenge()
    r = client.post("/api/chat/session", json={"assertion": webauthn_assertion(ch)})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
    shape = _cookie_shape(r.headers["set-cookie"])
    assert shape["name"] == "hub_chat_session"
    assert shape["httponly"] is True
    assert shape["secure"] is True
    assert shape["samesite"].lower() == "strict"
    assert shape["path"] == "/api/chat"
    assert shape["path"] != "/terminal"


def test_session_via_devicekey_mints_the_same_cookie_shape():
    enrol()
    ch = chat_challenge()
    r = client.post("/api/chat/session", json={"devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 200, r.text
    assert _cookie_shape(r.headers["set-cookie"])["path"] == "/api/chat"


def test_devicekey_only_install_can_unlock_chat_without_a_passkey():
    """A paired iPhone with NO passkey — the native app's normal state — must still get a
    challenge and unlock. Regression: /api/chat/challenge (and the terminal/action routes)
    used to answer 412 no_passkey whenever passkeys.json was empty, so a device-key-only
    install could pair and then never unlock chat or make any gated write. The challenge
    route now falls back to the paired device key."""
    saved_pk = (TMP / "passkeys.json").read_text() if (TMP / "passkeys.json").exists() else None
    saved_dk = (TMP / "devicekeys.json").read_text() if (TMP / "devicekeys.json").exists() else None
    try:
        (TMP / "passkeys.json").unlink(missing_ok=True)
        (TMP / "devicekeys.json").unlink(missing_ok=True)
        enrol()  # pairs a device key; no passkey exists
        ch = chat_challenge()
        r = client.post("/api/chat/session", json={"devicekey_assertion": dk_assertion(ch)})
        assert r.status_code == 200, r.text
        assert _cookie_shape(r.headers["set-cookie"])["name"] == "hub_chat_session"
        # Terminal unlocks the same way for a device-key-only install.
        tch = terminal_challenge()
        assert client.post("/api/terminal/session", json={"devicekey_assertion": dk_assertion(tch)}).status_code == 200
    finally:
        for path, saved in ((TMP / "passkeys.json", saved_pk), (TMP / "devicekeys.json", saved_dk)):
            if saved is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(saved)


def test_session_412_when_devicekey_presented_but_none_enrolled():
    ch = chat_challenge()
    r = client.post("/api/chat/session", json={"devicekey_assertion": dk_assertion(ch)})
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_devicekey"


def test_session_requires_exactly_one_proof():
    ch = chat_challenge()
    assert client.post("/api/chat/session", json={}).status_code == 422
    enrol()
    ch2 = chat_challenge()
    both = {"assertion": webauthn_assertion(ch2), "devicekey_assertion": dk_assertion(ch)}
    assert client.post("/api/chat/session", json=both).status_code == 422


def test_session_rejects_a_different_purpose_proof():
    """A terminal-purpose challenge/assertion can't unlock chat — purposes don't cross."""
    ch = terminal_challenge()
    r = client.post("/api/chat/session", json={"assertion": webauthn_assertion(ch)})
    assert r.status_code == 403


def test_chat_challenge_cannot_unlock_the_terminal():
    ch = chat_challenge()
    r = client.post("/api/terminal/session", json={"assertion": webauthn_assertion(ch)})
    assert r.status_code == 403


# --- session: gating reads ---------------------------------------------------------
def test_bootstrap_401s_without_a_cookie():
    r = client.get("/api/chat/bootstrap")
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"
    assert_no_secrets_leaked(r)


def test_bootstrap_401s_with_an_unknown_cookie():
    r = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": "not-a-real-token"})
    assert r.status_code == 401


def test_bootstrap_200s_with_a_valid_cookie():
    token = chat_login_via_passkey()
    r = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    assert r.json() == {"threads": []}


# --- session: the locked-state message tells the truth about the user's state -------
# On a fresh install there is no passkey to "unlock with", so the gate must ask the
# user to ENROL; only once a credential exists is a locked session a re-auth. These
# pin both states for the chat gate and the terminal gate (task t_602da9c5).
def test_locked_chat_with_no_credentials_asks_to_enrol_not_to_unlock():
    """The autouse fixture seeds a passkey; a fresh install has neither passkey nor
    paired device. The gate must not name a credential that does not exist yet."""
    (TMP / "passkeys.json").unlink(missing_ok=True)
    (TMP / "devicekeys.json").unlink(missing_ok=True)
    r = client.get("/api/chat/bootstrap")
    assert r.status_code == 412
    body = r.json()["detail"]
    assert body["code"] == "no_passkey"
    assert "enrol" in body["detail"].lower()
    assert "Face ID" not in body["detail"]
    assert_no_secrets_leaked(r)


def test_locked_chat_with_a_credential_asks_to_reauthenticate():
    """With a credential on file, a locked session is a re-auth, not an enrolment."""
    r = client.get("/api/chat/bootstrap")
    assert r.status_code == 401
    body = r.json()["detail"]
    assert body["code"] == "chat_locked"
    assert "Face ID" not in body["detail"]
    assert "re-authenticate" in body["detail"]
    assert_no_secrets_leaked(r)


def test_locked_terminal_gate_uses_the_same_two_state_message(monkeypatch):
    """The terminal proxy carried the same "unlock with Face ID" defect. HUB_TTYD_SOCK
    is set so the route reaches the session check rather than the 503 guard."""
    import app as mod
    monkeypatch.setattr(mod, "HUB_TTYD_SOCK", "/tmp/does-not-exist-ttyd.sock")

    r = client.get("/terminal")
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "terminal_locked"
    assert "Face ID" not in r.json()["detail"]["detail"]

    (TMP / "passkeys.json").unlink(missing_ok=True)
    (TMP / "devicekeys.json").unlink(missing_ok=True)
    r = client.get("/terminal")
    assert r.status_code == 412
    assert r.json()["detail"]["code"] == "no_passkey"


# --- session: expiry ---------------------------------------------------------------
def test_expired_token_is_refused_like_an_unknown_one():
    """`chat_session_valid` treats a token past its stored expiry exactly like one that
    was never minted: 401, and popped from `_CHAT_SESSIONS` so it can't come back to
    life on a later request either (mirrors `_term_session_valid`'s own TTL check)."""
    token = chat_login_via_passkey()
    assert client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).status_code == 200
    import time

    with chat_session._CHAT_LOCK:
        chat_session._CHAT_SESSIONS[token] = time.monotonic() - 1
    r = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"
    assert_no_secrets_leaked(r)
    # And it's really gone, not just "expired-but-still-there":
    assert token not in chat_session._CHAT_SESSIONS


# --- logout: server-side revoke ------------------------------------------------------
def test_logout_revokes_the_token_server_side():
    token = chat_login_via_passkey()
    assert client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).status_code == 200
    lo = client.post("/api/chat/logout", cookies={"hub_chat_session": token})
    assert lo.status_code == 200
    # deletes the browser cookie too
    assert 'hub_chat_session=""' in lo.headers["set-cookie"] or "hub_chat_session=;" in lo.headers["set-cookie"]
    # the SAME token, replayed, is now dead — not merely uncookied client-side
    again = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token})
    assert again.status_code == 401


def test_logout_with_no_cookie_is_a_no_op_ok():
    r = client.post("/api/chat/logout")
    assert r.status_code == 200


def test_a_restart_invalidates_every_outstanding_cookie():
    """Simulates a hub-api restart: the in-process dict is gone, so a captured cookie
    from before the restart must fail, same as the terminal's _TERM_SESSIONS."""
    token = chat_login_via_passkey()
    assert client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).status_code == 200
    chat_session._CHAT_SESSIONS.clear()
    assert client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).status_code == 401


# --- reads: bootstrap / threads --------------------------------------------------
def test_bootstrap_and_threads_list_a_delivered_thread():
    deliver("thr_a")
    deliver("thr_a", parts=[{"type": "text", "text": "second"}])
    token = chat_login_via_passkey()
    for path in ("/api/chat/bootstrap", "/api/chat/threads"):
        r = client.get(path, cookies={"hub_chat_session": token})
        assert r.status_code == 200, r.text
        threads = r.json()["threads"]
        assert len(threads) == 1
        t = threads[0]
        assert t["id"] == "thr_a"
        assert t["last_seq"] == 2
        assert t["last_read_seq"] == 0
        assert t["unread"] == 2
        assert t["pinned"] is False and t["archived"] is False


def test_threads_route_401s_without_a_cookie():
    assert client.get("/api/chat/threads").status_code == 401


def test_bootstrap_orders_pinned_threads_first():
    deliver("thr_b1")
    deliver("thr_b2")
    store = chat_platform.get_store()
    store._conn.execute("UPDATE threads SET pinned=1 WHERE id=?", ("thr_b2",))
    store._conn.commit()
    token = chat_login_via_passkey()
    threads = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    ids = [t["id"] for t in threads]
    assert ids.index("thr_b2") < ids.index("thr_b1")


# --- reads: thread detail -----------------------------------------------------------
def test_thread_detail_404_for_an_unknown_thread():
    token = chat_login_via_passkey()
    r = client.get("/api/chat/threads/thr_nope", cookies={"hub_chat_session": token})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"
    assert_no_secrets_leaked(r)


def test_thread_detail_never_lazily_creates_a_thread():
    token = chat_login_via_passkey()
    client.get("/api/chat/threads/thr_ghost", cookies={"hub_chat_session": token})
    assert chat_platform.get_store().get_thread("thr_ghost") is None


def test_thread_detail_returns_messages_in_seq_order():
    deliver("thr_c", parts=[{"type": "text", "text": "one"}])
    deliver("thr_c", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    r = client.get("/api/chat/threads/thr_c", cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["thread"]["id"] == "thr_c"
    assert [m["parts"][0]["text"] for m in body["messages"]] == ["one", "two"]
    assert [m["seq"] for m in body["messages"]] == [1, 2]


def test_thread_detail_after_seq_filters_history():
    deliver("thr_d", parts=[{"type": "text", "text": "one"}])
    deliver("thr_d", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    r = client.get("/api/chat/threads/thr_d?after_seq=1", cookies={"hub_chat_session": token})
    assert [m["parts"][0]["text"] for m in r.json()["messages"]] == ["two"]


def test_thread_detail_401s_without_a_cookie():
    deliver("thr_e")
    assert client.get("/api/chat/threads/thr_e").status_code == 401


# --- mark-read -----------------------------------------------------------------------
def test_mark_read_advances_last_read_seq_and_recomputes_unread():
    deliver("thr_f")
    deliver("thr_f", parts=[{"type": "text", "text": "two"}])
    deliver("thr_f", parts=[{"type": "text", "text": "three"}])
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_f/read", json={"seq": 2}, cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    assert r.json() == {"thread_id": "thr_f", "last_read_seq": 2, "unread": 1}
    threads = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    t = next(t for t in threads if t["id"] == "thr_f")
    assert t["last_read_seq"] == 2 and t["unread"] == 1


def test_mark_read_never_rewinds():
    deliver("thr_g")
    deliver("thr_g", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    client.post("/api/chat/threads/thr_g/read", json={"seq": 2}, cookies={"hub_chat_session": token})
    r = client.post("/api/chat/threads/thr_g/read", json={"seq": 1}, cookies={"hub_chat_session": token})
    assert r.json()["last_read_seq"] == 2  # not rewound to 1


def test_mark_read_caps_at_the_threads_own_last_seq():
    deliver("thr_h")  # last_seq == 1
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_h/read", json={"seq": 999}, cookies={"hub_chat_session": token})
    assert r.json() == {"thread_id": "thr_h", "last_read_seq": 1, "unread": 0}


def test_mark_read_404_for_an_unknown_thread():
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_nope/read", json={"seq": 1}, cookies={"hub_chat_session": token})
    assert r.status_code == 404


def test_mark_read_401s_without_a_cookie():
    deliver("thr_i")
    r = client.post("/api/chat/threads/thr_i/read", json={"seq": 1})
    assert r.status_code == 401


def test_mark_read_rejects_unknown_fields():
    deliver("thr_j")
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_j/read", json={"seq": 1, "hub_user_id": "someone_else"}, cookies={"hub_chat_session": token}
    )
    assert r.status_code == 422


# --- attention: the cross-thread needs-you read (chat/routes.py `GET /attention`) ---
def test_attention_401s_without_a_cookie():
    deliver("thr_att1", attention={"kind": "cron_alert", "summary": "backup failed"})
    r = client.get("/api/chat/attention")
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"
    assert_no_secrets_leaked(r)


def test_attention_lists_open_rows_across_threads_newest_first():
    deliver("thr_att2", kind="ops", title="Ops", attention={"kind": "cron_alert", "summary": "backup failed"})
    deliver(
        "thr_att3",
        attention={"kind": "approval", "request_id": "rq_1", "run_id": "run_1",
                   "summary": "delete the backup?", "expires_at_derived": "2026-09-22T12:00:00Z"},
    )
    token = chat_login_via_passkey()
    r = client.get("/api/chat/attention", cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    rows = r.json()["attention"]
    seen = [row for row in rows if row["thread_id"] in ("thr_att2", "thr_att3")]
    assert [row["thread_id"] for row in seen] == ["thr_att3", "thr_att2"]
    approval, alert = seen
    assert approval["kind"] == "approval"
    assert approval["summary"] == "delete the backup?"
    assert approval["expires_at_derived"] == "2026-09-22T12:00:00Z"
    assert approval["thread_title"] is None and approval["thread_kind"] == "chat"
    assert alert["thread_title"] == "Ops" and alert["thread_kind"] == "ops"
    assert alert["expires_at_derived"] is None


def test_attention_limit_is_clamped_not_trusted():
    deliver("thr_att4", attention={"kind": "mention", "summary": "you were named"})
    token = chat_login_via_passkey()
    for limit, expected in ((0, 1), (-5, 1), (99999, None)):
        r = client.get(f"/api/chat/attention?limit={limit}", cookies={"hub_chat_session": token})
        assert r.status_code == 200, r.text
        rows = r.json()["attention"]
        assert len(rows) >= 1 if expected is None else len(rows) == expected


# --- commands: the `/` picker catalog (chat/routes.py `GET /commands`) -------------
def push_catalog(version: int, commands: list[dict]) -> dict:
    r = client.post(
        "/api/platform/hub/commands", json={"version": version, "commands": commands}, headers=PLATFORM_AUTH
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_commands_401s_without_a_cookie():
    r = client.get("/api/chat/commands")
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"
    assert_no_secrets_leaked(r)


def test_commands_returns_bootstrap_when_nothing_pushed():
    """Fresh env for this test module: HUB_CHAT_COMMAND_CATALOG points at a tmpdir
    path nothing has written to yet, so this exercises the real fall-open path, not a
    mock — see the module-level env setup above."""
    assert not chat_platform.COMMAND_CATALOG_FILE.exists()
    token = chat_login_via_passkey()
    r = client.get("/api/chat/commands", cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "bootstrap"
    on_disk = json.loads(chat_routes.COMMAND_CATALOG_BOOTSTRAP_FILE.read_text())
    assert body["version"] == on_disk["version"]
    assert body["commands"] == on_disk["commands"]
    assert len(body["commands"]) > 0


def test_commands_returns_the_live_catalog_after_a_push_and_never_falls_back_again():
    pushed = [{"name": "/new", "category": "builtin", "busy_policy": "interrupt_then_dispatch"}]
    push_catalog(7, pushed)
    token = chat_login_via_passkey()
    r = client.get("/api/chat/commands", cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "live"
    assert body["version"] == 7
    assert body["commands"][0]["name"] == "/new"

    # A second, independent read hits the same live file — it is not a one-shot
    # "consume and revert to bootstrap" fallback.
    r2 = client.get("/api/chat/commands", cookies={"hub_chat_session": token})
    assert r2.json()["source"] == "live"
    assert r2.json()["version"] == 7


def test_bootstrap_catalog_json_parses_and_every_entry_is_well_formed():
    """Asserts against the actual shipped file, not a fixture — this is the
    hand-authored placeholder chat/routes.py serves as-is until a live push lands."""
    raw = json.loads(chat_routes.COMMAND_CATALOG_BOOTSTRAP_FILE.read_text())
    assert isinstance(raw["version"], int)
    commands = raw["commands"]
    assert len(commands) > 0
    for entry in commands:
        assert entry.get("name", "").startswith("/")
        assert entry.get("category") in ("builtin", "skill", "plugin", "alias")
        assert entry.get("busy_policy") in ("reject", "dispatch", "interrupt_then_dispatch")
    names = [c["name"] for c in commands]
    assert len(names) == len(set(names)), "bootstrap catalog has duplicate command names"


# --- send: writing a human message (chat/routes.py `/threads/{id}/send`) -----------
def test_send_appears_in_the_transcript():
    deliver("thr_send_a")  # seq 1: the agent's "hi"
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_send_a/send",
        json={"text": "hello there", "client_msg_id": "cid-a1"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deduped"] is False
    msg = body["message"]
    assert msg["role"] == "user" and msg["author_type"] == "human"
    assert msg["client_msg_id"] == "cid-a1"
    assert msg["parts"][0]["text"] == "hello there"
    assert msg["seq"] == 2

    detail = client.get("/api/chat/threads/thr_send_a", cookies={"hub_chat_session": token}).json()
    assert [m["parts"][0]["text"] for m in detail["messages"]] == ["hi", "hello there"]


def test_send_401s_without_a_cookie():
    deliver("thr_send_b")
    r = client.post("/api/chat/threads/thr_send_b/send", json={"text": "hi", "client_msg_id": "cid-b1"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"
    assert_no_secrets_leaked(r)


def test_send_404_for_an_unknown_thread():
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_send_nope/send",
        json={"text": "hi", "client_msg_id": "cid-c1"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"
    assert_no_secrets_leaked(r)


def test_send_never_lazily_creates_a_thread():
    token = chat_login_via_passkey()
    client.post(
        "/api/chat/threads/thr_send_ghost/send",
        json={"text": "hi", "client_msg_id": "cid-ghost"},
        cookies={"hub_chat_session": token},
    )
    assert chat_platform.get_store().get_thread("thr_send_ghost") is None


def test_send_rejects_blank_text():
    deliver("thr_send_d")
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_send_d/send",
        json={"text": "   ", "client_msg_id": "cid-d1"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 422


def test_send_is_idempotent_on_a_repeated_client_msg_id():
    deliver("thr_send_e")
    token = chat_login_via_passkey()
    body = {"text": "retry me", "client_msg_id": "cid-e1"}
    r1 = client.post("/api/chat/threads/thr_send_e/send", json=body, cookies={"hub_chat_session": token})
    r2 = client.post("/api/chat/threads/thr_send_e/send", json=body, cookies={"hub_chat_session": token})
    assert r1.status_code == 200 and r2.status_code == 200, (r1.text, r2.text)
    assert r1.json()["deduped"] is False
    assert r2.json()["deduped"] is True
    assert r1.json()["message"]["id"] == r2.json()["message"]["id"]
    detail = client.get("/api/chat/threads/thr_send_e", cookies={"hub_chat_session": token}).json()
    matches = [m for m in detail["messages"] if m["client_msg_id"] == "cid-e1"]
    assert len(matches) == 1


def test_send_pending_when_gateway_unconfigured():
    """Default posture in this test file: HERMES_API_BASE/HERMES_API_KEY are unset,
    same "not provisioned" fail-closed shape chat/platform.py's own
    HUB_PLATFORM_KEY_FILE check uses. This is the exact live state today — nothing in
    HUB_PLATFORM_KEY_FILE forwards `/send` traffic until the hub-api container is
    actually configured with HERMES_API_BASE/HERMES_API_KEY."""
    deliver("thr_send_f")
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_send_f/send",
        json={"text": "hi", "client_msg_id": "cid-f1"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 200, r.text
    msg = r.json()["message"]
    assert msg["forward_status"] == "pending"
    assert msg["forward_reason"] == "gateway not configured"


def test_send_pending_when_gateway_unreachable(monkeypatch):
    port = _unused_port()  # bound-then-closed: guaranteed nothing is listening there
    monkeypatch.setattr(chat_routes, "HERMES_API_BASE", f"http://127.0.0.1:{port}")
    monkeypatch.setattr(chat_routes, "HERMES_API_KEY", FAKE_HERMES_KEY)
    deliver("thr_send_g")
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_send_g/send",
        json={"text": "hi", "client_msg_id": "cid-g1"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 200, r.text
    msg = r.json()["message"]
    assert msg["forward_status"] == "pending"
    assert msg["forward_reason"] == "gateway unreachable"
    assert FAKE_HERMES_KEY not in r.text
    assert_no_secrets_leaked(r)
    # And the message really is there, not lost:
    detail = client.get("/api/chat/threads/thr_send_g", cookies={"hub_chat_session": token}).json()
    assert any(m["id"] == msg["id"] for m in detail["messages"])


def test_send_pending_when_gateway_returns_503(monkeypatch):
    httpd = _spawn_http_server(_Respond503Handler)
    try:
        port = httpd.server_address[1]
        monkeypatch.setattr(chat_routes, "HERMES_API_BASE", f"http://127.0.0.1:{port}")
        monkeypatch.setattr(chat_routes, "HERMES_API_KEY", FAKE_HERMES_KEY)
        deliver("thr_send_h")
        token = chat_login_via_passkey()
        r = client.post(
            "/api/chat/threads/thr_send_h/send",
            json={"text": "hi", "client_msg_id": "cid-h1"},
            cookies={"hub_chat_session": token},
        )
        assert r.status_code == 200, r.text
        msg = r.json()["message"]
        assert msg["forward_status"] == "pending"
        assert msg["forward_reason"] == "gateway returned 503"
        assert FAKE_HERMES_KEY not in r.text
        assert_no_secrets_leaked(r)
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_send_gateway_timeout_does_not_lose_the_message(monkeypatch):
    httpd = _spawn_http_server(_SlowHandler)
    try:
        port = httpd.server_address[1]
        monkeypatch.setattr(chat_routes, "HERMES_API_BASE", f"http://127.0.0.1:{port}")
        monkeypatch.setattr(chat_routes, "HERMES_API_KEY", FAKE_HERMES_KEY)
        monkeypatch.setattr(chat_routes, "HUB_CHAT_SEND_FORWARD_TIMEOUT_S", 0.05)
        deliver("thr_send_i")
        token = chat_login_via_passkey()
        r = client.post(
            "/api/chat/threads/thr_send_i/send",
            json={"text": "don't lose me", "client_msg_id": "cid-i1"},
            cookies={"hub_chat_session": token},
        )
        assert r.status_code == 200, r.text
        msg = r.json()["message"]
        assert msg["forward_status"] == "pending"
        assert FAKE_HERMES_KEY not in r.text
        assert_no_secrets_leaked(r)
        detail = client.get("/api/chat/threads/thr_send_i", cookies={"hub_chat_session": token}).json()
        user_texts = [m["parts"][0]["text"] for m in detail["messages"] if m["role"] == "user"]
        assert "don't lose me" in user_texts
    finally:
        httpd.shutdown()
        httpd.server_close()


# =====================================================================================
# WebSocket (chat/ws.py) — same fixtures, same `client`/cookie idiom above.
# =====================================================================================

# --- auth-in-handler: exact close code, not just "some disconnect" -----------------
def test_ws_closes_1008_with_no_cookie():
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/api/chat/ws") as ws:
            ws.receive_json()
    assert exc_info.value.code == 1008


def test_ws_closes_1008_with_a_garbage_cookie():
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": "not-a-real-token"}) as ws:
            ws.receive_json()
    assert exc_info.value.code == 1008


def test_ws_closes_1008_with_a_revoked_cookie():
    token = chat_login_via_passkey()
    client.post("/api/chat/logout", cookies={"hub_chat_session": token})
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
            ws.receive_json()
    assert exc_info.value.code == 1008


def test_ws_accepts_with_a_valid_cookie_and_sends_nothing_unprompted():
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        # No subscribe sent yet -> only a heartbeat can arrive, never a data frame.
        frame = ws.receive_json()
        assert frame == {"type": "heartbeat"}


def subscribe(ws, thread_id: str, after_seq: int = 0) -> list:
    """Subscribe and hand back the replayed frames. Every replay ends with a
    `synced` marker (chat/ws.py), and a heartbeat can land in between on a slow
    tick, so both are consumed here rather than in every test."""
    ws.send_json({"type": "subscribe", "thread_id": thread_id, "after_seq": after_seq})
    frames = []
    while True:
        frame = ws.receive_json()
        if frame.get("type") == "heartbeat":
            continue
        if frame.get("type") == "synced":
            assert frame["thread_id"] == thread_id
            return frames
        frames.append(frame)


# --- subscribe / replay -----------------------------------------------------------
def test_subscribe_replays_existing_events_oldest_first():
    deliver("thr_ws_a", parts=[{"type": "text", "text": "one"}])
    deliver("thr_ws_a", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_a", "after_seq": 0})
        f1 = ws.receive_json()
        f2 = ws.receive_json()
        assert (f1["seq"], f2["seq"]) == (1, 2)
        assert f1["type"] == "message.upsert" and f1["thread_id"] == "thr_ws_a"
        assert f1["parts"][0]["text"] == "one"
        assert f2["parts"][0]["text"] == "two"


def test_subscribe_after_seq_skips_already_seen():
    deliver("thr_ws_b", parts=[{"type": "text", "text": "one"}])
    deliver("thr_ws_b", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_b", "after_seq": 1})
        f = ws.receive_json()
        assert f["seq"] == 2
        assert f["parts"][0]["text"] == "two"


def test_subscribe_caught_up_yields_only_heartbeat():
    d = deliver("thr_ws_c")
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        assert subscribe(ws, "thr_ws_c", d["seq"]) == []
        frame = ws.receive_json()
        assert frame == {"type": "heartbeat"}


def test_subscribe_to_unknown_thread_is_a_silent_no_op():
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_ghost", "after_seq": 0})
        # Nothing to replay for a thread that doesn't exist, and it must not be
        # lazily created (same rule as the REST read routes).
        frame = ws.receive_json()
        assert frame == {"type": "heartbeat"}
    assert chat_platform.get_store().get_thread("thr_ws_ghost") is None


def test_unrecognised_message_type_is_ignored_not_fatal():
    deliver("thr_ws_d")
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "ping"})
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_d", "after_seq": 0})
        frame = ws.receive_json()
        assert frame["seq"] == 1


# --- live streaming after subscribe -----------------------------------------------
def test_new_events_stream_after_subscribe_without_a_reconnect():
    d = deliver("thr_ws_e")
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        assert subscribe(ws, "thr_ws_e", d["seq"]) == []
        deliver("thr_ws_e", parts=[{"type": "text", "text": "live"}])
        frame = ws.receive_json()
        assert frame["seq"] == 2
        assert frame["parts"][0]["text"] == "live"


def test_one_connection_can_subscribe_multiple_threads():
    deliver("thr_ws_f1")
    deliver("thr_ws_f2")
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        seen = {f["thread_id"] for f in subscribe(ws, "thr_ws_f1", 0) + subscribe(ws, "thr_ws_f2", 0)}
        assert seen == {"thr_ws_f1", "thr_ws_f2"}


# --- heartbeat ---------------------------------------------------------------------
def test_heartbeat_fires_on_an_idle_subscription():
    d = deliver("thr_ws_g")
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        assert subscribe(ws, "thr_ws_g", d["seq"]) == []
        # HUB_CHAT_WS_HEARTBEAT_INTERVAL_S=0.15 above -> this arrives well within a
        # couple of poll ticks (0.05s each), never mistaken for a data frame.
        frame = ws.receive_json()
        assert frame == {"type": "heartbeat"}


# --- replay: complete, ordered, and closed by `synced` ------------------------------
def test_a_replay_ends_with_synced_at_the_threads_version():
    deliver("thr_ws_sync", parts=[{"type": "text", "text": "one"}])
    d = deliver("thr_ws_sync", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_sync", "after_seq": 0})
        frames = [ws.receive_json() for _ in range(3)]
        assert [f["type"] for f in frames] == ["message.upsert", "message.upsert", "synced"]
        assert frames[-1] == {"type": "synced", "thread_id": "thr_ws_sync", "seq": d["seq"]}


def test_a_replay_longer_than_one_batch_is_complete_before_synced(monkeypatch):
    """A replay used to stop at one batch and leave the rest to the next poll
    tick: a reply landing as its first words, a pause, then the rest."""
    monkeypatch.setattr(chat_ws, "REPLAY_BATCH", 3)
    for i in range(7):
        deliver("thr_ws_long", parts=[{"type": "text", "text": f"m{i}"}])
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        frames = subscribe(ws, "thr_ws_long", 0)
        assert [f["seq"] for f in frames] == list(range(1, 8))


def test_events_of_a_swept_message_do_not_stall_the_replay(monkeypatch):
    """The scan continues from the last row READ, not the last row sent: a
    batch made only of a swept message's events looked empty, and a drain that
    resumed from the last surviving event re-read it for ever."""
    monkeypatch.setattr(chat_ws, "REPLAY_BATCH", 1)
    deliver("thr_ws_swept", parts=[{"type": "text", "text": "one"}])
    gone = deliver("thr_ws_swept", parts=[{"type": "text", "text": "a duplicate, later swept"}])
    deliver("thr_ws_swept", parts=[{"type": "text", "text": "three"}])
    store = chat_platform.get_store()
    store._conn.execute("DELETE FROM parts WHERE message_id=?", (gone["message_id"],))
    store._conn.execute("DELETE FROM messages WHERE id=?", (gone["message_id"],))
    store._conn.commit()
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_swept", "after_seq": 0})
        frames = []
        while True:
            frame = ws.receive_json()
            if frame.get("type") == "synced":
                break
            if frame.get("type") != "heartbeat":
                frames.append(frame)
        assert [f["seq"] for f in frames] == [1, 3]
        assert frame == {"type": "synced", "thread_id": "thr_ws_swept", "seq": 3}


def test_a_lower_subscribe_replays_again_but_never_moves_the_cursor_back():
    """A client that has just applied a snapshot asks from the snapshot's
    version on purpose. It gets the replay it asked for — its own version gates
    make what it already holds a no-op — and the connection keeps reading
    forward from where it was, so what lands next arrives exactly once."""
    deliver("thr_ws_low", parts=[{"type": "text", "text": "one"}])
    deliver("thr_ws_low", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        assert [f["seq"] for f in subscribe(ws, "thr_ws_low", 0)] == [1, 2]
        assert [f["seq"] for f in subscribe(ws, "thr_ws_low", 0)] == [1, 2]
        deliver("thr_ws_low", parts=[{"type": "text", "text": "three"}])
        frame = ws.receive_json()
        while frame.get("type") == "heartbeat":
            frame = ws.receive_json()
        assert frame["seq"] == 3
        assert ws.receive_json() == {"type": "heartbeat"}


# --- snapshot_required -------------------------------------------------------------
def test_snapshot_required_when_cursor_predates_the_surviving_log():
    deliver("thr_ws_h", parts=[{"type": "text", "text": "one"}])
    deliver("thr_ws_h", parts=[{"type": "text", "text": "two"}])
    deliver("thr_ws_h", parts=[{"type": "text", "text": "three"}])
    # Simulate prune_events already having deleted the earliest surviving event —
    # same direct-store-access idiom used above to mutate `pinned`.
    store = chat_platform.get_store()
    store._conn.execute("DELETE FROM events WHERE thread_id=? AND seq<=?", ("thr_ws_h", 2))
    store._conn.commit()
    assert store.earliest_event_seq("thr_ws_h") == 3

    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_h", "after_seq": 0})
        frame = ws.receive_json()
        assert frame == {"seq": 3, "thread_id": "thr_ws_h", "type": "snapshot_required"}


def test_no_snapshot_required_when_cursor_exactly_meets_the_surviving_log():
    deliver("thr_ws_i", parts=[{"type": "text", "text": "one"}])
    deliver("thr_ws_i", parts=[{"type": "text", "text": "two"}])
    store = chat_platform.get_store()
    store._conn.execute("DELETE FROM events WHERE thread_id=? AND seq<=?", ("thr_ws_i", 1))
    store._conn.commit()
    assert store.earliest_event_seq("thr_ws_i") == 2

    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        # after_seq=1 == surviving-earliest-1 -> not a gap, replay from seq 2 exactly.
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_i", "after_seq": 1})
        frame = ws.receive_json()
        assert frame["type"] == "message.upsert" and frame["seq"] == 2


# --- revocation reaches an already-open socket -------------------------------------
def test_logout_closes_an_already_open_socket():
    d = deliver("thr_ws_j")
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_ws_j", "after_seq": d["seq"]})
        lo = client.post("/api/chat/logout", cookies={"hub_chat_session": token})
        assert lo.status_code == 200
        with pytest.raises(WebSocketDisconnect) as exc_info:
            while True:
                ws.receive_json()
        assert exc_info.value.code == 1008


def test_locked_routes_check_the_cookie_before_the_body():
    """Same ordering rule as the platform key: a locked client posting garbage gets
    the 401 that tells it to unlock, not a 422 schema lecture."""
    r = client.post("/api/chat/threads/thr_send_z/send", json={})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"
    r = client.post("/api/chat/threads/thr_send_z/read", json={})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"


# --- phase 3: images both ways + the forward leg's real key ---------------------------

class _Record200Handler(http.server.BaseHTTPRequestHandler):
    """A gateway that accepts the event and remembers exactly what it was sent."""
    seen: list = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        type(self).seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def log_message(self, *a):
        pass


PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def upload(thread_id: str, token: str, raw: bytes = PNG_1PX, mime: str = "image/png"):
    return client.post(
        f"/api/chat/threads/{thread_id}/media",
        json={"mime": mime, "data_b64": base64.b64encode(raw).decode(), "width": 1, "height": 1},
        cookies={"hub_chat_session": token},
    )


def test_media_upload_then_get_roundtrips_the_bytes_behind_the_cookie():
    deliver("thr_media_a")
    token = chat_login_via_passkey()
    r = upload("thr_media_a", token)
    assert r.status_code == 200, r.text
    media_id = r.json()["media_id"]
    assert r.json()["size_bytes"] == len(PNG_1PX)
    got = client.get(f"/api/chat/media/{media_id}", cookies={"hub_chat_session": token})
    assert got.status_code == 200
    assert got.headers["content-type"] == "image/png"
    assert got.content == PNG_1PX
    assert "private" in got.headers["cache-control"]
    assert client.get(f"/api/chat/media/{media_id}").status_code == 401  # never a public URL


def test_media_get_404s_for_malformed_and_unknown_ids():
    token = chat_login_via_passkey()
    for bad in ("../../etc/passwd", "med_notahexstring0", "med_0123456789abcdef"):
        r = client.get(f"/api/chat/media/{bad}", cookies={"hub_chat_session": token})
        assert r.status_code == 404, bad
        assert_no_secrets_leaked(r)


def test_media_upload_rejects_bad_base64_and_oversize(monkeypatch):
    deliver("thr_media_b")
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_media_b/media", json={"mime": "image/png", "data_b64": "@@not base64@@"},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "bad_base64"
    monkeypatch.setattr(chat_routes, "MAX_MEDIA_DECODED_BYTES", 10)
    r = upload("thr_media_b", token)
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "media_too_large"
    r = client.post("/api/chat/threads/thr_media_b/media", json={"mime": "text/plain", "data_b64": "aGk="},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 422
    assert client.post("/api/chat/threads/thr_media_b/media", json={"mime": "image/png", "data_b64": "aGk="}).status_code == 401


def test_send_with_media_records_the_image_part_and_forwards_the_bytes(monkeypatch):
    _Record200Handler.seen = []
    httpd = _spawn_http_server(_Record200Handler)
    try:
        port = httpd.server_address[1]
        monkeypatch.setattr(chat_routes, "HERMES_API_BASE", f"http://127.0.0.1:{port}")
        deliver("thr_media_c")
        token = chat_login_via_passkey()
        media_id = upload("thr_media_c", token).json()["media_id"]
        r = client.post(
            "/api/chat/threads/thr_media_c/send",
            json={"text": "what is this?", "client_msg_id": "cid-media-1", "media_ids": [media_id]},
            cookies={"hub_chat_session": token},
        )
        assert r.status_code == 200, r.text
        msg = r.json()["message"]
        assert msg["forward_status"] == "forwarded", msg
        assert [p["type"] for p in msg["parts"]] == ["text", "image"]
        assert msg["parts"][1]["media_id"] == media_id
        assert msg["parts"][1]["mime"] == "image/png"
        sent = _Record200Handler.seen[-1]
        assert sent["path"] == "/api/platforms/hub/events"
        # The forward leg signs with the platform key, never the gateway API key.
        assert sent["auth"] == f"Bearer {PLATFORM_SECRET}"
        body = sent["body"]
        assert body["kind"] == "message" and body["thread_id"] == "thr_media_c" and body["text"] == "what is this?"
        assert body["media"][0]["media_id"] == media_id
        assert body["media"][0]["mime"] == "image/png"
        assert base64.b64decode(body["media"][0]["data_b64"]) == PNG_1PX
        assert "text" not in json.dumps(body["media"][0]), "media entries carry bytes, never the message text"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_send_with_media_only_needs_no_text():
    deliver("thr_media_d")
    token = chat_login_via_passkey()
    media_id = upload("thr_media_d", token).json()["media_id"]
    r = client.post("/api/chat/threads/thr_media_d/send",
                    json={"client_msg_id": "cid-media-2", "media_ids": [media_id]},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    assert [p["type"] for p in r.json()["message"]["parts"]] == ["image"]
    r = client.post("/api/chat/threads/thr_media_d/send", json={"client_msg_id": "cid-media-3"},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 422


def test_send_refuses_media_from_another_thread_or_the_agent():
    deliver("thr_media_e")
    deliver("thr_media_f")
    token = chat_login_via_passkey()
    other = upload("thr_media_e", token).json()["media_id"]
    r = client.post("/api/chat/threads/thr_media_f/send",
                    json={"text": "x", "client_msg_id": "cid-media-4", "media_ids": [other]},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "media_not_found"
    # An agent-uploaded row (origin "agent") is not the user's attachment either.
    agent = client.post("/api/platform/hub/media",
                        json={"thread_id": "thr_media_f", "mime": "image/png",
                              "data_b64": base64.b64encode(PNG_1PX).decode(), "origin": "agent"},
                        headers=PLATFORM_AUTH).json()["media_id"]
    r = client.post("/api/chat/threads/thr_media_f/send",
                    json={"text": "x", "client_msg_id": "cid-media-5", "media_ids": [agent]},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 404
    r = client.post("/api/chat/threads/thr_media_f/send",
                    json={"text": "x", "client_msg_id": "cid-media-6", "media_ids": ["med_x"]},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 422
    r = client.post("/api/chat/threads/thr_media_f/send",
                    json={"text": "x", "client_msg_id": "cid-media-7", "media_ids": [other] * 5},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 422


def test_forward_leg_reports_an_unprovisioned_platform_key(monkeypatch):
    deliver("thr_send_k")
    token = chat_login_via_passkey()
    # Key vanishes between the delivery and the send (a rotation gone wrong): the
    # human message is still recorded, and the reason says exactly what is missing.
    monkeypatch.setattr(chat_routes, "HERMES_API_BASE", "http://127.0.0.1:1")
    monkeypatch.setattr(chat_platform, "HUB_PLATFORM_KEY_FILE", TMP / "missing-key-for-forward")
    r = client.post("/api/chat/threads/thr_send_k/send", json={"text": "hi", "client_msg_id": "cid-k1"},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 200
    assert r.json()["message"]["forward_reason"] == "platform key unprovisioned"


# --- starting a thread from the phone (the prototype's `New` button) -------------------

def test_create_thread_mints_a_server_side_id_and_lists_it():
    token = chat_login_via_passkey()
    before = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    r = client.post("/api/chat/threads", json={"title": "Fast sleeve"}, cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    thread = r.json()["thread"]
    assert thread["id"].startswith("thr_") and len(thread["id"]) == 20
    assert (thread["kind"], thread["title"], thread["last_seq"], thread["unread"]) == ("chat", "Fast sleeve", 0, 0)
    after = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    assert len(after) == len(before) + 1
    assert thread["id"] in [t["id"] for t in after]
    # And it is immediately usable: /send 404s on an unknown thread, not this one.
    sent = client.post(
        f"/api/chat/threads/{thread['id']}/send",
        json={"text": "hi", "client_msg_id": "cid-new-1"},
        cookies={"hub_chat_session": token},
    )
    assert sent.status_code == 200, sent.text


def test_create_thread_without_a_title_and_twice_never_collides():
    token = chat_login_via_passkey()
    a = client.post("/api/chat/threads", json={}, cookies={"hub_chat_session": token}).json()["thread"]
    b = client.post("/api/chat/threads", json={}, cookies={"hub_chat_session": token}).json()["thread"]
    assert a["id"] != b["id"]
    assert a["title"] is None and b["title"] is None


def test_create_thread_is_cookie_gated_and_bounds_the_title():
    assert client.post("/api/chat/threads", json={}).status_code == 401
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads", json={"title": "x" * 201}, cookies={"hub_chat_session": token})
    assert r.status_code == 422
    r = client.post("/api/chat/threads", json={"id": "ops"}, cookies={"hub_chat_session": token})
    assert r.status_code == 422, "a client must never choose the id — `ops` is a delivery target"


# --- a thread names itself from the first thing said in it ----------------------------

def test_send_names_an_unnamed_thread_from_the_first_message():
    token = chat_login_via_passkey()
    thread = client.post("/api/chat/threads", json={}, cookies={"hub_chat_session": token}).json()["thread"]
    assert thread["title"] is None
    client.post(
        f"/api/chat/threads/{thread['id']}/send",
        json={"text": "what might i be forgetting from today", "client_msg_id": "cid-title-1"},
        cookies={"hub_chat_session": token},
    )
    listed = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    named = next(t for t in listed if t["id"] == thread["id"])
    assert named["title"] == "what might i be forgetting from today"
    # …and a second message does NOT rename it.
    client.post(
        f"/api/chat/threads/{thread['id']}/send",
        json={"text": "something else entirely", "client_msg_id": "cid-title-2"},
        cookies={"hub_chat_session": token},
    )
    again = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    assert next(t for t in again if t["id"] == thread["id"])["title"] == "what might i be forgetting from today"


def test_auto_title_is_one_trimmed_line_and_never_overwrites_a_delivered_name():
    token = chat_login_via_passkey()
    long_text = "Check the archive retention thing and tell me whether we archive or delete the old segments"
    thread = client.post("/api/chat/threads", json={}, cookies={"hub_chat_session": token}).json()["thread"]
    client.post(
        f"/api/chat/threads/{thread['id']}/send",
        json={"text": f"  {long_text}  \nsecond line", "client_msg_id": "cid-title-3"},
        cookies={"hub_chat_session": token},
    )
    listed = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    title = next(t for t in listed if t["id"] == thread["id"])["title"]
    assert title.endswith("…") and len(title) <= 49 and "\n" not in title
    assert long_text.startswith(title[:-1])
    # A gateway-named thread keeps its name.
    deliver("thr_named_1", title="Ops")
    client.post(
        "/api/chat/threads/thr_named_1/send",
        json={"text": "hello there", "client_msg_id": "cid-title-4"},
        cookies={"hub_chat_session": token},
    )
    listed = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    assert next(t for t in listed if t["id"] == "thr_named_1")["title"] == "Ops"


# --- row chrome: preview, provenance and the fields behind each pill ---------------

def test_thread_payload_carries_a_last_message_preview_and_its_role():
    deliver("thr_prev", parts=[{"type": "text", "text": "first"}])
    deliver("thr_prev", parts=[{"type": "text", "text": "  the  newest   words \n more"}])
    token = chat_login_via_passkey()
    t = next(
        t for t in client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
        if t["id"] == "thr_prev"
    )
    assert t["preview"] == "the newest words more"
    assert t["preview_role"] == "assistant"


def test_preview_is_the_newest_TEXT_part_not_the_newest_message():
    deliver("thr_prev2", parts=[{"type": "text", "text": "said out loud"}])
    deliver("thr_prev2", parts=[{"type": "tool_call", "tool_name": "bash"}])
    token = chat_login_via_passkey()
    t = next(
        t for t in client.get("/api/chat/threads", cookies={"hub_chat_session": token}).json()["threads"]
        if t["id"] == "thr_prev2"
    )
    assert t["preview"] == "said out loud"


def test_preview_is_null_for_a_thread_with_nothing_said_in_it():
    token = chat_login_via_passkey()
    thread = client.post("/api/chat/threads", json={}, cookies={"hub_chat_session": token}).json()["thread"]
    assert thread["preview"] is None and thread["preview_role"] is None
    listed = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    assert next(t for t in listed if t["id"] == thread["id"])["preview"] is None


def test_preview_is_truncated_to_one_bounded_line():
    deliver("thr_prev3", parts=[{"type": "text", "text": "x" * 500}])
    token = chat_login_via_passkey()
    t = next(
        t for t in client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
        if t["id"] == "thr_prev3"
    )
    assert len(t["preview"]) == 140 and t["preview"].endswith("…")


def test_a_human_send_previews_as_the_users_own_words():
    deliver("thr_prev4")
    token = chat_login_via_passkey()
    client.post(
        "/api/chat/threads/thr_prev4/send",
        json={"text": "what did i miss", "client_msg_id": "cid-prev-1"},
        cookies={"hub_chat_session": token},
    )
    t = next(
        t for t in client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
        if t["id"] == "thr_prev4"
    )
    assert (t["preview"], t["preview_role"]) == ("what did i miss", "user")


def test_thread_payload_exposes_kind_session_and_provenance_columns():
    """The three pills' only honest sources: `kind` for the cron/brief badge,
    `origin_*` for provenance, `hermes_session_id` for the model lookup. Nothing
    writes `origin_*` yet — the payload reports the column, never a guess."""
    deliver("thr_prov", kind="cron", hermes_session_id="sess-prov-1")
    store = chat_platform.get_store()
    store._conn.execute(
        "UPDATE threads SET origin_thread_id=?, origin_message_id=? WHERE id=?",
        ("brief", "msg_origin_1", "thr_prov"),
    )
    store._conn.commit()
    token = chat_login_via_passkey()
    t = next(
        t for t in client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
        if t["id"] == "thr_prov"
    )
    assert t["kind"] == "cron"
    assert t["hermes_session_id"] == "sess-prov-1"
    assert (t["origin_thread_id"], t["origin_message_id"]) == ("brief", "msg_origin_1")
    detail = client.get("/api/chat/threads/thr_prov", cookies={"hub_chat_session": token}).json()["thread"]
    assert detail["origin_thread_id"] == "brief" and detail["preview"] == "hi"


def test_provenance_is_null_when_the_thread_has_no_origin():
    deliver("thr_noprov")
    token = chat_login_via_passkey()
    t = next(
        t for t in client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
        if t["id"] == "thr_noprov"
    )
    assert t["origin_thread_id"] is None and t["origin_message_id"] is None
    assert t["hermes_session_id"] is None


# --- the thread menu: pin / rename / archive (PATCH /threads/{id}) -----------------

def test_patch_pins_and_unpins_a_thread():
    deliver("thr_pin")
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_pin/patch", json={"pinned": True}, cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    assert r.json()["thread"]["pinned"] is True
    listed = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    assert next(t for t in listed if t["id"] == "thr_pin")["pinned"] is True
    r = client.post("/api/chat/threads/thr_pin/patch", json={"pinned": False}, cookies={"hub_chat_session": token})
    assert r.json()["thread"]["pinned"] is False


def test_patch_archives_and_renames():
    deliver("thr_arch", title="Ops")
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_arch/patch",
        json={"archived": True, "title": "  Old ops chatter  "},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 200, r.text
    thread = r.json()["thread"]
    assert thread["archived"] is True
    # A rename OVERWRITES a name the gateway gave — unlike the auto-namer.
    assert thread["title"] == "Old ops chatter"


def test_patch_never_adds_a_phantom_unread_to_a_read_thread():
    deliver("thr_pin_unread")
    token = chat_login_via_passkey()
    client.post("/api/chat/threads/thr_pin_unread/read", json={"seq": 1}, cookies={"hub_chat_session": token})
    r = client.post(
        "/api/chat/threads/thr_pin_unread/patch", json={"pinned": True}, cookies={"hub_chat_session": token}
    )
    assert r.json()["thread"]["unread"] == 0
    listed = client.get("/api/chat/bootstrap", cookies={"hub_chat_session": token}).json()["threads"]
    assert next(t for t in listed if t["id"] == "thr_pin_unread")["unread"] == 0


def test_patch_leaves_genuinely_unread_messages_unread():
    deliver("thr_pin_unread2")
    deliver("thr_pin_unread2", parts=[{"type": "text", "text": "two"}])
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_pin_unread2/patch", json={"pinned": True}, cookies={"hub_chat_session": token}
    )
    assert r.json()["thread"]["unread"] == 2


def test_patch_emits_a_thread_patch_event_an_open_client_replays():
    deliver("thr_pin_ws")
    token = chat_login_via_passkey()
    client.post("/api/chat/threads/thr_pin_ws/patch", json={"pinned": True}, cookies={"hub_chat_session": token})
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        ws.send_json({"type": "subscribe", "thread_id": "thr_pin_ws", "after_seq": 1})
        frame = ws.receive_json()
    # Flat, like every other frame: chat/ws.py's `_event_frame` spreads an event's
    # payload into the envelope rather than nesting it.
    assert frame["type"] == "thread.patch"
    assert frame["pinned"] is True


def test_patch_404s_for_an_unknown_thread_and_never_creates_it():
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_nope_patch/patch", json={"pinned": True}, cookies={"hub_chat_session": token})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"
    assert chat_platform.get_store().get_thread("thr_nope_patch") is None
    assert_no_secrets_leaked(r)


def test_patch_401s_without_a_cookie():
    deliver("thr_patch_auth")
    assert client.post("/api/chat/threads/thr_patch_auth/patch", json={"pinned": True}).status_code == 401


def test_patch_rejects_an_empty_blank_or_oversize_body():
    deliver("thr_patch_bounds")
    token = chat_login_via_passkey()
    for body in ({}, {"title": "   "}, {"title": "x" * 201}, {"pinned": True, "hub_user_id": "someone"}):
        r = client.post("/api/chat/threads/thr_patch_bounds/patch", json=body, cookies={"hub_chat_session": token})
        assert r.status_code == 422, (body, r.text)


# --- re-titling: the agent's gate and the user's are not each other's (L50) ---------------

def test_the_chat_cookie_never_opens_the_platform_re_titling_routes():
    """The two title surfaces are deliberately on different gates: `/threads/{id}/patch`
    is the user renaming from the thread menu (cookie), `/api/platform/hub/title` is the
    review job renaming as the agent (HUB_PLATFORM_KEY). An hour-long cookie captured
    from the phone must not reach the agent surface, in either direction."""
    deliver("thr_xgate", title="hello")
    token = chat_login_via_passkey()
    r = client.post("/api/platform/hub/title", json={"thread_id": "thr_xgate", "title": "Renamed"},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "hub_platform_key_invalid"
    assert_no_secrets_leaked(r)
    r = client.get("/api/platform/hub/title-review", cookies={"hub_chat_session": token})
    assert r.status_code == 401
    assert_no_secrets_leaked(r)
    assert chat_platform.get_store().get_thread("thr_xgate")["title"] == "hello"


def test_the_platform_key_never_opens_users_own_thread_patch():
    deliver("thr_xgate_2", title="hello")
    r = client.post("/api/chat/threads/thr_xgate_2/patch", json={"title": "Renamed"}, headers=PLATFORM_AUTH)
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "chat_locked"
    assert_no_secrets_leaked(r)
    assert chat_platform.get_store().get_thread("thr_xgate_2")["title"] == "hello"


def test_a_re_title_reaches_an_open_client_as_a_thread_patch_frame():
    """Same event the first-message namer emits, so a phone with the thread open
    re-titles the row live instead of waiting for a refetch."""
    deliver("thr_xgate_ws", title="hello")
    d = deliver("thr_xgate_ws", parts=[{"type": "text", "text": "and on to something else"}])
    token = chat_login_via_passkey()
    with client.websocket_connect("/api/chat/ws", cookies={"hub_chat_session": token}) as ws:
        assert subscribe(ws, "thr_xgate_ws", d["seq"]) == []
        r = client.post("/api/platform/hub/title",
                        json={"thread_id": "thr_xgate_ws", "title": "Archive retention policy"},
                        headers=PLATFORM_AUTH)
        assert r.status_code == 200, r.text
        frame = ws.receive_json()
        while frame.get("type") == "heartbeat":
            frame = ws.receive_json()
        assert frame["type"] == "thread.patch"
        assert frame["thread_id"] == "thr_xgate_ws"
        assert frame["title"] == "Archive retention policy"


def test_users_own_rename_takes_the_thread_out_of_the_review_queue():
    """Otherwise the job would see a thread the user just named as overdue for a name and
    rename it back over him."""
    deliver("thr_xgate_manual", title="hello")
    for i in range(9):
        deliver("thr_xgate_manual", parts=[{"type": "text", "text": f"line {i}"}])
    store = chat_platform.get_store()
    assert any(c["id"] == "thr_xgate_manual" for c in store.list_title_review_candidates(min_messages=8, limit=50))
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_xgate_manual/patch", json={"title": "the user's own name"},
                    cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    assert not any(c["id"] == "thr_xgate_manual"
                   for c in store.list_title_review_candidates(min_messages=8, limit=50))


# --- Stop: the button behind the composer -----------------------------------------

def test_stop_forwards_to_the_gateway(monkeypatch):
    """The gateway does the work: its own `/stop` command carries
    `busy_policy: interrupt_then_dispatch`, so a running turn is interrupted
    and then the command runs."""
    deliver("thr_stop")
    sent = []
    monkeypatch.setattr(
        chat_routes, "forward_gateway_event",
        lambda payload: (sent.append(payload), ("forwarded", ""))[1],
    )
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_stop/stop", cookies={"hub_chat_session": token})
    assert r.status_code == 200, r.text
    assert sent == [{"kind": "stop", "thread_id": "thr_stop"}]


def test_stop_needs_the_cookie():
    deliver("thr_stop_gate")
    assert client.post("/api/chat/threads/thr_stop_gate/stop").status_code == 401


def test_stop_on_an_unknown_thread_is_a_404_not_a_silent_ok(monkeypatch):
    sent = []
    monkeypatch.setattr(
        chat_routes, "forward_gateway_event",
        lambda payload: (sent.append(payload), ("forwarded", ""))[1],
    )
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_never_existed/stop", cookies={"hub_chat_session": token})
    assert r.status_code == 404
    assert sent == []


def test_stop_says_so_when_the_gateway_does_not_answer(monkeypatch):
    """A Stop that never reached the gateway must not read as a stopped turn."""
    deliver("thr_stop_down")
    monkeypatch.setattr(chat_routes, "forward_gateway_event", lambda payload: ("pending", "unreachable"))
    token = chat_login_via_passkey()
    r = client.post("/api/chat/threads/thr_stop_down/stop", cookies={"hub_chat_session": token})
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "gateway_unreachable"


# --- clarify: the answer goes to the parked tool call, never to /send --------------

def test_clarify_answer_forwards_the_id_and_the_text(monkeypatch):
    deliver("thr_clar")
    sent = []
    monkeypatch.setattr(
        chat_routes, "forward_gateway_event",
        lambda payload: (sent.append(payload), ("forwarded", ""))[1],
    )
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/clarify/clr_1",
        json={"thread_id": "thr_clar", "response": "2"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 200, r.text
    assert sent == [{"kind": "clarify_response", "thread_id": "thr_clar", "clarify_id": "clr_1", "response": "2"}]


def test_clarify_answer_never_becomes_a_chat_message(monkeypatch):
    """Routing the answer through /send would start a second turn and leave the
    first parked until it timed out."""
    deliver("thr_clar_nomsg")
    monkeypatch.setattr(chat_routes, "forward_gateway_event", lambda payload: ("forwarded", ""))
    token = chat_login_via_passkey()
    before = len(client.get("/api/chat/threads/thr_clar_nomsg", cookies={"hub_chat_session": token}).json()["messages"])
    client.post(
        "/api/chat/clarify/clr_2",
        json={"thread_id": "thr_clar_nomsg", "response": "prod"},
        cookies={"hub_chat_session": token},
    )
    after = len(client.get("/api/chat/threads/thr_clar_nomsg", cookies={"hub_chat_session": token}).json()["messages"])
    assert after == before


def test_clarify_answer_needs_the_cookie():
    deliver("thr_clar_gate")
    r = client.post("/api/chat/clarify/clr_3", json={"thread_id": "thr_clar_gate", "response": "1"})
    assert r.status_code == 401


def test_clarify_answer_for_an_unknown_thread_is_a_404(monkeypatch):
    sent = []
    monkeypatch.setattr(
        chat_routes, "forward_gateway_event",
        lambda payload: (sent.append(payload), ("forwarded", ""))[1],
    )
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/clarify/clr_4",
        json={"thread_id": "thr_nope", "response": "1"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 404
    assert sent == []


def test_clarify_answer_rejects_an_empty_response():
    deliver("thr_clar_empty")
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/clarify/clr_5",
        json={"thread_id": "thr_clar_empty", "response": ""},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 422


def test_clarify_answer_says_so_when_the_gateway_does_not_answer(monkeypatch):
    deliver("thr_clar_down")
    monkeypatch.setattr(chat_routes, "forward_gateway_event", lambda payload: ("pending", "unreachable"))
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/clarify/clr_6",
        json={"thread_id": "thr_clar_down", "response": "1"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 502


# --- the composer's Queue / Steer / Redirect chip ----------------------------------

def test_send_carries_the_mode_to_the_gateway(monkeypatch):
    """The chip rendered and changed nothing: no field on /send carried it, so
    picking Redirect sent exactly what Queue did (gap A4)."""
    deliver("thr_mode")
    sent = []
    monkeypatch.setattr(chat_routes, "forward_gateway_event", lambda payload: (sent.append(payload), ("forwarded", ""))[1])
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_mode/send",
        json={"text": "cut in", "client_msg_id": "cid-mode-1", "mode": "redirect"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 200, r.text
    assert sent[0]["mode"] == "redirect"


def test_send_without_a_mode_leaves_the_gateway_setting_alone(monkeypatch):
    deliver("thr_mode_none")
    sent = []
    monkeypatch.setattr(chat_routes, "forward_gateway_event", lambda payload: (sent.append(payload), ("forwarded", ""))[1])
    token = chat_login_via_passkey()
    client.post(
        "/api/chat/threads/thr_mode_none/send",
        json={"text": "hi", "client_msg_id": "cid-mode-2"},
        cookies={"hub_chat_session": token},
    )
    assert "mode" not in sent[0]


def test_send_rejects_a_mode_the_gateway_does_not_know():
    deliver("thr_mode_bad")
    token = chat_login_via_passkey()
    r = client.post(
        "/api/chat/threads/thr_mode_bad/send",
        json={"text": "hi", "client_msg_id": "cid-mode-3", "mode": "yolo"},
        cookies={"hub_chat_session": token},
    )
    assert r.status_code == 422
