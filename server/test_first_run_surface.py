"""Cold-start surface — the rough edge a first run met on the iMessage compose route,
`POST /api/chat/imessage/draft`.

That route is the POST target of the server-rendered no-JS iMessage pages, so a browser
form submit (which always advertises `text/html`) still gets its HTML result page. Any
other client — `Accept: application/json`, or a wildcard that names no HTML — must get
the SAME structured error shape every other endpoint uses (`{"detail": {"code",
"detail"}}`). Before this, the error body was an HTML document, so a client doing
`res.json()` on the error path got a parse failure instead of the actual error.

The route needs an authenticated caller; these requests carry the platform key. The
locked-gate states (`no credential -> 412 no_passkey / "enrol"`; a lapsed session
with a credential on file -> `401 <surface>_locked` / "re-authenticate") are pinned in
test_chat_gate.py, where the passkey fixtures live.

Run in its own process like the other test files (see run_tests.sh).
"""
import os
import pathlib
import sys
import tempfile

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
(TMP / "hub-platform-key").write_text("test-platform-secret\n")
os.environ["HUB_PLATFORM_KEY_FILE"] = str(TMP / "hub-platform-key")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

import app as hub_app  # noqa: E402

client = TestClient(hub_app.app)

DRAFT_URL = "/api/chat/imessage/draft"
AUTH = {"Authorization": "Bearer test-platform-secret"}
BROWSER_ACCEPT = {**AUTH, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
JSON_ACCEPT = {**AUTH, "Accept": "application/json"}


@pytest.fixture(autouse=True)
def fresh_draft_budget():
    hub_app._IM_DRAFT_TIMES.clear()
    yield


def test_imessage_draft_error_is_json_for_a_non_browser_client():
    """`POST {}` is the malformed form a client sends by accident; the error must be
    the JSON shape every other endpoint uses, not an HTML page."""
    r = client.post(DRAFT_URL, data={}, headers=JSON_ACCEPT)
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/json")
    detail = r.json()["detail"]
    assert detail["code"] == "empty_message"
    assert isinstance(detail["detail"], str)


def test_imessage_draft_error_is_json_for_a_wildcard_client():
    """A client that names no HTML (httpx's own default `Accept: */*`) also gets JSON —
    anything but an explicit text/html request is a non-browser caller."""
    r = client.post(DRAFT_URL, data={}, headers=AUTH)
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["detail"]["code"] == "empty_message"


def test_imessage_draft_error_is_a_page_for_a_browser():
    """A browser form submit still gets the server-rendered result page — the fix must
    not have traded one broken caller for another."""
    r = client.post(DRAFT_URL, data={}, headers=BROWSER_ACCEPT)
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("text/html")
    assert "Nothing to send" in r.text


def test_imessage_draft_every_validation_error_keeps_the_json_shape():
    """The other validation paths share the shape — a client parsing any of them as
    JSON gets the real error, not an HTML document."""
    cases = [
        ({"text": "hi", "contact": "Dana", "chat_id": "not-a-number"}, "bad_chat_id"),
        ({"text": "hi", "chat_id": "15551234567"}, "missing_contact"),
        ({"text": "x" * 2001, "chat_id": "15551234567", "contact": "Dana"}, "message_too_long"),
    ]
    for data, expected_code in cases:
        r = client.post(DRAFT_URL, data=data, headers=JSON_ACCEPT)
        assert r.status_code == 400, r.text
        assert r.headers["content-type"].startswith("application/json"), r.text
        assert r.json()["detail"]["code"] == expected_code, r.text


def test_an_unauthenticated_draft_is_refused_in_the_callers_own_shape():
    r = client.post(DRAFT_URL, data={}, headers={"Accept": "application/json"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "unauthenticated"
    r = client.post(DRAFT_URL, data={}, headers={"Accept": "text/html"})
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/html")
