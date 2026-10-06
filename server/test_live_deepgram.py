"""Tests for the Flux STT/TTS websocket wrappers. All tests patch websockets.connect."""
import asyncio
import json

import pytest

import live_deepgram as ld


def run(coro):
    return asyncio.run(coro)


class FakeWS:
    def __init__(self, incoming):
        self.sent = []
        self._in = list(incoming)
        self.pings = 0

    async def send(self, m):
        self.sent.append(m)

    async def ping(self):
        self.pings += 1

    async def close(self):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._in:
            raise StopAsyncIteration
        return self._in.pop(0)


@pytest.fixture
def fake_connect(monkeypatch):
    made = {"incoming": []}

    async def connect(url, additional_headers=None, **kw):
        made["url"] = url
        made["headers"] = additional_headers
        made["ws"] = FakeWS(made["incoming"])
        return made["ws"]

    monkeypatch.setattr(ld.websockets, "connect", connect)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    return made


def collect(agen):
    async def go():
        return [e async for e in agen]
    return go()


def test_listen_uses_flux_v2_with_turn_params(fake_connect):
    s = ld.FluxListen()
    run(s.connect())
    url = fake_connect["url"]
    assert url.startswith("wss://api.deepgram.com/v2/listen?")
    assert "model=flux-general-en" in url and "encoding=linear16" in url and "sample_rate=16000" in url
    assert "eot_threshold=0.8" in url and "eager_eot_threshold" not in url
    assert fake_connect["headers"] == {"Authorization": "Token k"}


def test_listen_yields_turninfo_events(fake_connect):
    fake_connect["incoming"] += [
        json.dumps({"type": "Connected"}),
        json.dumps({"type": "TurnInfo", "event": "StartOfTurn", "turn_index": 0, "transcript": "hey"}),
        json.dumps({"type": "TurnInfo", "event": "EndOfTurn", "turn_index": 0, "transcript": "hey there"}),
    ]

    async def go():
        s = ld.FluxListen()
        await s.connect()
        return [e async for e in s.events()]

    assert run(go()) == [
        {"event": "StartOfTurn", "transcript": "hey", "turn_index": 0},
        {"event": "EndOfTurn", "transcript": "hey there", "turn_index": 0},
    ]


def test_listen_error_frame_is_unavailable(fake_connect):
    fake_connect["incoming"] += [json.dumps({"type": "Error", "code": "X"})]

    async def go():
        s = ld.FluxListen()
        await s.connect()
        return [e async for e in s.events()]

    with pytest.raises(ld.DeepgramUnavailable):
        run(go())


def test_speak_streams_tokens_then_flush(fake_connect):
    async def go():
        s = ld.FluxSpeak()
        await s.connect("flux-hannah-en", 1.0, 0)
        await s.speak("Sure, ")
        await s.speak("done.")
        await s.flush()

    run(go())
    assert "/v2/speak?" in fake_connect["url"] and "model=flux-hannah-en" in fake_connect["url"]
    assert "sample_rate=24000" in fake_connect["url"]
    assert "speed" not in fake_connect["url"] and "expressivity" not in fake_connect["url"]
    assert [json.loads(m) for m in fake_connect["ws"].sent] == [
        {"type": "Speak", "text": "Sure, "}, {"type": "Speak", "text": "done."}, {"type": "Flush"}]


def test_speak_passes_non_default_speed_and_expressivity(fake_connect):
    run(ld.FluxSpeak().connect("flux-hannah-en", 1.15, 1))
    assert "speed=1.15" in fake_connect["url"] and "expressivity=1" in fake_connect["url"]


def test_speak_interrupt_sends_playback_offset(fake_connect):
    async def go():
        s = ld.FluxSpeak()
        await s.connect("flux-hannah-en", 1.0, 0)
        await s.interrupt(2340)
        await s.interrupt(None)

    run(go())
    sent = [json.loads(m) for m in fake_connect["ws"].sent]
    assert sent == [{"type": "Interrupt", "playback_offset": {"type": "time_ms", "value": 2340}},
                    {"type": "Interrupt"}]


def test_speak_events_classify_frames(fake_connect):
    fake_connect["incoming"] += [
        json.dumps({"type": "Connected"}),
        json.dumps({"type": "SpeechStarted", "speech_id": "dg_sp_1"}), b"\x00\x01",
        json.dumps({"type": "SpeechMetadata", "speech_id": "dg_sp_1", "audio_duration_ms": 5}),
        json.dumps({"type": "SpeechInterrupted", "text_spoken": "a", "text_remaining": "b"}),
    ]

    async def go():
        s = ld.FluxSpeak()
        await s.connect("flux-hannah-en", 1.0, 0)
        return [e async for e in s.events()]

    got = run(go())
    assert [k for k, _ in got] == ["started", "audio", "done", "interrupted"]
    assert got[1][1] == b"\x00\x01"
    assert got[2][1]["audio_duration_ms"] == 5
    assert got[3][1] == {"text_spoken": "a", "text_remaining": "b"}


def test_speak_keepalive_pings(fake_connect):
    async def go():
        s = ld.FluxSpeak()
        await s.connect("flux-hannah-en", 1.0, 0)
        await s.keepalive()

    run(go())
    assert fake_connect["ws"].pings == 1


def test_missing_key_is_not_configured(monkeypatch):
    """A missing key is its own kind of unavailable: the session ends instead of
    retrying, since no reconnect can find a key the environment does not have."""
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)

    async def never(url, **kw):
        raise AssertionError("no socket is opened without a key")

    monkeypatch.setattr(ld.websockets, "connect", never)
    with pytest.raises(ld.DeepgramNotConfigured):
        run(ld.FluxListen().connect())
    with pytest.raises(ld.DeepgramNotConfigured):
        run(ld.FluxSpeak().connect("flux-hannah-en", 1.0, 0))
    assert issubclass(ld.DeepgramNotConfigured, ld.DeepgramUnavailable)


def test_connect_failure_is_unavailable_but_not_unconfigured(monkeypatch):
    async def boom(url, **kw):
        raise OSError("refused")

    monkeypatch.setattr(ld.websockets, "connect", boom)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k")
    with pytest.raises(ld.DeepgramUnavailable) as exc:
        run(ld.FluxSpeak().connect("flux-hannah-en", 1.0, 0))
    assert not isinstance(exc.value, ld.DeepgramNotConfigured)


def test_listen_sample_rate_is_configurable(fake_connect):
    run(ld.FluxListen().connect(sample_rate=24000))
    assert "sample_rate=24000" in fake_connect["url"]


def test_the_app_and_the_server_default_to_the_same_voice():
    """The app sends its default voice in every hello; the server's fallback must be
    the same one, or a session that names no voice sounds different."""
    import pathlib
    import re
    settings = pathlib.Path(__file__).resolve().parent.parent / "app" / "src" / "lib" / "live" / "settings.ts"
    if not settings.exists():
        pytest.skip("the app is not beside the server in this checkout")
    voice = re.search(r"voice: '([^']+)'", settings.read_text())
    assert voice and voice.group(1) == ld.DEFAULT_VOICE
