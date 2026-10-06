"""The terminal WebSocket refuses a browser page from any other origin.

hub_term_session is SameSite=Strict, which only stops cross-SITE pages. Another port
on the hub's host, or another machine in the same tailnet, is same-site, and the
same-origin policy does not apply to WebSockets, so the handshake's Origin is checked.

Run in its own process like every other test file (run_tests.sh).
"""
import os
import pathlib
import sys

import pytest

os.environ["HUB_ORIGIN"] = "https://hub.example.test"
os.environ["HUB_TTYD_SOCK"] = "/nonexistent/ttyd.sock"
os.environ.pop("HUB_TMUXD_SOCK", None)

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi import WebSocketDisconnect  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as hub_app  # noqa: E402

client = TestClient(hub_app.app)


@pytest.fixture(autouse=True)
def unlocked(monkeypatch):
    """A valid terminal session, and a ttyd that is down: an accepted handshake then
    closes 1011, a refused one closes 1008 before it is accepted."""
    monkeypatch.setattr(hub_app, "_term_session_valid", lambda token: True)

    async def ttyd_down():
        raise OSError("ttyd is not running in this test")

    monkeypatch.setattr(hub_app, "_ttyd_ws_connect", ttyd_down)


def close_code(headers):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/terminal/ws", headers=headers) as ws:
            ws.receive_bytes()
    return exc.value.code


@pytest.mark.parametrize("headers", [
    {},                                             # not a browser: the native app may send none
    {"origin": "http://testserver"},                # the Host it came in on
    {"origin": "https://testserver:443"},           # default ports fold
    {"origin": "https://hub.example.test"},         # HUB_ORIGIN, behind a proxy that rewrote Host
    {"origin": "https://HUB.example.test/"},
])
def test_this_hub_is_accepted(headers):
    assert close_code(headers) == 1011  # accepted, then the (absent) ttyd failed


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
def test_other_origins_are_refused_before_accept(origin):
    assert close_code({"origin": origin}) == 1008


def test_the_session_is_still_required(monkeypatch):
    monkeypatch.setattr(hub_app, "_term_session_valid", lambda token: False)
    assert close_code({"origin": "http://testserver"}) == 1008


@pytest.mark.parametrize("cwd", ["/home/u/../etc", "/home/u/./x", "/home/u/..", "/home/u/#(id)"])
def test_spawn_cwd_without_dot_segments(cwd):
    req = hub_app.WriteRequest(action="tmux.spawn", cwd=cwd)
    with pytest.raises(hub_app.HTTPException) as exc:
        hub_app._validate_tmux_request(req)
    assert exc.value.status_code == 400
    hub_app._validate_tmux_request(hub_app.WriteRequest(action="tmux.spawn", cwd="/home/u/.config/x"))


def test_tmuxd_is_off_until_configured():
    assert hub_app.HUB_TMUXD_SOCK == ""
    with pytest.raises(OSError, match="not configured"):
        hub_app._tmuxd_request("GET", "/sessions")
