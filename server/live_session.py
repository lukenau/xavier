"""The /api/live WebSocket: hands-free voice with Xavier.

Phone -> server: `hello`, binary 80 ms s16le mic frames (always sent; 16 kHz, or
the `mic_rate` the hello names), `playback{turn_id,played_ms}`,
`drained{turn_id}`, `interrupt`, `hold`, `diag`, `ping`, `stop`.
Server -> phone: `ready`, `state`, `heard{text,final}`, `turn{message_id,seq}`,
`speak_start{turn_id}` + binary 24 kHz audio + `speak_end{turn_id}`,
`caption{turn_id,text}`, `cancel{turn_id}`, `duck`/`unduck`, `ended{reason}`,
`notice{message}` (something the user should be told), `pong`, `error`.

Turns come from Deepgram Flux end-of-turn detection, never from silence
heuristics. Without echo cancellation on the phone (`aec: false`) a Flux turn
that STARTED while the phone was playing, or within ECHO_TAIL_S of it
draining, is the speaker heard by the mic and is dropped. With AEC, echo
cancellation still lets some of a loud speaker through, so a turn that starts
during playback (or just after) is only a candidate: it ducks the reply, and it
becomes a turn only if it is not a repeat of what Xavier just said and, mid-
reply, is two real (non-backchannel) words or a stop word; then it cuts the
reply. Once a reply is cut, the rest of it stays unsaid even as its run keeps
streaming.

Deepgram is the one service Live adds: it gets the mic audio for transcription
and the reply text for the voice. The audio goes nowhere else and is never
stored; what was said is stored as the text of the user's message. With no
DEEPGRAM_API_KEY the socket answers `hello` with `ended{reason:"unconfigured"}`
and the app says so.
"""
from __future__ import annotations

import asyncio
import difflib
import json
import logging
import os
import random
import re
import time
from collections import deque
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from chat.platform import get_store
from chat.session import chat_session_valid
from live_deepgram import DEFAULT_VOICE, DeepgramNotConfigured, DeepgramUnavailable, listen_factory, speak_factory
from live_reply import ReplyFilter

log = logging.getLogger("hub.live")
log.setLevel(logging.INFO)
# A root handler at WARNING would hide every Live diagnostic (latency, echo
# drops, mic health). Own handler, no propagation, so each line lands in the
# server's console log exactly once.
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    log.addHandler(_h)
    log.propagate = False

router = APIRouter(tags=["hub-live-ws"])

POLL_S = 0.1
TICK_S = 0.1
ECHO_TAIL_S = 0.6
UNDUCK_AFTER_S = 2.0
# A steered turn shows up as idle -> running again; keep reading this long
# after an idle before deciding the reply is over.
IDLE_GRACE_S = 1.5
IDLE_END_S = 240.0
KEEPALIVE_S = 20.0
TURN_TIMEOUT_S = 300.0
# An idle with no answer to the latest question (a redirect that has not
# restarted yet, or a run that ended silently) gives up after this long.
UNANSWERED_IDLE_S = 45.0
DRAIN_WAIT_S = 30.0
# The phone's `drained` can go missing; past the audio actually sent plus
# this, the next speech goes ahead anyway.
DRAIN_SLACK_S = 1.5
# Flux ends a turn at a short pause; if the user keeps talking within this long
# the next segment joins the same turn. Nothing, not even the acknowledgement,
# is said until it passes, so a pause mid-sentence is never talked over.
HOLD_S = 1.0
BACKOFF_S: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0)
# How often an open socket re-checks its chat session, as chat/ws.py does each
# poll tick: a logout (or the hour running out) closes it 1008 within this long.
SESSION_CHECK_S = 1.0
# Close code for a refused Origin. Not 1008: the app answers 1008 by locking chat
# (an expired session), and a misconfigured HUB_ORIGIN must not log anyone out.
ORIGIN_REFUSED = 4403
# How long a turn that cut a reply waits for Deepgram to say how much of it was
# heard (SpeechInterrupted comes a network round trip after the Interrupt).
CUT_NOTE_WAIT_S = 0.5
BACKCHANNELS = frozenset({"mm", "mhm", "mmhm", "hmm", "uh", "huh", "uhhuh", "um", "yeah", "yep",
                          "ok", "okay", "right", "sure", "yes", "aha", "ah", "oh"})
