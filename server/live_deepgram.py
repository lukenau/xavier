"""Deepgram Flux over websockets: turn-detecting STT (/v2/listen) and streaming
TTS (/v2/speak). Wire protocol only; live_session.py owns the policy."""
import json
import os
from typing import Any, AsyncIterator, Callable
from urllib.parse import urlencode

import websockets

LISTEN_URL = "wss://api.deepgram.com/v2/listen"
SPEAK_URL = "wss://api.deepgram.com/v2/speak"
MIC_RATE = 16000
TTS_RATE = 24000
# The voice when a session names none: the first of Deepgram's featured Flux
# voices. The app sends its own default (app/src/lib/live/settings.ts); keep the
# two the same.
DEFAULT_VOICE = "flux-hannah-en"
# Above the 0.7 default: for an agent that runs tools, a false end-of-turn
# costs more than ~100 ms of extra wait (Deepgram's voice-agent guidance).
EOT_THRESHOLD = 0.8
EOT_TIMEOUT_MS = 5000


class DeepgramUnavailable(Exception):
    """The Deepgram socket could not be opened, or broke."""


class DeepgramNotConfigured(DeepgramUnavailable):
    """No DEEPGRAM_API_KEY: retrying cannot help until the server is configured."""


def _key() -> str:
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        raise DeepgramNotConfigured("DEEPGRAM_API_KEY not set")
    return key


async def _open(url: str):
    key = _key()
    try:
        return await websockets.connect(url, additional_headers={"Authorization": f"Token {key}"})
    except Exception as e:
        raise DeepgramUnavailable(f"connect failed: {e}") from e


class FluxListen:
    def __init__(self) -> None:
        self._ws = None

    async def connect(self, sample_rate: int = MIC_RATE) -> None:
        q = {"model": "flux-general-en", "encoding": "linear16", "sample_rate": sample_rate,
             "eot_threshold": EOT_THRESHOLD, "eot_timeout_ms": EOT_TIMEOUT_MS}
        self._ws = await _open(f"{LISTEN_URL}?{urlencode(q)}")

    async def send(self, pcm: bytes) -> None:
        if self._ws is None:
            raise DeepgramUnavailable("listen not connected")
        try:
            await self._ws.send(pcm)
        except Exception as e:
            raise DeepgramUnavailable(f"listen send failed: {e}") from e

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        if self._ws is None:
            raise DeepgramUnavailable("listen not connected")
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    continue
                msg = json.loads(raw)
                if msg.get("type") == "TurnInfo":
                    yield {"event": msg.get("event"), "transcript": msg.get("transcript") or "",
                           "turn_index": msg.get("turn_index", 0)}
                elif msg.get("type") == "Error":
                    raise DeepgramUnavailable(f"listen error: {msg}")
        except DeepgramUnavailable:
            raise
        except Exception as e:
            raise DeepgramUnavailable(f"listen stream failed: {e}") from e

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is None:
            return
        try:
            await ws.send(json.dumps({"type": "CloseStream"}))
            await ws.close()
        except Exception:
            pass


class FluxSpeak:
    def __init__(self) -> None:
        self._ws = None

    async def connect(self, voice: str, speed: float, expressivity: int) -> None:
        q: dict[str, Any] = {"model": voice, "encoding": "linear16", "sample_rate": TTS_RATE}
        if speed and float(speed) != 1.0:
            q["speed"] = speed
        if expressivity:
            q["expressivity"] = int(expressivity)
        self._ws = await _open(f"{SPEAK_URL}?{urlencode(q)}")

    async def _send(self, frame: dict[str, Any]) -> None:
        if self._ws is None:
            raise DeepgramUnavailable("speak not connected")
        try:
            await self._ws.send(json.dumps(frame))
        except Exception as e:
            raise DeepgramUnavailable(f"speak send failed: {e}") from e

    async def speak(self, text: str) -> None:
        await self._send({"type": "Speak", "text": text})

    async def flush(self) -> None:
        await self._send({"type": "Flush"})

    async def interrupt(self, played_ms: int | None) -> None:
        frame: dict[str, Any] = {"type": "Interrupt"}
        if played_ms is not None:
            frame["playback_offset"] = {"type": "time_ms", "value": int(played_ms)}
        await self._send(frame)

    async def keepalive(self) -> None:
        """/v2/speak closes after 60 s with no inbound message; a ping resets it."""
        if self._ws is None:
            raise DeepgramUnavailable("speak not connected")
        try:
            await self._ws.ping()
        except Exception as e:
            raise DeepgramUnavailable(f"speak ping failed: {e}") from e

    async def events(self) -> AsyncIterator[tuple[str, Any]]:
        if self._ws is None:
            raise DeepgramUnavailable("speak not connected")
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    yield ("audio", raw)
                    continue
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "SpeechStarted":
                    yield ("started", msg.get("speech_id"))
                elif kind == "SpeechMetadata":
                    yield ("done", msg)
                elif kind == "SpeechInterrupted":
                    yield ("interrupted", {"text_spoken": msg.get("text_spoken"),
                                           "text_remaining": msg.get("text_remaining")})
                elif kind == "Error":
                    raise DeepgramUnavailable(f"speak error: {msg}")
        except DeepgramUnavailable:
            raise
        except Exception as e:
            raise DeepgramUnavailable(f"speak stream failed: {e}") from e

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is None:
            return
        try:
            await ws.send(json.dumps({"type": "Close"}))
            await ws.close()
        except Exception:
            pass


listen_factory: Callable[[], FluxListen] = FluxListen
speak_factory: Callable[[], FluxSpeak] = FluxSpeak
