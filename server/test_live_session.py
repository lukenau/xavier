"""LiveSession: Flux turn-taking, streamed TTS, echo window, barge-in, stop,
acknowledgements and the notes that ride with a spoken turn.

Driven directly (no HTTP) against fake Flux streams and a fake chat store,
except the auth tests, which go through the real route. The Origin check
through the whole app is test_live_origin.py."""
import asyncio
import json
import logging

import pytest

import live_session as ls


def run(coro):
    return asyncio.run(coro)


async def settle(n=40):
    for _ in range(n):
        await asyncio.sleep(0)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FakeListen:
    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()
        self.sent: list[bytes] = []
        self.closed = False

    async def connect(self, sample_rate=16000):
        self.sample_rate = sample_rate

    async def send(self, pcm):
        self.sent.append(pcm)

    async def events(self):
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev

    async def close(self):
        self.closed = True

    def push(self, event, transcript="", turn_index=0):
        self.q.put_nowait({"event": event, "transcript": transcript, "turn_index": turn_index})


class FakeSpeak:
    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()
        self.calls: list = []
        self.active = False
        self.cut = {"text_spoken": "Five things", "text_remaining": " tomorrow."}
        # Seconds before SpeechInterrupted arrives; Deepgram's is a network round trip.
        self.cut_delay = 0.0

    async def connect(self, voice, speed, expressivity):
        self.calls.append(("connect", voice))
        self.connected_with = (voice, speed, expressivity)

    async def speak(self, text):
        self.calls.append(("speak", text))
        if not self.active:
            self.active = True
            self.q.put_nowait(("started", "dg_sp_x"))
        self.q.put_nowait(("audio", b"\x01\x00" * 4))

    async def flush(self):
        self.calls.append(("flush",))
        if self.active:
            self.active = False
            self.q.put_nowait(("done", {"audio_duration_ms": 1000}))

    async def interrupt(self, played_ms):
        self.calls.append(("interrupt", played_ms))
        if self.active:
            self.active = False
            cut = dict(self.cut)
            if self.cut_delay:
                loop = asyncio.get_running_loop()
                loop.call_later(self.cut_delay, self.q.put_nowait, ("interrupted", cut))
            else:
                self.q.put_nowait(("interrupted", cut))

    async def keepalive(self):
        self.calls.append(("ping",))

    async def events(self):
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev

    async def close(self):
        pass


class FakeStore:
    def __init__(self):
        self.events: list[dict] = []
        self.gone = False

    def add(self, type_, payload):
        self.events.append({"seq": len(self.events) + 1, "type": type_, "payload": payload})

    def get_thread(self, tid):
        return None if self.gone else {"last_seq": len(self.events)}

    def scan_events_after(self, tid, after, limit=500):
        evs = [e for e in self.events if e["seq"] > after][:limit]
        return evs, (evs[-1]["seq"] if evs else after)

    def note_for_agent(self, tid, note):
        raise AssertionError("Live's notes ride with the turn; nothing is parked in the store")

    def reply(self, mid, text):
        self.add("run.status", {"status": "running"})
        self.add("message.upsert", {"message_id": mid, "role": "assistant", "author_type": "agent",
                                    "parts": [{"type": "text", "text": text}]})
        self.add("run.status", {"status": "idle"})


@pytest.fixture
def env(monkeypatch):
    clock = Clock()
    store = FakeStore()
    listen, speak = FakeListen(), FakeSpeak()
    sent_messages: list[tuple[str, str]] = []
    notes_sent: list[list[str]] = []
    read_aloud: list[bool] = []
    forward = {"status": "forwarded", "reason": ""}
    stops: list[str] = []
    out: list = []

    async def send_message(tid, text, notes, aloud):
        sent_messages.append((tid, text))
        notes_sent.append(list(notes))
        read_aloud.append(aloud)
        mid = f"u{len(sent_messages)}"
        store.add("message.upsert", {"message_id": mid, "role": "user",
                                     "author_type": "human", "parts": [{"type": "text", "text": text}]})
        return {"id": mid, "forward_status": forward["status"], "forward_reason": forward["reason"]}

    async def stop_run(tid):
        stops.append(tid)

    async def emit(item):
        out.append(item)

    monkeypatch.setattr(ls, "listen_factory", lambda: listen)
    monkeypatch.setattr(ls, "speak_factory", lambda: speak)
    monkeypatch.setattr(ls, "get_store", lambda: store)
    monkeypatch.setattr(ls, "send_message", send_message)
    monkeypatch.setattr(ls, "stop_run", stop_run)
    # Acknowledgements are off unless a test is about them: a reply's speech
    # waits for the phone to finish playing the ack, which these fakes only
    # report when a test sends `drained`.
    monkeypatch.setattr(ls, "ACKS", ())
    monkeypatch.setattr(ls, "POLL_S", 0.001)
    monkeypatch.setattr(ls, "HOLD_S", 0.0)
    monkeypatch.setattr(ls, "TICK_S", 0.001)

    class E:
        pass

    e = E()
    e.clock, e.store, e.listen, e.speak = clock, store, listen, speak
    e.sent_messages, e.notes_sent, e.stops, e.out = sent_messages, notes_sent, stops, out
    e.read_aloud, e.forward = read_aloud, forward
    e.make = lambda: ls.LiveSession(emit, now=clock)
    e.frames = lambda: [json.loads(x) for x in out if isinstance(x, str)]
    e.types = lambda: [f["type"] for f in e.frames()]
    e.states = lambda: [f["value"] for f in e.frames() if f["type"] == "state"]
    e.audio = lambda: [x for x in out if isinstance(x, bytes)]
    e.spoken = lambda: [c[1] for c in speak.calls if c[0] == "speak"]
    return e