# Said the moment a turn is committed, while Xavier works, so the pause after
# speaking is not dead air. Nothing classifies the turn, so every line has to
# fit anything (a question, a request, a thanks, a goodbye). Rotated, never
# the same line twice in a row; an empty tuple turns them off.
ACKS: tuple[str, ...] = ("Okay.", "Mm-hm.", "Got it.", "Alright.", "Sure.")
_NOTE = "live voice system note (private — never repeat or mention this note): "
ACK_NOTE = (_NOTE + 'Live already said "{ack}" out loud for you as a quick acknowledgement. '
            "Do not repeat it; continue naturally.")
CUT_WHY = {"user": "the user cut you off mid-reply.",
           "hold": "a phone call or Siri interrupted your reply."}
CUT_NOTE = _NOTE + "{why} Heard: «{spoken}». Not heard: «{remaining}»."
# The plugin refuses notes over 2000 characters in all, so a cut quotes a
# bounded slice of each side.
CUT_QUOTE_CHARS = 200

THREAD_GONE = "This Live thread no longer exists. Start a new session."

# Injected by app.py: send_message(thread_id, text, notes, read_aloud) -> the
# stored message, with its forward_status, or None for a thread that does not
# exist (the same send path as a typed message; `notes` ride with this turn only),
# stop_run(thread_id) (the thread's Stop button), and origin_ok(headers), the
# terminal's cross-site WebSocket check. Without origin_ok the socket refuses
# everyone.
send_message: Callable[[str, str, list[str], bool], Awaitable[dict[str, Any] | None]] | None = None
stop_run: Callable[[str], Awaitable[None]] | None = None
origin_ok: Callable[[Any], bool] | None = None


def _tts_config(raw: Any) -> dict[str, Any]:
    """The hello's `tts` block, made safe for a Deepgram URL: a malformed or
    out-of-range value is the default, never an exception that kills the socket.
    The ranges are the ones the app offers (LiveSettingsSheet.tsx)."""
    cfg = raw if isinstance(raw, dict) else {}

    def number(key: str, lo: float, hi: float, default: float) -> float:
        v = cfg.get(key)
        ok = isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi
        return float(v) if ok else default

    voice = cfg.get("voice")
    return {
        "voice": voice if isinstance(voice, str) and re.fullmatch(r"[a-z0-9-]{1,64}", voice) else DEFAULT_VOICE,
        "speed": number("speed", 0.75, 1.25, 1.0),
        "expressivity": int(number("expressivity", -2, 2, 0)),
        "enabled": cfg.get("enabled") is not False,
    }


# How much of a turn matches what Xavier said in the last few seconds. Logged
# for every committed turn (the score, never the words), and used to filter:
# voice processing never removes all of a loud speakerphone, so some of his own
# voice reaches the mic and Flux transcribes it. Speech that starts while he
# talks, or within ECHO_TAIL_S after, is only an interruption candidate (see
# _qualifies): it must not repeat what he just said, and mid-reply it must be a
# real interruption, two real words or a stop word, the minimum-interruption
# rule common in voice-agent frameworks.
ECHO_MEMORY_S = 10.0
ECHO_MATCH = 0.5
STOP_WORDS = frozenset({"stop", "wait", "hold", "pause", "cancel", "enough", "quiet", "shush"})


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def _echo_score(said: str, heard: str) -> float:
    """The share of the heard words that appear, in order, in what was said."""
    h, s = _words(heard), _words(said)
    if not h or not s:
        return 0.0
    matcher = difflib.SequenceMatcher(None, s, h, autojunk=False)
    return sum(b.size for b in matcher.get_matching_blocks()) / len(h)


def _real_words(text: str) -> int:
    words = re.findall(r"[a-z']+", (text or "").lower().replace("-", ""))
    return sum(1 for w in words if w.replace("'", "") not in BACKCHANNELS)


def _tail(text: str, limit: int) -> str:
    return text if len(text) <= limit else "…" + text[-limit:].lstrip()


