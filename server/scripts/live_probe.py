"""Round-trip probe against real Deepgram: Flux TTS speaks a phrase at 16 kHz and
Flux STT hears it back. Checks that a DEEPGRAM_API_KEY works for Live voice. It
needs the key in the environment and sends only the phrase you give it.

  DEEPGRAM_API_KEY=... python scripts/live_probe.py "testing one two three"
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import live_deepgram as ld  # noqa: E402

FRAME = 2560  # 80 ms of 16 kHz s16le


async def synth(text: str, rate: int) -> bytes:
    ld.TTS_RATE, saved = rate, ld.TTS_RATE
    s = ld.FluxSpeak()
    try:
        await s.connect(ld.DEFAULT_VOICE, 1.0, 0)
    finally:
        ld.TTS_RATE = saved
    await s.speak(text)
    await s.flush()
    audio = bytearray()
    async for kind, val in s.events():
        if kind == "audio":
            audio += val
        elif kind == "done":
            break
    await s.close()
    return bytes(audio)


async def hear(pcm: bytes) -> list[dict]:
    listen = ld.FluxListen()
    await listen.connect()
    got: list[dict] = []

    async def reader():
        async for ev in listen.events():
            got.append({**ev, "t": round(time.monotonic() - t0, 2)})
            if ev["event"] == "EndOfTurn":
                return

    t0 = time.monotonic()
    task = asyncio.create_task(reader())
    silence = bytes(FRAME)
    for i in range(0, len(pcm), FRAME):
        await listen.send(pcm[i:i + FRAME].ljust(FRAME, b"\0"))
        await asyncio.sleep(0.08)
    for _ in range(40):
        if task.done():
            break
        await listen.send(silence)
        await asyncio.sleep(0.08)
    await asyncio.wait_for(task, 5)
    await listen.close()
    return got


async def main(text: str) -> None:
    pcm = await synth(text, 16000)
    print(f"tts: {len(pcm)} bytes = {len(pcm) / 32000:.2f}s")
    for ev in await hear(pcm):
        if ev["event"] != "Update":
            print(ev["t"], ev["event"], repr(ev["transcript"]))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "testing one two three"))