ACKS = ("Okay.", "Mm-hm.", "Got it.", "Alright.", "Sure.")


def hello(aec=False, **tts):
    return {"type": "hello", "thread_id": "thr_1", "aec": aec,
            "tts": {"voice": "flux-kit-en", "speed": 1.0, "expressivity": 0, "enabled": True, **tts}}


async def started(env, aec=False, **tts):
    s = env.make()
    await s.start()
    await s.on_text(hello(aec, **tts))
    await settle()
    return s


async def wait_for(pred, n=400):
    for _ in range(n):
        if pred():
            return True
        await asyncio.sleep(0.001)
    return False


def test_hello_connects_and_listens(env):
    async def go():
        s = await started(env)
        await s.close()

    run(go())
    assert env.types()[:1] == ["ready"] and env.states()[-1] == "listening"
    assert ("connect", "flux-kit-en") in env.speak.calls


def test_hello_without_a_voice_uses_the_default(env):
    async def go():
        s = env.make()
        await s.start()
        await s.on_text({"type": "hello", "thread_id": "thr_1", "aec": False, "tts": {"enabled": True}})
        await settle()
        await s.close()

    run(go())
    assert ("connect", ls.DEFAULT_VOICE) in env.speak.calls
    assert ls.DEFAULT_VOICE == "flux-hannah-en"


def test_audio_always_forwarded_even_while_speaking(env):
    async def go():
        s = await started(env)
        s._speaking = True
        await s.on_audio(b"\x00" * 2560)
        await s.close()

    run(go())
    assert env.listen.sent == [b"\x00" * 2560]


def test_end_of_turn_commits_once_and_update_does_not(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "hey")
        env.listen.push("Update", "hey there")
        env.listen.push("EndOfTurn", "hey there")
        assert await wait_for(lambda: "turn" in env.types())
        await s.close()

    run(go())
    assert env.sent_messages == [("thr_1", "hey there")]
    heard = [f for f in env.frames() if f["type"] == "heard"]
    assert heard[-1] == {"type": "heard", "text": "hey there", "final": True}
    assert any(not f["final"] for f in heard)
    assert "turn" in env.types() and env.states()[-1] == "thinking"


def test_reply_text_streams_into_one_tts_turn(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "cal")
        env.listen.push("EndOfTurn", "calendar")
        assert await wait_for(lambda: "turn" in env.types())
        env.store.add("message.upsert", {"message_id": "a1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "Five"}]})
        env.store.add("part.delta", {"message_id": "a1", "idx": 0, "delta": " things."})
        env.store.add("run.status", {"status": "idle"})
        assert await wait_for(lambda: "speak_end" in env.types())
        await s.close()

    run(go())
    speaks = [c for c in env.speak.calls if c[0] in ("speak", "flush")]
    assert speaks == [("speak", "Five"), ("speak", " things."), ("flush",)]
    t = env.types()
    assert t.index("speak_start") < t.index("speak_end")
    assert len(env.audio()) == 2
    caps = [f["text"] for f in env.frames() if f["type"] == "caption"]
    assert "".join(caps) == "Five things."


def test_reasoning_never_reaches_tts(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "hi")
        env.listen.push("EndOfTurn", "hi")
        assert await wait_for(lambda: "turn" in env.types())
        env.store.add("message.upsert", {"message_id": "r", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "reasoning", "text": "The user"}]})
        env.store.add("part.delta", {"message_id": "r", "idx": 0, "delta": " said hi"})
        env.store.reply("a", "Hey.")
        assert await wait_for(lambda: "speak_end" in env.types())
        await s.close()

    run(go())
    assert env.spoken() == ["Hey."]


def test_echo_window_discards_turn_started_during_playback(env):
    async def go():
        s = await started(env, aec=False)
        s._speaking = True
        env.listen.push("StartOfTurn", "five things", 3)
        await settle()
        s._speaking = False
        s._last_drained = env.clock()
        env.clock.t += 2
        env.listen.push("EndOfTurn", "five things tomorrow", 3)
        assert await wait_for(lambda: env.listen.q.empty())
        await settle()
        env.clock.t += 1.0
        env.listen.push("StartOfTurn", "sentinel", 9)
        env.listen.push("EndOfTurn", "sentinel", 9)
        assert await wait_for(lambda: env.sent_messages)
        await s.close()

    run(go())
    assert env.sent_messages == [("thr_1", "sentinel")]


def test_echo_window_discards_turn_within_600ms_of_drain(env):
    async def go():
        s = await started(env, aec=False)
        s._last_drained = env.clock()
        env.clock.t += 0.3
        env.listen.push("StartOfTurn", "standup", 4)
        env.listen.push("EndOfTurn", "standup at ten", 4)
        assert await wait_for(lambda: env.listen.q.empty())
        await settle()
        env.clock.t += 1.0
        env.listen.push("StartOfTurn", "sentinel", 9)
        env.listen.push("EndOfTurn", "sentinel", 9)
        assert await wait_for(lambda: env.sent_messages)
        await s.close()

    run(go())
    assert env.sent_messages == [("thr_1", "sentinel")]