def _head(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


class LiveSession:
    def __init__(self, out: Callable[[str | bytes], Awaitable[None]], *,
                 now: Callable[[], float] = time.monotonic):
        self._out = out
        self._now = now
        self._sid = "s" + os.urandom(2).hex()
        self._q: asyncio.Queue = asyncio.Queue()
        self._sender: asyncio.Task | None = None
        self._ticker: asyncio.Task | None = None
        self._pumps: list[asyncio.Task] = []
        self._reader: asyncio.Task | None = None
        self._recovery: asyncio.Task | None = None
        self._background: set[asyncio.Task] = set()
        self._recovering = False
        self._closing = False
        self.finished = asyncio.Event()
        self.state = "idle"
        self.thread_id: str | None = None
        self.aec = False
        self._tts_cfg: dict[str, Any] = {}
        self._listen: Any = None
        self._speak: Any = None
        # Speech turns: one Flux TTS turn per stretch of reply.
        self._turn_id = 0
        self._speech_open = False
        self._speaking = False
        self._tts_turns: deque[int] = deque()
        self._cancelled: set[int] = set()
        self._turn_audio_ms: dict[int, int] = {}
        self._audio_at: dict[int, float] = {}
        self._pending: list[str] = []
        self._hold: asyncio.Task | None = None
        self._played_ms = 0
        self._last_drained = -1e9
        # Set while nothing is left playing on the phone; a new speech turn
        # waits for it so the tail of the previous one is never cut off.
        self._drained_ev = asyncio.Event()
        self._drained_ev.set()
        # Listening.
        self._suspect: set[int] = set()
        # What Live said lately, (when, text), for the echo score.
        self._said: list[tuple[float, str]] = []
        # With AEC: turn index -> it started while the phone was speaking (else
        # just after); candidates until they qualify as the user's own turn.
        self._candidates: dict[int, bool] = {}
        self._qualified: set[int] = set()
        self._ducked: int | None = None
        self._duck_at = 0.0
        # Set by a cut: the rest of that reply stays unsaid until the user's
        # next message shows up in the thread.
        self._muted = False
        # Per user turn.
        self._last_ack: str | None = None
        # Where the user last cut a reply off, told to Xavier with the next
        # spoken turn (the latest cut wins).
        self._cut_note: str | None = None
        self._cut_why = "user"
        self._cut_ev = asyncio.Event()
        self._rx_frames = 0
        # Mic loudness (RMS per 80 ms frame) while Xavier is audible vs not:
        # the size of the echo voice processing leaves, logged per reply.
        self._lvl_speaking: list[int] = []
        self._lvl_quiet: list[int] = []
        self._mic_rate = 16000
        self._rx_peak = 0
        self._eot_at: float | None = None
        self._last_activity = now()
        self._last_ping = now()

    # -- outbound -------------------------------------------------------------
    async def start(self) -> None:
        self._sender = asyncio.create_task(self._send_loop())

    async def _send_loop(self) -> None:
        while True:
            item = await self._q.get()
            if item is None:
                return
            try:
                await self._out(item)
            except Exception:
                log.info("[live %s] send failed; peer gone", self._sid)
                self.finished.set()
                return

    async def _emit(self, frame: dict[str, Any]) -> None:
        self._q.put_nowait(json.dumps(frame))

    def _set_state(self, value: str) -> None:
        if value != self.state:
            self.state = value
            self._q.put_nowait(json.dumps({"type": "state", "value": value}))

    async def _notice(self, message: str) -> None:
        await self._emit({"type": "notice", "message": message})

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    # -- inbound --------------------------------------------------------------
    async def on_text(self, frame: dict[str, Any]) -> str:
        kind = frame.get("type")
        if kind == "hello":
            await self._hello(frame)
        elif kind == "playback":
            if frame.get("turn_id") == self._turn_id and isinstance(frame.get("played_ms"), (int, float)):
                self._played_ms = int(frame["played_ms"])
        elif kind == "drained":
            log.info("[live %s] drained turn %s (current %s)", self._sid, frame.get("turn_id"), self._turn_id)
            if self._lvl_speaking:
                sp, qu = sorted(self._lvl_speaking), sorted(self._lvl_quiet) or [0]
                log.info("[live %s] mic while speaking rms p50=%d p90=%d max=%d n=%d | quiet p50=%d",
                         self._sid, sp[len(sp) // 2], sp[len(sp) * 9 // 10], sp[-1], len(sp), qu[len(qu) // 2])
                self._lvl_speaking = []
            if frame.get("turn_id") == self._turn_id and not self._speech_open:
                self._speaking = False
                self._drained_ev.set()
                self._last_drained = self._last_activity = self._now()
                self._set_state("thinking" if self._reader else "listening")
        elif kind == "interrupt":
            await self._cut_speech()
            reader, self._reader = self._reader, None
            if reader is not None:
                reader.cancel()
                if stop_run is not None and self.thread_id:
                    # Off the receive loop: the forward can take seconds, and mic
                    # frames, pings and drains must not queue behind it.
                    self._spawn(stop_run(self.thread_id))
            self._set_state("listening")
        elif kind == "hold":
            # A phone call or Siri took the audio session: stop speaking, but
            # let Xavier's run finish; the reply is still in the thread.
            await self._cut_speech("hold")
            self._set_state("thinking" if self._reader else "listening")
        elif kind == "diag":
            log.warning("[live %s] phone: %s", self._sid, str(frame.get("message") or "")[:300])
        elif kind == "ping":
            await self._emit({"type": "pong"})
        elif kind == "stop":
            return "stop"
        else:
            await self._emit({"type": "error", "message": f"unknown frame type: {kind!r}"})
        return "ok"

    async def on_audio(self, pcm: bytes) -> None:
        # Mic health, every ~5 s (62 frames of 80 ms): frames arriving, and the
        # loudest sample. A peak of 0 means the phone is sending silence.
        self._rx_frames += 1
        self._rx_peak = max(self._rx_peak, max((abs(v) for v in memoryview(pcm).cast("h")), default=0)
                            if len(pcm) % 2 == 0 else 0)
        if len(pcm) % 2 == 0 and pcm:
            samples = memoryview(pcm).cast("h")
            rms = int((sum(v * v for v in samples) / len(samples)) ** 0.5)
            (self._lvl_speaking if self._speaking else self._lvl_quiet).append(rms)
            del self._lvl_quiet[:-200]
        if self._rx_frames % 62 == 1:
            log.info("[live %s] mic frames=%d bytes=%d peak=%d", self._sid, self._rx_frames, len(pcm), self._rx_peak)
            self._rx_peak = 0
        if self._listen is None or self._recovering:
            return
        try:
            await self._listen.send(pcm)
        except DeepgramUnavailable as exc:
            self._spawn_recover(str(exc))

    async def _hello(self, frame: dict[str, Any]) -> None:
        self.aec = bool(frame.get("aec"))
        # The phone's capture rate: 16 kHz from react-native-audio-api, 24 kHz
        # from the native voice-processing module (one format end to end).
        rate = frame.get("mic_rate")
        self._mic_rate = rate if rate in (16000, 24000, 48000) else 16000
        tid = frame.get("thread_id")
        self.thread_id = tid if isinstance(tid, str) and tid else None
        if self._listen is not None or self._recovering:
            return
        self._tts_cfg = _tts_config(frame.get("tts"))
        log.info("[live %s] hello thread=%s aec=%s", self._sid, self.thread_id, self.aec)
        try:
            await self._connect()
        except DeepgramNotConfigured:
            # Retrying cannot help: the key is read from the environment at
            # start. Say so once and end, rather than "reconnecting" forever.
            log.warning("[live %s] DEEPGRAM_API_KEY is not set; Live is off", self._sid)
            await self._emit({"type": "error", "message": "Live voice needs DEEPGRAM_API_KEY on the server"})
            await self._emit({"type": "ended", "reason": "unconfigured"})
            self.finished.set()
            return
        except DeepgramUnavailable as exc:
            self._spawn_recover(str(exc))
        else:
            await self._emit({"type": "ready", "session": self._sid})
            self._ticker = asyncio.create_task(self._tick())
        # A reply still owed from before a reconnect is read even if Deepgram is
        # recovering; its words are captioned until the voice is back.
        resume = frame.get("resume_seq")
        if isinstance(resume, int) and resume >= 0 and self.thread_id:
            self._reader = asyncio.create_task(self._read_reply(resume))
            self._set_state("thinking")
        elif not self._recovering:
            self._set_state("listening")

    # -- streams --------------------------------------------------------------
    async def _connect(self) -> None:
        listen = listen_factory()
        await listen.connect(sample_rate=self._mic_rate)
        speak = None
        if self._tts_cfg.get("enabled", True):
            speak = speak_factory()
            try:
                await speak.connect(self._tts_cfg.get("voice", DEFAULT_VOICE),
                                    self._tts_cfg.get("speed", 1.0),
                                    self._tts_cfg.get("expressivity", 0))
            except BaseException:
                # Whatever stopped the voice socket, the listen socket must not leak.
                await listen.close()
                raise
        self._listen, self._speak = listen, speak
        self._pumps = [asyncio.create_task(self._listen_pump(listen))]
        if speak is not None:
            self._pumps.append(asyncio.create_task(self._speak_pump(speak)))

    def _spawn_recover(self, why: str) -> None:
        if not self._recovering and not self._closing:
            self._recovering = True
            # Held, so the loop keeps a strong reference and close() can cancel it.
            self._recovery = asyncio.create_task(self._recover(why))

    async def _recover(self, why: str) -> None:
        log.warning("[live %s] deepgram unavailable: %s", self._sid, why)
        await self._emit({"type": "error", "message": f"voice stream unavailable: {why}"})
        self._set_state("reconnecting")
        await self._drop_speech()
        await self._release_duck()
        await self._close_streams()
        # New streams start their own turn indexes and audio clock.
        self._suspect.clear()
        self._candidates.clear()
        self._qualified.clear()
        self._turn_audio_ms.clear()
        self._audio_at.clear()
        for delay in BACKOFF_S:
            await asyncio.sleep(delay)
            if self._closing:
                return
            try:
                await self._connect()
            except DeepgramUnavailable as exc:
                log.warning("[live %s] reconnect failed: %s", self._sid, exc)
                continue
            if self._closing:
                await self._close_streams()
                return
            self._recovering = False
            await self._emit({"type": "ready", "session": self._sid})
            if self._ticker is None:
                self._ticker = asyncio.create_task(self._tick())
            self._set_state("thinking" if self._reader else "listening")
            return
        self._recovering = False
        await self._emit({"type": "ended", "reason": "unavailable"})
        self.finished.set()

    async def _close_streams(self) -> None:
        pumps, self._pumps = self._pumps, []
        current = asyncio.current_task()
        for p in pumps:
            if p is not current:
                p.cancel()
        listen, speak, self._listen, self._speak = self._listen, self._speak, None, None
        for stream in (listen, speak):
            if stream is not None:
                try:
                    await stream.close()
                except Exception:
                    log.exception("[live %s] stream close failed", self._sid)

    async def _listen_pump(self, listen: Any) -> None:
        try:
            async for ev in listen.events():
                await self._on_turn_event(ev)
        except asyncio.CancelledError:
            raise
        except DeepgramUnavailable as exc:
            self._spawn_recover(str(exc))
            return
        except Exception as exc:
            log.exception("[live %s] listen pump failed", self._sid)
            self._spawn_recover(str(exc))
            return
        self._spawn_recover("listen stream closed")

    async def _speak_pump(self, speak: Any) -> None:
        try:
            async for kind, val in speak.events():
                head = self._tts_turns[0] if self._tts_turns else None
                if kind == "audio":
                    if head is not None and head not in self._cancelled:
                        self._audio_at.setdefault(head, self._now())
                        if self._eot_at is not None:
                            log.info("[live %s] latency eot->audio=%dms", self._sid,
                                     int((self._now() - self._eot_at) * 1000))
                            self._eot_at = None
                        self._q.put_nowait(val)
                elif kind == "done" and head is not None:
                    self._tts_turns.popleft()
                    self._turn_audio_ms[head] = self._turn_audio_ms.get(head, 0) + int(val.get("audio_duration_ms") or 0)
                    if head not in self._cancelled:
                        await self._emit({"type": "speak_end", "turn_id": head})
                elif kind == "interrupted":
                    spoken = (val.get("text_spoken") or "").strip()
                    if spoken and self.thread_id:
                        remaining = (val.get("text_remaining") or "").strip()
                        self._cut_note = CUT_NOTE.format(why=CUT_WHY[self._cut_why],
                                                         spoken=_tail(spoken, CUT_QUOTE_CHARS),
                                                         remaining=_head(remaining, CUT_QUOTE_CHARS))
                    self._cut_ev.set()
        except asyncio.CancelledError:
            raise
        except DeepgramUnavailable as exc:
            self._spawn_recover(str(exc))
        except Exception as exc:
            log.exception("[live %s] speak pump failed", self._sid)
            self._spawn_recover(str(exc))

    async def _tts(self, method: str, *args: Any) -> None:
        if self._speak is None:
            return
        try:
            await getattr(self._speak, method)(*args)
        except DeepgramUnavailable as exc:
            self._spawn_recover(str(exc))

    # -- listening ------------------------------------------------------------
    async def _on_turn_event(self, ev: dict[str, Any]) -> None:
        kind, text, idx = ev.get("event"), (ev.get("transcript") or "").strip(), ev.get("turn_index", 0)
        now = self._now()
        if kind == "StartOfTurn":
            self._last_activity = now
            if not self.aec and (self._speaking or now - self._last_drained < ECHO_TAIL_S):
                self._suspect.add(idx)
                log.info("[live %s] echo-suspect turn %s", self._sid, idx)
                return
            if self.aec and (self._speaking or now - self._last_drained < ECHO_TAIL_S):
                self._candidates[idx] = self._speaking
                if self._speaking:
                    self._ducked, self._duck_at = idx, now
                    await self._emit({"type": "duck"})
                return
            if self._hold is not None:
                self._hold.cancel()
                self._hold = None
                log.info("[live %s] continuation of a held turn", self._sid)
            await self._emit({"type": "heard", "text": text, "final": False})
            return
        if idx in self._candidates:
            mid_speech = self._candidates[idx]
            if idx not in self._qualified:
                if not self._qualifies(text, mid_speech):
                    if kind == "EndOfTurn":
                        del self._candidates[idx]
                        log.info("[live %s] turn %s not an interruption, dropped", self._sid, idx)
                        if self._ducked == idx:
                            await self._release_duck()
                    return
                self._qualified.add(idx)
                if self._hold is not None:
                    self._hold.cancel()
                    self._hold = None
                if self._ducked == idx:
                    await self._cut_speech()
            if kind != "EndOfTurn":
                await self._emit({"type": "heard", "text": text, "final": False})
                return
            del self._candidates[idx]
            self._qualified.discard(idx)
        if idx in self._suspect:
            if kind == "EndOfTurn":
                self._suspect.discard(idx)
                log.info("[live %s] echo turn %s dropped", self._sid, idx)
            return
        if kind == "EndOfTurn":
            if text:
                self._pending.append(text)
            if self._pending:
                await self._emit({"type": "heard", "text": " ".join(self._pending), "final": True})
                if self._hold is not None:
                    self._hold.cancel()
                self._hold = asyncio.create_task(self._hold_then_commit())
            return
        if text:
            await self._emit({"type": "heard", "text": text, "final": False})

    def _qualifies(self, text: str, mid_speech: bool) -> bool:
        """Whether a candidate turn is the user rather than Xavier's own voice
        coming back: not a repeat of what he just said, and mid-reply a real
        interruption."""
        words = _words(text)
        if not words:
            return False
        now = self._now()
        recent = " ".join(x for t, x in self._said if now - t < ECHO_MEMORY_S)
        if _echo_score(recent, text) >= ECHO_MATCH:
            return False
        return not mid_speech or _real_words(text) >= 2 or any(w in STOP_WORDS for w in words)

    async def _hold_then_commit(self) -> None:
        await asyncio.sleep(HOLD_S)
        text, self._pending, self._hold = " ".join(self._pending), [], None
        try:
            await self._commit(text)
        except Exception:
            log.exception("[live %s] commit failed", self._sid)

    def _pick_ack(self) -> str:
        choices = [line for line in ACKS if line != self._last_ack] or list(ACKS)
        self._last_ack = random.choice(choices)
        return self._last_ack

    async def _commit(self, text: str) -> None:
        cut = self._speaking or self._speech_open
        if cut:
            await self._cut_speech()
        if send_message is None or not self.thread_id:
            await self._emit({"type": "error", "message": "no thread"})
            return
        store = get_store()
        thread = await asyncio.to_thread(store.get_thread, self.thread_id)
        if thread is None:
            await self._notice(THREAD_GONE)
            return
        cursor = int(thread["last_seq"])
        if cut and self._speak is not None:
            # How much of the cut reply was heard belongs with this turn, not
            # the next one.
            try:
                await asyncio.wait_for(self._cut_ev.wait(), CUT_NOTE_WAIT_S)
            except asyncio.TimeoutError:
                pass
        self._eot_at = self._now()
        # Taken before this turn's own acknowledgement is spoken: the score is
        # about Xavier's earlier speech reaching the mic.
        recent = " ".join(x for t, x in self._said if self._eot_at - t < ECHO_MEMORY_S)
        notes, self._cut_note = ([self._cut_note] if self._cut_note else []), None
        # Spoken while Xavier works. Only when replies are spoken: with voice
        # replies off nothing is said, and the agent must not be told otherwise.
        if self._speak is not None and ACKS:
            ack = self._pick_ack()
            notes.append(ACK_NOTE.format(ack=ack))
            await self._say(ack)
            await self._end_speech()
        message = await send_message(self.thread_id, text, notes, self._speak is not None)
        if not message:
            await self._notice(THREAD_GONE)
            return
        log.info("[live %s] turn committed (%d chars) echo_score=%.2f", self._sid, len(text),
                 _echo_score(recent, text))
        await self._emit({"type": "turn", "message_id": message["id"], "seq": cursor})
        self._last_activity = self._now()
        if message.get("forward_status") != "forwarded":
            # Saved in the thread, but the agent never got it: say so, rather
            # than sit "thinking" at a gateway that is not answering.
            why = message.get("forward_reason") or "the agent did not take it"
            await self._notice(f"Xavier didn't get that ({why}). It is saved in the thread.")
            self._set_state("listening")
            return
        if self._reader is None or self._reader.done():
            self._reader = asyncio.create_task(self._read_reply(cursor))
        self._set_state("thinking")

    # -- speaking -------------------------------------------------------------
    async def _say(self, text: str) -> None:
        if self._speak is None:
            await self._emit({"type": "caption", "turn_id": self._turn_id, "text": text})
            return
        if not self._speech_open:
            if self._speaking:
                await self._wait_drained()
            self._drained_ev.clear()
            self._turn_id += 1
            self._speech_open = True
            self._speaking = True
            self._played_ms = 0
            self._tts_turns.append(self._turn_id)
            await self._emit({"type": "speak_start", "turn_id": self._turn_id})
            self._set_state("speaking")
        await self._emit({"type": "caption", "turn_id": self._turn_id, "text": text})
        now = self._now()
        self._said = [(t, x) for t, x in self._said if now - t < ECHO_MEMORY_S] + [(now, text)]
        await self._tts("speak", text)

    async def _wait_drained(self) -> None:
        turn, since = self._turn_id, self._now()
        while not self._drained_ev.is_set():
            now = self._now()
            dur, at = self._turn_audio_ms.get(turn), self._audio_at.get(turn)
            heard_by = at + dur / 1000 + DRAIN_SLACK_S if dur is not None and at is not None else None
            if (heard_by is not None and now > heard_by) or now - since > DRAIN_WAIT_S:
                log.info("[live %s] no drained for turn %s; speaking anyway", self._sid, turn)
                return
            try:
                await asyncio.wait_for(self._drained_ev.wait(), timeout=0.1)
            except asyncio.TimeoutError:
                pass

    async def _end_speech(self) -> None:
        if self._speech_open:
            self._speech_open = False
            await self._tts("flush")

    async def _release_duck(self) -> None:
        if self._ducked is not None:
            self._ducked = None
            await self._emit({"type": "unduck"})

    async def _cut_speech(self, why: str = "user") -> None:
        """Stop what is being said now (barge-in, a tap, a call). The rest of that
        reply stays unsaid: what its run streams from here on is muted until the
        user's next message appears in the thread."""
        await self._release_duck()
        if not (self._speaking or self._speech_open):
            return
        self._muted = True
        self._cut_why = why
        self._cut_ev.clear()
        offset = sum(ms for t, ms in self._turn_audio_ms.items() if t != self._turn_id) + self._played_ms
        await self._tts("interrupt", offset)
        self._turn_audio_ms[self._turn_id] = self._played_ms
        await self._drop_speech()

    async def _drop_speech(self) -> None:
        if self._speaking or self._speech_open:
            self._cancelled.update(self._tts_turns)
            self._cancelled.add(self._turn_id)
            await self._emit({"type": "cancel", "turn_id": self._turn_id})
        # A cancelled Flux turn ends in SpeechInterrupted, never SpeechMetadata,
        # so nothing queued may wait for a `done` that will not come.
        self._tts_turns.clear()
        self._speech_open = False
        self._speaking = False
        self._drained_ev.set()
        self._last_drained = self._now()

    # -- the reply ------------------------------------------------------------
    async def _read_reply(self, cursor: int) -> None:
        me = asyncio.current_task()
        store = get_store()
        reply = ReplyFilter()
        idle_at: float | None = None
        # An idle ends the reply only once the latest question has been
        # answered (spoken text or a tool call after it). A question that cut
        # into a running turn makes the interrupted run go idle at once, and the
        # redirected run can take many seconds to start.
        answered = False
        deadline = self._now() + TURN_TIMEOUT_S
        try:
            while True:
                if self._recovering:
                    # The voice is reconnecting: leave the rest unread until it is
                    # back, so it is spoken rather than only captioned.
                    await asyncio.sleep(POLL_S)
                    continue
                events, cursor = await asyncio.to_thread(store.scan_events_after, self.thread_id, cursor)
                for ev in events:
                    p = ev.get("payload") or {}
                    if ev.get("type") == "run.status" and p.get("status") == "running":
                        idle_at = None
                    if ev.get("type") == "message.upsert" and p.get("role") == "user":
                        answered = False
                        idle_at = None
                        deadline = self._now() + TURN_TIMEOUT_S
                        # Only what starts after the user's latest message is an
                        # answer to it; anything still streaming from before is not.
                        reply.mute_seen()
                        self._muted = False
                    for kind, text in reply.feed(ev):
                        if self._muted and kind != "idle":
                            continue
                        if kind == "say":
                            idle_at = None
                            answered = True
                            await self._say(text)
                        elif kind == "tool":
                            answered = True
                            await self._end_speech()
                        elif kind == "idle":
                            await self._end_speech()
                            idle_at = self._now()
                now = self._now()
                if idle_at is not None and now - idle_at >= (IDLE_GRACE_S if answered else UNANSWERED_IDLE_S):
                    break
                if now > deadline:
                    await self._notice("No reply after five minutes, so Live stopped waiting. "
                                       "It will still land in the thread.")
                    await self._end_speech()
                    break
                if not events:
                    await asyncio.sleep(POLL_S)
        finally:
            if self._reader is me:
                self._reader = None
                self._last_activity = self._now()
                if not self._speaking and not self._recovering and not self._closing:
                    self._set_state("listening")

    # -- housekeeping ---------------------------------------------------------
    async def _tick(self) -> None:
        while not self._closing:
            await asyncio.sleep(TICK_S)
            now = self._now()
            if self._ducked is not None and now - self._duck_at >= UNDUCK_AFTER_S:
                await self._release_duck()
            if now - self._last_ping >= KEEPALIVE_S:
                self._last_ping = now
                await self._tts("keepalive")
            if (now - self._last_activity >= IDLE_END_S and self._reader is None
                    and not self._speaking and self.state == "listening"):
                log.info("[live %s] idle end", self._sid)
                await self._emit({"type": "ended", "reason": "idle"})
                self.finished.set()
                return

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        tasks = [t for t in (self._ticker, self._reader, self._hold, self._recovery)
                 if t is not None and t is not asyncio.current_task()]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._close_streams()
        self._q.put_nowait(None)
        if self._sender is not None:
            try:
                await asyncio.wait_for(self._sender, timeout=2.0)
            except Exception:
                pass
        self.finished.set()


@router.websocket("/api/live")
async def live_ws_endpoint(ws: WebSocket) -> None:
    token = ws.cookies.get("hub_chat_session")
    # Accept first, then close: a close before accept surfaces as 1006 on the
    # phone, which retries, while 1008 is the code it treats as "locked"
    # (same as chat/ws.py). The Origin check is the terminal's: the cookie alone
    # would let a page elsewhere on the same site open the mic socket.
    await ws.accept()
    if origin_ok is None or not origin_ok(ws.headers):
        await ws.close(code=ORIGIN_REFUSED)
        return
    if not chat_session_valid(token):
        await ws.close(code=1008)
        return

    async def out(item: str | bytes) -> None:
        if isinstance(item, bytes):
            await ws.send_bytes(item)
        else:
            await ws.send_text(item)

    session = LiveSession(out)
    await session.start()

    async def receive() -> None:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if (text := msg.get("text")) is not None:
                try:
                    frame = json.loads(text)
                except ValueError:
                    frame = None
                if not isinstance(frame, dict):
                    await session._emit({"type": "error", "message": "frame must be a JSON object"})
                    continue
                if await session.on_text(frame) == "stop":
                    return
            elif (data := msg.get("bytes")) is not None:
                await session.on_audio(data)

    async def session_lapsed() -> None:
        # The cookie was checked once at accept; a logout must still cut an
        # open mic, so it is checked again for as long as the socket lives.
        while chat_session_valid(token):
            await asyncio.sleep(SESSION_CHECK_S)

    recv = asyncio.create_task(receive())
    ended = asyncio.create_task(session.finished.wait())
    lapsed = asyncio.create_task(session_lapsed())
    try:
        await asyncio.wait({recv, ended, lapsed}, return_when=asyncio.FIRST_COMPLETED)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        locked = lapsed.done() and not lapsed.cancelled()
        for t in (recv, ended, lapsed):
            t.cancel()
        await asyncio.gather(recv, ended, lapsed, return_exceptions=True)
        await session.close()
        try:
            await ws.close(code=1008 if locked else 1000)
        except Exception:
            pass
