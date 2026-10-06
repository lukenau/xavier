"""Chat push notifications: what earns one, and when he is not there to see it.

the user, 2026-09-22: notify "only when the message is sent from the agent and not
while it's thinking or making tool calls", and "only when I leave the app".

    python3 -m pytest test_chat_notify.py -q
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

TOKENS = Path(tempfile.mkdtemp()) / "push_tokens.json"
os.environ["HUB_PUSH_TOKENS"] = str(TOKENS)

from chat import notify  # noqa: E402


class FakeExpo:
    """Stands in for exp.host, and records what it was asked to send."""

    def __init__(self, tickets: int = 1) -> None:
        self.sent: list[list[dict]] = []
        self.tickets = tickets

    def __call__(self, req, timeout):  # noqa: ANN001
        self.sent.append(json.loads(req.data.decode()))
        payload = json.dumps({"data": [{"status": "ok"}] * self.tickets}).encode()

        class Response:
            def read(self_inner):  # noqa: ANN001
                return payload

            def __enter__(self_inner):  # noqa: ANN001
                return self_inner

            def __exit__(self_inner, *exc):  # noqa: ANN001
                return False

        return Response()


@pytest.fixture(autouse=True)
def _one_device():
    TOKENS.write_text(json.dumps({"tokens": [{"token": "ExponentPushToken[abc]", "label": "iPhone"}]}))
    notify.set_presence("background")
    yield
    TOKENS.unlink(missing_ok=True)


def reply(text: str = "Your 3pm moved to 4."):
    return [{"type": "text", "text": text}]


def test_a_finished_reply_notifies_when_he_is_not_in_the_app():
    expo = FakeExpo()
    out = notify.notify_reply(thread_id="thr_1", thread_title="Schedule", parts=reply(), open_fn=expo)
    assert out == {"sent": 1, "reason": "ok"}
    [message] = expo.sent[0]
    assert message["to"] == "ExponentPushToken[abc]"
    assert message["title"] == "Schedule"
    assert message["body"] == "Your 3pm moved to 4."
    # app/chat/thread.tsx takes the thread as a param — `/chat/<id>` is not a
    # route in this app and a tap on it did nothing.
    assert message["data"] == {"url": "/chat/thread?threadId=thr_1", "thread_id": "thr_1"}


def test_nothing_is_sent_while_he_is_looking_at_it():
    notify.set_presence("active")
    expo = FakeExpo()
    assert notify.notify_reply(thread_id="t", thread_title=None, parts=reply(), open_fn=expo) == {
        "sent": 0,
        "reason": "in_app",
    }
    assert expo.sent == []


def test_an_app_that_was_killed_stops_counting_as_present(monkeypatch):
    # No background event ever arrives when iOS kills the app, so an `active`
    # report has to expire or his phone goes quiet forever.
    notify.set_presence("active")
    now = notify.time.monotonic()
    monkeypatch.setattr(notify.time, "monotonic", lambda: now + notify.PRESENCE_TTL + 1)
    assert notify.presence()["in_app"] is False


@pytest.mark.parametrize(
    "parts",
    [
        [{"type": "reasoning", "text": "thinking about the calendar"}],
        [{"type": "tool_call", "tool_name": "query_email_and_calendar", "status": "running"}],
        [{"type": "tool_call", "tool_name": "x", "state": "approval_requested"}],
        [],
    ],
)
def test_thinking_and_tool_calls_never_notify(parts):
    expo = FakeExpo()
    out = notify.notify_reply(thread_id="t", thread_title=None, parts=parts, open_fn=expo)
    assert out["reason"] == "not_a_reply"
    assert expo.sent == []


def test_a_widget_only_reply_still_answered_him():
    expo = FakeExpo()
    parts = [{"type": "widget", "kind": "calendar", "props": {}}]
    out = notify.notify_reply(thread_id="t", thread_title="Schedule", parts=parts, open_fn=expo)
    assert out["sent"] == 1
    assert "calendar" in expo.sent[0][0]["body"]


def test_a_long_reply_is_clipped_to_what_ios_shows():
    expo = FakeExpo()
    notify.notify_reply(thread_id="t", thread_title=None, parts=reply("word " * 200), open_fn=expo)
    body = expo.sent[0][0]["body"]
    assert len(body) <= notify.BODY_CHARS
    assert body.endswith("…")


def test_no_registered_device_is_not_an_error():
    TOKENS.write_text(json.dumps({"tokens": []}))
    assert notify.notify_reply(thread_id="t", thread_title=None, parts=reply())["reason"] == "no_devices"


def test_expo_being_down_never_breaks_the_delivery():
    def explode(req, timeout):  # noqa: ANN001
        raise OSError("connection refused")

    out = notify.notify_reply(thread_id="t", thread_title=None, parts=reply(), open_fn=explode)
    assert out == {"sent": 0, "reason": "send_failed"}
