"""Who may open the Live voice socket, and keep it open.

hub_chat_session is SameSite=Strict, which only stops cross-SITE pages. Another port
on the hub's host, or another machine in the same tailnet, is same-site, and the
same-origin policy does not apply to WebSockets, so /api/live checks the handshake's
Origin exactly as the terminal does (`_ws_origin_ok` in app.py) on top of the cookie.
A refused Origin closes with Live's own code (4403), not 1008, which the app answers
by locking chat. And like the chat socket, an open Live socket closes 1008 once its
session lapses.

Run in its own process like every other test file (run_tests.sh).
"""
import os
import pathlib
import sys

import pytest

os.environ["HUB_ORIGIN"] = "https://hub.example.test"

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi import WebSocketDisconnect  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as hub_app  # noqa: E402
import live_session  # noqa: E402

client = TestClient(hub_app.app)


@pytest.fixture(autouse=True)
def unlocked(monkeypatch):
    monkeypatch.setattr(live_session, "chat_session_valid", lambda token: True)


def closed_with(ws) -> int:
    """Read until the server closes the socket; the code it closed with. Waiting for
    the close means the endpoint has finished before the test client tears down."""
    try:
        while True:
            ws.receive_json()
    except WebSocketDisconnect as exc:
        return exc.code


def answers_ping(headers) -> int | None:
    """None when the socket was accepted and is live; else the code it closed with."""
    try:
        with client.websocket_connect("/api/live", headers=headers) as ws:
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong"}
            ws.send_json({"type": "stop"})
            assert closed_with(ws) == 1000
            return None
    except WebSocketDisconnect as exc:
        return exc.code


def test_the_app_wires_the_terminal_check_and_the_send_path():
    assert live_session.origin_ok is hub_app._ws_origin_ok
    assert live_session.send_message is hub_app._live_send_message
    assert live_session.stop_run is hub_app._live_stop_run


@pytest.mark.parametrize("headers", [
    {},                                             # not a browser: the native app may send none
    {"origin": "http://testserver"},                # the Host it came in on
    {"origin": "https://testserver:443"},           # default ports fold
    {"origin": "https://hub.example.test"},         # HUB_ORIGIN, behind a proxy that rewrote Host
    {"origin": "https://HUB.example.test/"},
])
def test_this_hub_is_accepted(headers):
    assert answers_ping(headers) is None


@pytest.mark.parametrize("origin", [
    "https://hub.example.test:8444",    # same host, another port: same-site
    "https://other.example.test",       # another machine on the same mesh
    "https://attacker.example",
    "http://testserver:8080",
    "null",                             # sandboxed iframe, file: URL
    "chrome-extension://abcdef",
    "https://testserver.attacker.example",
    "https://[::1",
])
def test_other_origins_are_refused_without_locking_chat(origin):
    assert answers_ping({"origin": origin}) == live_session.ORIGIN_REFUSED == 4403


def test_the_chat_session_is_still_required(monkeypatch):
    monkeypatch.setattr(live_session, "chat_session_valid", lambda token: False)
    assert answers_ping({"origin": "http://testserver"}) == 1008
    assert answers_ping({}) == 1008


def test_a_session_that_lapses_closes_the_open_socket(monkeypatch):
    """A logout revokes the cookie at once; an open mic must not outlive it."""
    state = {"valid": True}
    monkeypatch.setattr(live_session, "chat_session_valid", lambda token: state["valid"])
    monkeypatch.setattr(live_session, "SESSION_CHECK_S", 0.01)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/api/live", headers={"origin": "http://testserver"}) as ws:
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong"}
            state["valid"] = False
            ws.receive_json()
    assert exc.value.code == 1008
