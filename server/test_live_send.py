"""A spoken turn goes through the same send path as a typed one (chat/routes.py's
`send_user_text` -> `_send_turn_parts`), against the real chat store: the thread is
named "Live · …", the turn asks to redirect a busy run, the spoken-reply note rides
with it, and a turn's own notes are never parked to pile up after a failed forward.
The last test drives a whole turn through the /api/live socket with Deepgram faked.

Run in its own process (run_tests.sh): the env below must be set before `app` loads.
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import sys
import tempfile

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
os.environ["HUB_CHAT_DB"] = str(TMP / "chat" / "chat.db")
os.environ["HUB_CHAT_MEDIA_DIR"] = str(TMP / "chat" / "media")
os.environ["HUB_PLATFORM_KEY_FILE"] = str(TMP / "hub-platform-key")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi import WebSocketDisconnect  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as hub_app  # noqa: E402
import chat.platform as platform  # noqa: E402
import chat.routes as routes  # noqa: E402
import live_session  # noqa: E402

client = TestClient(hub_app.app)


@pytest.fixture
def forwarded(monkeypatch):
    """Every payload the gateway would have received, answered with `status`."""
    sent: list[dict] = []
    status = {"value": ("forwarded", "")}
    monkeypatch.setattr(routes, "forward_gateway_event", lambda payload: (sent.append(payload), status["value"])[1])
    return sent, status


def thread(tid: str, title: str | None = "Live") -> str:
    platform.get_store().get_or_create_thread(tid, title=title)
    return tid


def title_of(tid: str) -> str | None:
    return platform.get_store().get_thread(tid)["title"]


def test_a_live_thread_is_named_from_the_first_real_line(forwarded):
    tid = thread("thr_name")
    routes.send_user_text(tid, "what's on my calendar tomorrow", live_voice=True)
    assert title_of(tid) == "Live · what's on my calendar tomorrow"


def test_an_untitled_thread_is_named_too(forwarded):
    tid = thread("thr_untitled", title=None)
    routes.send_user_text(tid, "remind me to call the dentist", live_voice=True)
    assert title_of(tid) == "Live · remind me to call the dentist"


def test_too_thin_an_opener_leaves_it_unnamed(forwarded):
    tid = thread("thr_thin")
    routes.send_user_text(tid, "hey", live_voice=True)
    assert title_of(tid) == "Live"


def test_a_named_live_thread_keeps_its_name(forwarded):
    tid = thread("thr_named", title="Live · weekend plans")
    routes.send_user_text(tid, "what's the weather saturday", live_voice=True)
    assert title_of(tid) == "Live · weekend plans"


def test_a_spoken_turn_asks_to_redirect_and_carries_the_voice_note(forwarded):
    sent, _ = forwarded
    tid = thread("thr_voice")
    message = routes.send_user_text(tid, "actually make it thursday", live_voice=True, notes=["a note of its own"])
    assert message["id"].startswith("msg_") and message["forward_status"] == "forwarded"
    assert sent[-1]["mode"] == "redirect"
    assert sent[-1]["text"] == "actually make it thursday"
    assert sent[-1]["client_msg_id"] is None
    assert sent[-1]["context_note"].split("\n") == [routes.VOICE_TURN_NOTE, "a note of its own"]
    msg = platform.get_store().list_messages(tid)[-1]
    assert msg["parts"] == [{"type": "text", "text": "actually make it thursday"}]
    assert msg["forward_status"] == "forwarded"


def test_with_voice_replies_off_the_read_aloud_note_is_not_sent(forwarded):
    sent, _ = forwarded
    tid = thread("thr_quiet")
    routes.send_user_text(tid, "what's the weather saturday", live_voice=True, read_aloud=False)
    assert "context_note" not in sent[-1]
    assert sent[-1]["mode"] == "redirect"


def test_a_failed_forward_is_reported_back(forwarded):
    _, status = forwarded
    status["value"] = ("pending", "gateway not configured")
    tid = thread("thr_down")
    message = routes.send_user_text(tid, "is anyone there at all", live_voice=True)
    assert message["forward_status"] == "pending"
    assert message["forward_reason"] == "gateway not configured"


def test_turn_notes_that_would_overflow_the_plugin_limit_are_left_out(forwarded):
    """The plugin refuses a message whose notes run past 2000 characters. Queued
    notes (a checklist tick) go first; a turn's own notes follow in order of
    importance while they fit, so the message is never refused over them."""
    sent, _ = forwarded
    store = platform.get_store()
    tid = thread("thr_full")
    store.note_for_agent(tid, "q" * 1200)
    routes.send_user_text(tid, "and one more thing please", live_voice=True,
                          notes=["c" * 200, "a" * 500])
    notes = sent[-1]["context_note"].split("\n")
    assert notes == ["q" * 1200, routes.VOICE_TURN_NOTE, "c" * 200]
    assert len(sent[-1]["context_note"]) <= routes.MAX_CONTEXT_NOTE_LEN


def test_a_typed_send_through_the_same_helper_carries_neither(forwarded):
    sent, _ = forwarded
    tid = thread("thr_typed", title=None)
    assert routes.send_user_text(tid, "what's on my calendar tomorrow")["forward_status"] == "forwarded"
    assert "mode" not in sent[-1] and "context_note" not in sent[-1]
    assert title_of(tid) == "what's on my calendar tomorrow"


def test_turn_notes_are_never_parked_but_queued_notes_are_kept(forwarded):
    """A failed forward puts back what it drained from the store (a checklist tick
    still reaches the agent later) but not the turn's own notes: re-parking those
    stacked one more voice note per failed attempt until the plugin's 2000-character
    limit refused every later message in the thread."""
    sent, status = forwarded
    store = platform.get_store()
    tid = thread("thr_retry")
    store.note_for_agent(tid, "the user ticked a box")
    status["value"] = ("pending", "gateway unreachable")
    for i in range(5):
        routes.send_user_text(tid, f"turn number {i} while the gateway is down", live_voice=True)
    status["value"] = ("forwarded", "")
    routes.send_user_text(tid, "and now it is back", live_voice=True)
    notes = sent[-1]["context_note"].split("\n")
    assert notes == ["the user ticked a box", routes.VOICE_TURN_NOTE]
    assert store.drain_agent_notes(tid) == []


def test_an_unknown_thread_is_none_and_never_created(forwarded):
    sent, _ = forwarded
    assert routes.send_user_text("thr_missing", "hello there friend", live_voice=True) is None
    assert platform.get_store().get_thread("thr_missing") is None
    assert sent == []


class FakeListen:
    def __init__(self, transcript: str):
        self.transcript = transcript

    async def connect(self, sample_rate=16000):
        pass

    async def send(self, pcm):
        pass

    async def events(self):
        yield {"event": "StartOfTurn", "transcript": "", "turn_index": 0}
        yield {"event": "EndOfTurn", "transcript": self.transcript, "turn_index": 0}
        await asyncio.Event().wait()

    async def close(self):
        pass


def test_a_spoken_turn_lands_in_the_thread_through_the_socket(forwarded, monkeypatch):
    sent, _ = forwarded
    tid = thread("thr_socket")
    monkeypatch.setattr(live_session, "chat_session_valid", lambda token: True)
    monkeypatch.setattr(live_session, "listen_factory", lambda: FakeListen("is the garden hose still on"))
    monkeypatch.setattr(live_session, "HOLD_S", 0.0)
    hello = {"type": "hello", "thread_id": tid, "aec": False,
             "tts": {"voice": "flux-kit-en", "speed": 1.0, "expressivity": 0, "enabled": False}}
    with client.websocket_connect("/api/live") as ws:
        ws.send_json(hello)
        frames = []
        while not any(f.get("type") == "turn" for f in frames):
            frames.append(ws.receive_json())
        ws.send_json({"type": "stop"})
        # Read to the server's close, so the endpoint has finished before the test
        # client tears the session down.
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                ws.receive_json()
        assert closed.value.code == 1000
    assert {"type": "heard", "text": "is the garden hose still on", "final": True} in frames
    msg = platform.get_store().list_messages(tid)[-1]
    assert msg["role"] == "user" and msg["parts"] == [{"type": "text", "text": "is the garden hose still on"}]
    # Voice replies are off in this hello, so the agent is not told it is being read aloud.
    assert sent[-1]["mode"] == "redirect" and "context_note" not in sent[-1]
    assert title_of(tid) == "Live · is the garden hose still on"
