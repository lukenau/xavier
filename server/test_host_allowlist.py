"""DNS-rebinding defence: the server answers only to hostnames it was told about.

The server binds loopback and most reads are unauthenticated, so a page on an
attacker's domain that re-resolves that domain to 127.0.0.1 could otherwise read it
through the victim's browser. Such a request still carries the attacker's hostname in
Host, which is what HostAllowlistMiddleware refuses.

Run in its own process like every other test file (run_tests.sh).
"""
import os
import pathlib
import sys

import pytest

os.environ["HUB_ORIGIN"] = "https://hub.example.test:8443"
os.environ["HUB_ALLOWED_HOSTS"] = "testserver, Extra.Example.Test:9000 ,[fd00::1]"

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi import WebSocketDisconnect  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as hub_app  # noqa: E402

client = TestClient(hub_app.app)


@pytest.mark.parametrize("base", [
    "http://127.0.0.1:8090",       # the docker healthcheck and install.sh probes
    "http://localhost:8090",
    "http://[::1]:8090",
    "https://hub.example.test:8443",  # HUB_ORIGIN
    "https://HUB.EXAMPLE.TEST",
    "http://extra.example.test",      # HUB_ALLOWED_HOSTS, port and case ignored
    "http://[fd00::1]:8090",
])
def test_named_hosts_are_served(base):
    r = client.get(f"{base}/api/healthz")
    assert r.status_code == 200, (base, r.text)


@pytest.mark.parametrize("base", [
    "http://attacker.example",
    "http://127.0.0.1.attacker.example",
    "http://hub.example.test.attacker.example",
    "http://localhost.attacker.example:8090",
])
def test_unknown_hosts_are_refused(base):
    r = client.get(f"{base}/api/healthz")
    assert r.status_code == 421, (base, r.text)
    assert r.json()["detail"]["code"] == "host_not_allowed"


def test_a_missing_host_is_refused():
    r = client.get("/api/healthz", headers={"Host": ""})
    assert r.status_code == 421, r.text


def test_a_refused_host_never_reaches_a_route():
    """Refused before routing: no read, and not even the 405/422 a write would earn."""
    assert client.get("http://attacker.example/api/passkey/status").status_code == 421
    assert client.post("http://attacker.example/api/action/apply", json={}).status_code == 421


def test_a_websocket_from_an_unknown_host_is_refused():
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("ws://attacker.example/api/chat/ws"):
            pass
    assert exc.value.code == 1008


def test_the_allowlist_reads_the_environment():
    assert hub_app.ALLOWED_HOSTS == {
        "localhost", "127.0.0.1", "::1", "hub.example.test", "testserver", "extra.example.test", "fd00::1",
    }