def test_turn_after_window_is_committed(env):
    async def go():
        s = await started(env, aec=False)
        s._last_drained = env.clock()
        env.clock.t += 0.9
        env.listen.push("StartOfTurn", "what", 5)
        env.listen.push("EndOfTurn", "what about wednesday", 5)
        assert await wait_for(lambda: env.sent_messages)
        await s.close()

    run(go())
    assert env.sent_messages == [("thr_1", "what about wednesday")]


async def speaking_reply(env, aec):
    s = await started(env, aec=aec)
    env.listen.push("StartOfTurn", "cal", 0)
    env.listen.push("EndOfTurn", "calendar", 0)
    assert await wait_for(lambda: "turn" in env.types())
    env.store.add("run.status", {"status": "running"})
    env.store.add("message.upsert", {"message_id": "a1", "role": "assistant", "author_type": "agent",
                                     "parts": [{"type": "text", "text": "Five things tomorrow."}]})
    assert await wait_for(lambda: "speak_start" in env.types())
    return s


def test_aec_on_backchannel_ducks_but_does_not_cut(env):
    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "mhm", 1)
        env.listen.push("Update", "mhm", 1)
        await settle()
        env.clock.t += ls.UNDUCK_AFTER_S + 0.1
        assert await wait_for(lambda: "unduck" in env.types())
        await s.close()

    run(go())
    assert "duck" in env.types() and "cancel" not in env.types()
    assert not any(c[0] == "interrupt" for c in env.speak.calls)


def test_aec_on_real_words_barge_in_and_the_next_turn_says_where(env):
    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "wait", 1)
        env.listen.push("Update", "wait actually", 1)
        assert await wait_for(lambda: s._cut_note is not None)
        env.listen.push("EndOfTurn", "wait actually make it thursday", 1)
        assert await wait_for(lambda: len(env.sent_messages) == 2)
        await s.close()

    run(go())
    assert ("interrupt", 0) in env.speak.calls
    cancel = [f for f in env.frames() if f["type"] == "cancel"]
    assert cancel and cancel[0]["turn_id"] == 1
    cut = [n for n in env.notes_sent[1] if "cut you off" in n]
    assert len(cut) == 1 and "«Five things»" in cut[0] and "«tomorrow.»" in cut[0]
    assert not any("cut you off" in n for n in env.notes_sent[0])


def test_a_cut_note_is_bounded_and_sent_once(env):
    env.speak.cut = {"text_spoken": "spoken " * 400 + "LAST", "text_remaining": "FIRST " + "rest " * 400}

    async def go():
        s = await speaking_reply(env, aec=False)
        await s.on_text({"type": "interrupt"})
        assert await wait_for(lambda: s._cut_note is not None)
        for i in (1, 2):
            env.clock.t += 5
            env.listen.push("StartOfTurn", "q", i)
            env.listen.push("EndOfTurn", f"next question {i}", i)
            assert await wait_for(lambda: len(env.sent_messages) == i + 1)
        await s.close()

    run(go())
    cut = [n for n in env.notes_sent[1] if "cut you off" in n]
    assert len(cut) == 1 and "LAST»" in cut[0] and "«FIRST" in cut[0]
    assert len(cut[0]) < len(ls.CUT_NOTE) + 2 * ls.CUT_QUOTE_CHARS + 10
    assert env.notes_sent[2] == []


def test_aec_off_start_of_turn_while_speaking_does_not_cut(env):
    async def go():
        s = await speaking_reply(env, aec=False)
        env.listen.push("StartOfTurn", "five things", 1)
        env.listen.push("Update", "five things tomorrow", 1)
        await settle()
        await s.close()

    run(go())
    assert "cancel" not in env.types() and "duck" not in env.types()


def test_tap_interrupt_cancels_tts_and_stops_run(env):
    async def go():
        s = await speaking_reply(env, aec=False)
        await s.on_text({"type": "playback", "turn_id": 1, "played_ms": 420})
        await s.on_text({"type": "interrupt"})
        await settle()
        await s.close()

    run(go())
    assert ("interrupt", 420) in env.speak.calls
    assert env.stops == ["thr_1"]
    assert env.states()[-1] == "listening"


def test_audio_after_cancel_is_not_relayed(env):
    async def go():
        s = await speaking_reply(env, aec=False)
        assert await wait_for(lambda: len(env.audio()) == 1)
        before = len(env.audio())
        await s.on_text({"type": "interrupt"})
        env.speak.q.put_nowait(("audio", b"\x09\x09"))
        await settle()
        await s.close()
        return before

    before = run(go())
    assert len(env.audio()) == before


def test_drained_returns_to_listening(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "hi")
        env.listen.push("EndOfTurn", "hi")
        assert await wait_for(lambda: "turn" in env.types())
        env.store.reply("a", "Hey.")
        assert await wait_for(lambda: "speak_end" in env.types())
        env.clock.t += ls.IDLE_GRACE_S + 0.1
        assert await wait_for(lambda: s._reader is None)
        assert s.state == "speaking"
        await s.on_text({"type": "drained", "turn_id": 1})
        await settle()
        await s.close()

    run(go())
    assert env.states()[-1] == "listening"


