"""End-to-end LiveSession run against real Deepgram, with a fake chat store that
answers with a canned reply and no phone (drains are inferred from the audio
sent). Needs DEEPGRAM_API_KEY in the environment; nothing goes to Hermes.

  DEEPGRAM_API_KEY=... python scripts/live_e2e.py
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import live_session as ls  # noqa: E402
from live_probe import FRAME, synth  # noqa: E402

REPLY = "Five things tomorrow. Standup at ten, then your one on one at eleven thirty."


class Store:
    def __init__(self):
        self.events = []

    def add(self, t, p):
        self.events.append({"seq": len(self.events) + 1, "type": t, "payload": p})

    def get_thread(self, tid):
        return {"last_seq": len(self.events)}

    def scan_events_after(self, tid, after, limit=500):
        evs = [e for e in self.events if e["seq"] > after]
        return evs, (evs[-1]["seq"] if evs else after)


async def main() -> None:
    store = Store()
    sent: list[str] = []
    out: list = []
    marks: dict[str, float] = {}
    captions: dict[int, str] = {}
    finished: list[int] = []

    async def send_message(tid, text, notes, read_aloud):
        sent.append(text)
        marks["sent"] = time.monotonic()

        async def answer():
            await asyncio.sleep(0.4)
            store.add("run.status", {"status": "running"})
            words = REPLY.split(" ")
            store.add("message.upsert", {"message_id": "a", "role": "assistant", "author_type": "agent",
                                         "parts": [{"type": "text", "text": words[0]}]})
            for w in words[1:]:
                await asyncio.sleep(0.03)
                store.add("part.delta", {"message_id": "a", "idx": 0, "delta": " " + w})
            store.add("run.status", {"status": "idle"})

        asyncio.create_task(answer())
        return {"id": "u1", "forward_status": "forwarded", "forward_reason": ""}

    async def emit(item):
        if isinstance(item, bytes):
            marks.setdefault("first_audio", time.monotonic())
        else:
            f = json.loads(item)
            if f["type"] == "heard" and f["final"]:
                marks["eot"] = time.monotonic()
            elif f["type"] == "caption":
                captions[f["turn_id"]] = captions.get(f["turn_id"], "") + f["text"]
            elif f["type"] == "speak_end":
                finished.append(f["turn_id"])
        out.append(item)

    ls.get_store = lambda: store
    ls.send_message = send_message
    s = ls.LiveSession(emit)
    await s.start()
    await s.on_text({"type": "hello", "thread_id": "thr_e2e", "aec": False,
                     "tts": {"voice": ls.DEFAULT_VOICE, "speed": 1.0, "expressivity": 0, "enabled": True}})
    pcm = bytes(FRAME * 4) + await synth("what's on my calendar tomorrow", 16000)
    for i in range(0, len(pcm), FRAME):
        await s.on_audio(pcm[i:i + FRAME].ljust(FRAME, b"\0"))
        await asyncio.sleep(0.08)
    for _ in range(200):
        await s.on_audio(bytes(FRAME))
        await asyncio.sleep(0.08)
        if any("Five things" in captions.get(t, "") for t in finished):
            break
    await s.close()

    frames = [json.loads(x) for x in out if isinstance(x, str)]
    types = [f["type"] for f in frames]
    audio = b"".join(x for x in out if isinstance(x, bytes))
    print("sent:", sent)
    print("spoken:", [captions[t] for t in sorted(captions)])
    print("frames:", [t for t in types if t not in ("heard", "caption")])
    print(f"audio: {len(audio)} bytes = {len(audio) / 48000:.2f}s")
    if "eot" in marks and "first_audio" in marks:
        print(f"end-of-turn -> first audio (the acknowledgement): "
              f"{int((marks['first_audio'] - marks['eot']) * 1000)} ms")
    assert len(sent) == 1 and "calendar" in sent[0], sent
    assert any("Five things" in captions.get(t, "") for t in finished), captions
    assert len(audio) > 48000 * 2, len(audio)
    print("E2E OK")


if __name__ == "__main__":
    asyncio.run(main())