def test_steered_reply_after_idle_is_still_spoken(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "cal")
        env.listen.push("EndOfTurn", "calendar")
        assert await wait_for(lambda: "turn" in env.types())
        env.store.add("run.status", {"status": "running"})
        env.store.add("run.status", {"status": "idle"})
        await settle(100)
        env.store.reply("a", "Five things.")
        assert await wait_for(lambda: ("speak", "Five things.") in env.speak.calls)
        await s.close()

    run(go())


def test_idle_session_ends(env):
    async def go():
        s = await started(env)
        env.clock.t += ls.IDLE_END_S + 1
        assert await wait_for(lambda: "ended" in env.types())
        await s.close()

    run(go())
    assert [f for f in env.frames() if f["type"] == "ended"][0]["reason"] == "idle"


def test_deepgram_down_reports_reconnecting_then_recovers(env, monkeypatch):
    attempts = {"n": 0}
    good = env.listen

    class Flaky(FakeListen):
        async def connect(self, sample_rate=16000):
            attempts["n"] += 1
            raise ls.DeepgramUnavailable("down")

    monkeypatch.setattr(ls, "listen_factory", lambda: Flaky() if attempts["n"] < 1 else good)
    monkeypatch.setattr(ls, "BACKOFF_S", (0.001, 0.001))

    async def go():
        s = await started(env)
        assert await wait_for(lambda: "ready" in env.types())
        await s.close()

    run(go())
    assert "reconnecting" in env.states() and env.states()[-1] == "listening"


def test_no_deepgram_key_ends_at_once_and_says_why(env, monkeypatch):
    class Unconfigured(FakeListen):
        async def connect(self, sample_rate=16000):
            raise ls.DeepgramNotConfigured("DEEPGRAM_API_KEY not set")

    monkeypatch.setattr(ls, "listen_factory", lambda: Unconfigured())

    async def go():
        s = await started(env)
        assert s.finished.is_set()
        await s.close()

    run(go())
    frames = env.frames()
    assert [f["type"] for f in frames] == ["error", "ended"]
    assert "DEEPGRAM_API_KEY" in frames[0]["message"]
    assert frames[1] == {"type": "ended", "reason": "unconfigured"}
    assert "reconnecting" not in env.states() and "ready" not in env.types()


def test_ping_pong(env):
    async def go():
        s = await started(env)
        await s.on_text({"type": "ping"})
        await settle()
        await s.close()

    run(go())
    assert "pong" in env.types()


def test_resume_seq_rereads_reply(env):
    async def go():
        env.store.reply("a", "Five things.")
        s = env.make()
        await s.start()
        await s.on_text({**hello(), "resume_seq": 0})
        assert await wait_for(lambda: any(c == ("speak", "Five things.") for c in env.speak.calls))
        await s.close()

    run(go())


def test_auth_rejected_closes_1008(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.setattr(ls, "origin_ok", lambda headers: True)
    app = FastAPI()
    app.include_router(ls.router)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/api/live") as ws:
                ws.receive_text()
    assert exc.value.code == 1008


def test_an_unwired_origin_check_refuses_even_a_valid_session(monkeypatch):
    """origin_ok is wired by app.py. Without it the socket fails closed rather than
    trusting the cookie alone, with the Origin code, not the one that locks chat."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.setattr(ls, "chat_session_valid", lambda token: True)
    monkeypatch.setattr(ls, "origin_ok", None)
    app = FastAPI()
    app.include_router(ls.router)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/api/live") as ws:
                ws.receive_text()
    assert exc.value.code == ls.ORIGIN_REFUSED != 1008


def test_reconnect_exhaustion_ends_the_session(env, monkeypatch):
    class Down(FakeListen):
        async def connect(self, sample_rate=16000):
            raise ls.DeepgramUnavailable("down")

    monkeypatch.setattr(ls, "listen_factory", lambda: Down())
    monkeypatch.setattr(ls, "BACKOFF_S", (0.001, 0.001))

    async def go():
        s = await started(env)
        assert await wait_for(lambda: "ended" in env.types())
        assert s.finished.is_set()
        await s.close()

    run(go())
    ended = [f for f in env.frames() if f["type"] == "ended"]
    assert ended[0]["reason"] == "unavailable"


def test_recovery_mid_speech_then_next_reply_still_ends(env, monkeypatch):
    monkeypatch.setattr(ls, "BACKOFF_S", (0.001,))

    async def go():
        s = await speaking_reply(env, aec=False)
        env.speak.active = False
        s._spawn_recover("test break")
        assert await wait_for(lambda: env.states()[-1] in ("listening", "thinking"))
        assert not s._tts_turns
        env.store.add("message.upsert", {"message_id": "a2", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "Back again."}]})
        env.store.add("run.status", {"status": "idle"})
        assert await wait_for(lambda: [f for f in env.frames() if f["type"] == "speak_end"])
        await s.close()

    run(go())


def test_tool_call_closes_the_open_speech_turn(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "cal")
        env.listen.push("EndOfTurn", "calendar")
        assert await wait_for(lambda: "turn" in env.types())
        env.store.add("message.upsert", {"message_id": "a1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "Checking your calendar."}]})
        env.store.add("message.upsert", {"message_id": "a2", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "tool_call", "name": "calendar"}]})
        assert await wait_for(lambda: ("flush",) in env.speak.calls)
        await s.close()

    run(go())


def test_next_reply_waits_for_the_previous_to_finish_playing(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "cal")
        env.listen.push("EndOfTurn", "calendar")
        assert await wait_for(lambda: "turn" in env.types())
        env.store.add("run.status", {"status": "running"})
        env.store.add("message.upsert", {"message_id": "a1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "One."}]})
        env.store.add("message.upsert", {"message_id": "a2", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "tool_call", "name": "x"}]})
        assert await wait_for(lambda: "speak_end" in env.types())
        env.store.add("message.upsert", {"message_id": "a3", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "Two."}]})
        await settle(200)
        starts = [f["turn_id"] for f in env.frames() if f["type"] == "speak_start"]
        assert starts == [1]
        await s.on_text({"type": "drained", "turn_id": 1})
        assert await wait_for(lambda: [f for f in env.frames() if f["type"] == "speak_start" and f["turn_id"] == 2])
        await s.close()

    run(go())


def test_hold_cuts_speech_but_keeps_the_run(env):
    async def go():
        s = await speaking_reply(env, aec=False)
        await s.on_text({"type": "hold"})
        await settle()
        assert s._reader is not None
        await s.close()

    run(go())
    assert env.stops == []
    assert "cancel" in env.types()


def test_hello_mic_rate_reaches_flux(env):
    async def go():
        s = env.make()
        await s.start()
        await s.on_text({**hello(), "mic_rate": 24000})
        await settle()
        await s.close()

    run(go())
    assert env.listen.sample_rate == 24000


def test_mic_rate_defaults_to_16k(env):
    async def go():
        s = await started(env)
        await s.close()

    run(go())
    assert env.listen.sample_rate == 16000


def test_redirect_idle_before_the_new_answer_does_not_end_the_turn(env):
    # A second question cut into a running lookup: the interrupted run went idle
    # at once, the redirected run only restarted many seconds later, and its
    # reply must still be spoken.
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "cal")
        env.listen.push("EndOfTurn", "check my calendar")
        assert await wait_for(lambda: len(env.sent_messages) == 1)
        env.store.add("run.status", {"status": "running"})
        env.store.add("message.upsert", {"message_id": "t1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "tool_call", "name": "calendar"}]})
        await asyncio.sleep(0.05)
        env.listen.push("StartOfTurn", "any")
        env.listen.push("EndOfTurn", "anything this weekend")
        assert await wait_for(lambda: len(env.sent_messages) == 2)
        env.store.add("run.status", {"status": "idle"})
        env.store.add("message.upsert", {"message_id": "n1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "↪ Redirected current run. I'll adjust."}]})
        await asyncio.sleep(0.05)
        env.clock.t += 13
        await asyncio.sleep(0.05)
        env.store.reply("a", "Your weekend is clear.")
        assert await wait_for(lambda: ("speak", "Your weekend is clear.") in env.speak.calls)
        await s.close()

    run(go())


def test_an_unanswered_idle_still_ends_the_turn_eventually(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "cal")
        env.listen.push("EndOfTurn", "check my calendar")
        assert await wait_for(lambda: len(env.sent_messages) == 1)
        env.store.add("run.status", {"status": "running"})
        env.store.add("run.status", {"status": "idle"})
        await asyncio.sleep(0.05)
        assert env.states()[-1] == "thinking"
        env.clock.t += ls.UNANSWERED_IDLE_S + 1
        assert await wait_for(lambda: env.states()[-1] == "listening")
        await s.close()

    run(go())


def test_a_missing_drained_never_swallows_the_next_reply(env):
    # "Checking your email." played, the phone's drained for it never arrived,
    # and the real answer must not wait behind it forever: the wait is bounded
    # by the audio actually sent.
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "did")
        env.listen.push("EndOfTurn", "did my package ship")
        assert await wait_for(lambda: len(env.sent_messages) == 1)
        env.store.add("run.status", {"status": "running"})
        env.store.add("message.upsert", {"message_id": "c1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "Checking your email."}]})
        env.store.add("message.upsert", {"message_id": "t1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "tool_call", "name": "mail"}]})
        assert await wait_for(lambda: "speak_end" in env.types())
        env.store.reply("a", "Yes, it shipped.")
        await asyncio.sleep(0.05)
        said = lambda: any(c[0] == "speak" and c[1].strip() == "Yes, it shipped." for c in env.speak.calls)
        assert not said()
        env.clock.t += 1.0 + ls.DRAIN_SLACK_S + 0.1
        assert await wait_for(said)
        await s.close()

    run(go())


def test_a_pause_longer_than_the_hold_is_a_new_turn(env, monkeypatch):
    monkeypatch.setattr(ls, "HOLD_S", 0.05)

    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "one")
        env.listen.push("EndOfTurn", "first question")
        assert await wait_for(lambda: len(env.sent_messages) == 1)
        env.listen.push("StartOfTurn", "two")
        env.listen.push("EndOfTurn", "second question")
        assert await wait_for(lambda: len(env.sent_messages) == 2)
        await s.close()

    run(go())
    assert [t for _, t in env.sent_messages] == ["first question", "second question"]


# ── acknowledgements ───────────────────────────────────────────────────────

def test_an_acknowledgement_is_spoken_and_the_agent_is_told(env, monkeypatch):
    monkeypatch.setattr(ls, "ACKS", ACKS)

    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "what")
        env.listen.push("EndOfTurn", "what's on my calendar tomorrow")
        assert await wait_for(lambda: env.sent_messages)
        assert await wait_for(lambda: ("flush",) in env.speak.calls)
        await s.close()

    run(go())
    spoken = env.spoken()
    assert len(spoken) == 1 and spoken[0] in ACKS
    told = [n for n in env.notes_sent[0] if "acknowledgement" in n]
    assert len(told) == 1 and f'"{spoken[0]}"' in told[0]
    # The ack is its own short speech turn, closed before the reply's.
    assert env.speak.calls.index(("flush",)) == env.speak.calls.index(("speak", spoken[0])) + 1


def test_one_acknowledgement_per_turn_and_no_filler_while_waiting(env, monkeypatch):
    """A slow reply gets the client's working tone, never a second canned line;
    Hermes narrates its own tool calls."""
    monkeypatch.setattr(ls, "ACKS", ACKS)

    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "hey")
        env.listen.push("EndOfTurn", "hey how are you")
        assert await wait_for(lambda: "turn" in env.types())
        await s.on_text({"type": "drained", "turn_id": s._turn_id})
        env.clock.t += 5
        await settle(200)
        assert len(env.spoken()) == 1
        env.store.reply("a", "Good, you?")
        assert await wait_for(lambda: ("speak", "Good, you?") in env.speak.calls)
        await s.close()

    run(go())
    assert env.spoken()[0] in ACKS and env.spoken()[1:] == ["Good, you?"]


def test_back_to_back_turns_get_different_acks(env, monkeypatch):
    monkeypatch.setattr(ls, "ACKS", ACKS)

    async def go():
        s = await started(env)
        for i in range(2):
            env.listen.push("StartOfTurn", "cal", i)
            env.listen.push("EndOfTurn", f"calendar question {i}", i)
            assert await wait_for(lambda: len(env.spoken()) == i + 1)
            await s.on_text({"type": "drained", "turn_id": s._turn_id})
            env.clock.t += ls.ECHO_TAIL_S + 0.5
        await s.close()

    run(go())
    spoken = env.spoken()
    assert spoken[0] != spoken[1]


def test_no_acknowledgement_and_no_note_when_voice_replies_are_off(env, monkeypatch):
    monkeypatch.setattr(ls, "ACKS", ACKS)

    async def go():
        s = await started(env, enabled=False)
        env.listen.push("StartOfTurn", "hi")
        env.listen.push("EndOfTurn", "hi there")
        assert await wait_for(lambda: env.sent_messages)
        await s.close()

    run(go())
    assert not any(c[0] == "connect" for c in env.speak.calls)
    assert env.notes_sent == [[]]
    assert env.read_aloud == [False]


def test_a_continuation_inside_the_hold_merges_into_one_turn_with_one_ack(env, monkeypatch):
    # "Hey. How are you?" then, 0.7 s later, "Can you hear me too?" is one turn:
    # one message, one acknowledgement, and nothing said over the pause.
    monkeypatch.setattr(ls, "HOLD_S", 0.2)
    monkeypatch.setattr(ls, "ACKS", ACKS)

    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "hey")
        env.listen.push("EndOfTurn", "Hey. How are you?")
        await asyncio.sleep(0.05)
        assert env.sent_messages == []
        assert not env.spoken()
        env.listen.push("StartOfTurn", "can")
        env.listen.push("EndOfTurn", "Can you hear me too?")
        assert await wait_for(lambda: len(env.sent_messages) == 1, n=1000)
        await asyncio.sleep(0.3)
        await s.close()

    run(go())
    assert env.sent_messages == [("thr_1", "Hey. How are you? Can you hear me too?")]
    assert len(env.spoken()) == 1
    finals = [f["text"] for f in env.frames() if f["type"] == "heard" and f["final"]]
    assert finals[-1] == "Hey. How are you? Can you hear me too?"


# ── privacy ────────────────────────────────────────────────────────────────

def test_what_the_user_says_never_reaches_the_server_log(env):
    lines: list[str] = []

    class Grab(logging.Handler):
        def emit(self, record):
            lines.append(record.getMessage())

    grab = Grab()
    ls.log.addHandler(grab)
    try:
        async def go():
            s = await started(env, aec=False)
            s._speaking = True
            env.listen.push("StartOfTurn", "echoed private words", 1)
            await settle()
            s._speaking = False
            env.listen.push("EndOfTurn", "echoed private words", 1)
            env.clock.t += 2
            env.listen.push("StartOfTurn", "my private question", 2)
            env.listen.push("EndOfTurn", "my private question", 2)
            assert await wait_for(lambda: env.sent_messages)
            await s.close()

        run(go())
    finally:
        ls.log.removeHandler(grab)
    assert any("turn committed" in line for line in lines)
    assert any("echo" in line for line in lines)
    assert not any("private" in line for line in lines)


# ── barge-in, holds and failures ───────────────────────────────────────────

def test_a_barge_in_releases_the_duck(env):
    """A cut that left the phone ducked would play every later reply at a fifth of
    the volume."""
    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "wait", 1)
        env.listen.push("Update", "wait actually", 1)
        assert await wait_for(lambda: "cancel" in env.types())
        await settle()
        await s.close()

    run(go())
    t = env.types()
    assert t.count("duck") == t.count("unduck") == 1
    assert t.index("duck") < t.index("unduck")


def test_a_backchannel_over_the_reply_is_not_a_turn(env):
    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "mhm", 1)
        env.listen.push("EndOfTurn", "Mhm.", 1)
        assert await wait_for(lambda: "unduck" in env.types())
        await settle(50)
        await s.close()

    run(go())
    assert env.sent_messages == [("thr_1", "calendar")]
    assert "cancel" not in env.types()
    assert not any(c[0] == "interrupt" for c in env.speak.calls)
    assert [f for f in env.frames() if f["type"] == "heard"][-1] == {"type": "heard", "text": "", "final": True}


def test_one_real_word_over_the_reply_is_a_turn_and_cuts_it(env):
    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "no", 1)
        env.listen.push("EndOfTurn", "No.", 1)
        assert await wait_for(lambda: len(env.sent_messages) == 2)
        await s.close()

    run(go())
    assert env.sent_messages[-1] == ("thr_1", "No.")
    assert "cancel" in env.types()


def test_after_a_cut_the_rest_of_that_reply_stays_unsaid(env):
    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "wait", 1)
        env.listen.push("Update", "wait actually", 1)
        assert await wait_for(lambda: "cancel" in env.types())
        # The cut reply's run keeps streaming while the user talks...
        env.store.add("part.delta", {"message_id": "a1", "idx": 0, "delta": " Then lunch."})
        env.store.add("message.upsert", {"message_id": "a2", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": "Also, rain later."}]})
        await settle(100)
        assert [f["turn_id"] for f in env.frames() if f["type"] == "speak_start"] == [1]
        # ...and once the user's message is in the thread, only its answer is spoken.
        env.listen.push("EndOfTurn", "wait actually make it thursday", 1)
        assert await wait_for(lambda: len(env.sent_messages) == 2)
        env.store.add("part.delta", {"message_id": "a2", "idx": 0, "delta": " Bring a coat."})
        env.store.reply("a3", "Thursday it is.")
        assert await wait_for(lambda: "Thursday it is." in [t.strip() for t in env.spoken()])
        await s.close()

    run(go())
    said = " ".join(env.spoken())
    assert not any(stale in said for stale in ("Then lunch", "rain later", "Bring a coat"))


def test_text_still_streaming_from_before_a_new_question_does_not_answer_it(env):
    """The interrupted run's last words land after the new question and the run
    goes idle; the redirected run answers many seconds later, and that answer must
    still be spoken."""
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "cal")
        env.listen.push("EndOfTurn", "check my calendar")
        assert await wait_for(lambda: len(env.sent_messages) == 1)
        env.store.add("run.status", {"status": "running"})
        env.store.add("message.upsert", {"message_id": "a1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "tool_call", "name": "calendar"}]})
        await asyncio.sleep(0.05)
        env.listen.push("StartOfTurn", "any")
        env.listen.push("EndOfTurn", "anything this weekend")
        assert await wait_for(lambda: len(env.sent_messages) == 2)
        env.store.add("message.upsert", {"message_id": "a1", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "tool_call", "name": "calendar"},
                                                   {"type": "text", "text": "You have standup."}]})
        env.store.add("run.status", {"status": "idle"})
        await asyncio.sleep(0.05)
        env.clock.t += 13
        await asyncio.sleep(0.05)
        env.store.reply("a2", "Your weekend is clear.")
        assert await wait_for(lambda: ("speak", "Your weekend is clear.") in env.speak.calls)
        await s.close()

    run(go())
    assert ("speak", "You have standup.") not in env.speak.calls


def test_a_turn_that_cuts_a_reply_carries_how_much_of_it_was_heard(env):
    env.speak.cut_delay = 0.1  # Deepgram answers the Interrupt a round trip later

    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "no", 1)
        env.listen.push("EndOfTurn", "No.", 1)
        assert await wait_for(lambda: len(env.sent_messages) == 2, n=1000)
        await s.close()

    run(go())
    assert any("cut you off" in n and "«Five things»" in n for n in env.notes_sent[1])


def test_a_call_that_cuts_a_reply_is_not_blamed_on_the_user(env):
    async def go():
        s = await speaking_reply(env, aec=False)
        await s.on_text({"type": "hold"})
        assert await wait_for(lambda: s._cut_note is not None)
        env.clock.t += 5
        env.listen.push("StartOfTurn", "back", 1)
        env.listen.push("EndOfTurn", "sorry, I'm back", 1)
        assert await wait_for(lambda: len(env.sent_messages) == 2)
        await s.close()

    run(go())
    cut = [n for n in env.notes_sent[1] if "interrupted your reply" in n]
    assert cut and "phone call" in cut[0] and "cut you off" not in cut[0]


def test_an_undelivered_turn_says_so_and_goes_back_to_listening(env):
    env.forward.update(status="pending", reason="gateway unreachable")

    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "hi")
        env.listen.push("EndOfTurn", "hi there")
        assert await wait_for(lambda: "notice" in env.types())
        await settle()
        assert s._reader is None
        await s.close()

    run(go())
    notice = [f for f in env.frames() if f["type"] == "notice"][0]["message"]
    assert "gateway unreachable" in notice and "saved in the thread" in notice
    assert "thinking" not in env.states() and env.states()[-1] == "listening"


def test_a_deleted_thread_is_reported_before_anything_is_said(env, monkeypatch):
    monkeypatch.setattr(ls, "ACKS", ACKS)

    async def go():
        s = await started(env)
        env.store.gone = True
        env.listen.push("StartOfTurn", "hi")
        env.listen.push("EndOfTurn", "hi there")
        assert await wait_for(lambda: "notice" in env.types())
        await s.close()

    run(go())
    assert env.sent_messages == [] and env.spoken() == []
    assert "no longer exists" in [f for f in env.frames() if f["type"] == "notice"][0]["message"]


def test_malformed_voice_settings_fall_back_to_the_defaults(env):
    async def go():
        s = env.make()
        await s.start()
        await s.on_text({"type": "hello", "thread_id": "thr_1", "aec": False,
                         "tts": {"voice": "../../etc", "speed": "fast", "expressivity": 9, "enabled": True}})
        await settle()
        assert "ready" in env.types()
        await s.close()

    run(go())
    assert env.speak.connected_with == (ls.DEFAULT_VOICE, 1.0, 0)


def test_tts_config_keeps_good_values_and_replaces_bad_ones():
    assert ls._tts_config({"voice": "flux-kit-en", "speed": 1.15, "expressivity": -1, "enabled": False}) == {
        "voice": "flux-kit-en", "speed": 1.15, "expressivity": -1, "enabled": False}
    assert ls._tts_config({"speed": True, "expressivity": "2", "voice": "Flux Kit"}) == {
        "voice": ls.DEFAULT_VOICE, "speed": 1.0, "expressivity": 0, "enabled": True}
    assert ls._tts_config(None)["enabled"] is True


def test_a_reconnect_forgets_turns_from_the_old_stream(env, monkeypatch):
    monkeypatch.setattr(ls, "BACKOFF_S", (0.001,))

    async def go():
        s = await started(env, aec=False)
        s._speaking = True
        env.listen.push("StartOfTurn", "five things", 0)
        await settle()
        s._speaking = False
        s._spawn_recover("test break")
        assert await wait_for(lambda: not s._recovering and env.states()[-1] == "listening")
        env.clock.t += 2
        # The new stream numbers its turns from 0 again: this turn 0 is real.
        env.listen.push("StartOfTurn", "what", 0)
        env.listen.push("EndOfTurn", "what about tomorrow", 0)
        assert await wait_for(lambda: env.sent_messages)
        await s.close()

    run(go())
    assert env.sent_messages == [("thr_1", "what about tomorrow")]


def test_an_owed_reply_is_spoken_even_when_deepgram_was_down_at_hello(env, monkeypatch):
    attempts = {"n": 0}
    good = env.listen

    class Flaky(FakeListen):
        async def connect(self, sample_rate=16000):
            attempts["n"] += 1
            raise ls.DeepgramUnavailable("down")

    monkeypatch.setattr(ls, "listen_factory", lambda: Flaky() if attempts["n"] < 1 else good)
    monkeypatch.setattr(ls, "BACKOFF_S", (0.001,))

    async def go():
        env.store.reply("a", "Five things.")
        s = env.make()
        await s.start()
        await s.on_text({**hello(), "resume_seq": 0})
        assert await wait_for(lambda: ("speak", "Five things.") in env.speak.calls)
        await s.close()

    run(go())


def test_a_tap_does_not_wait_for_the_stop_to_be_delivered(env, monkeypatch):
    async def go():
        release = asyncio.Event()

        async def slow_stop(tid):
            await release.wait()
            env.stops.append(tid)

        monkeypatch.setattr(ls, "stop_run", slow_stop)
        s = await speaking_reply(env, aec=False)
        await asyncio.wait_for(s.on_text({"type": "interrupt"}), 0.5)
        assert await s.on_text({"type": "ping"}) == "ok"
        assert env.stops == []
        release.set()
        assert await wait_for(lambda: env.stops == ["thr_1"])
        await s.close()

    run(go())


def test_the_agent_hears_its_reply_is_read_aloud_only_when_it_is(env):
    async def go():
        s = await started(env)
        env.listen.push("StartOfTurn", "hi")
        env.listen.push("EndOfTurn", "hi there")
        assert await wait_for(lambda: env.sent_messages)
        await s.close()

    run(go())
    assert env.read_aloud == [True]


def test_a_backchannel_inside_the_hold_does_not_lose_the_turn_being_held(env, monkeypatch):
    monkeypatch.setattr(ls, "HOLD_S", 0.2)

    async def go():
        s = await speaking_reply(env, aec=True)
        env.listen.push("StartOfTurn", "wait", 1)
        env.listen.push("EndOfTurn", "Wait.", 1)
        await asyncio.sleep(0.05)
        env.listen.push("StartOfTurn", "mm", 2)
        env.listen.push("EndOfTurn", "Mm.", 2)
        assert await wait_for(lambda: len(env.sent_messages) == 2, n=1000)
        await s.close()

    run(go())
    assert env.sent_messages[-1] == ("thr_1", "Wait.")
