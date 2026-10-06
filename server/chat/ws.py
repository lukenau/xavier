"""The Hub chat WebSocket — VERDICT-V2 §4.1, §9. One connection, N per-thread
subscriptions, cookie-authed IN-HANDLER exactly like `/terminal/ws` (app.py
~5645-5651): `@app.middleware("http")` never runs on a WebSocket scope, so there is
no other place this auth could live.

WIRE PROTOCOL (client -> server): `{"type": "subscribe", "thread_id": ..., "after_seq": ...}`
per thread the client wants to hear about. Nothing else is defined yet — no
`unsubscribe`, no server-bound `send` (a human write goes through the WebAuthn/
device-key-gated `/api/chat/approval/*` and, for plain messages, a future gated
route; this socket is read-only from the client's side today).

WIRE PROTOCOL (server -> client): one JSON object per frame, `{seq, thread_id, type,
...rest}` for a thread event (`message.upsert` / `part.delta` / `part.upsert` /
`attention.upsert` / `thread.patch` / `approval.answered` — this module doesn't
special-case event types, it forwards whatever the store's event log holds), or
a connection-level `{"type": "heartbeat"}` with no `seq`/`thread_id` (see below), or
`{"seq", "thread_id", "type": "snapshot_required"}` when a thread's requested cursor
is older than the event log retains, or `{"type": "synced", "thread_id", "seq"}` once
a subscribe's replay is complete — the client's sign that it is current as of `seq`.

ORDER. A thread's frames leave this connection in seq order, from one writer at a
time: a subscribe's replay and the poll loop's tail take the same lock around
read-cursor → send → write-cursor. A replay drains the log to the present before
it says `synced`; it is never cut at one batch.

REPLAY, NOT PUSH. hub-api's store has no in-process pub/sub — `events` is a table,
not a queue. Each subscription is served by polling `list_events_after` on an
interval (`HUB_CHAT_WS_POLL_INTERVAL_S`, default 1s): cheap (SQLite, indexed,
in-process) and avoids inventing a broadcast mechanism the store's own docstring
never asked for. A future slice that needs sub-second delivery (streaming deltas)
can shorten the interval or add a real notify path without changing this wire
protocol.

SNAPSHOT_REQUIRED. `ChatStore.earliest_event_seq` reports the lowest surviving seq
for a thread's event log. A `subscribe{after_seq}` is a gap — the client has missed
events `prune_events` has already deleted — when `after_seq` is behind the thread's
`last_seq` AND behind (surviving-earliest - 1). On a gap we do not replay a partial,
silently-holed history; we tell the client to resync via the REST read routes
(`chat/routes.py`) and treat the subscription as caught up to `last_seq` until the
client re-subscribes with a fresh cursor.

HEARTBEAT vs SNAPSHOT_REQUIRED/thread events — a DESIGN CALL the plan states as a
requirement ("the plan makes that distinction load-bearing") but does not shape:
heartbeat is emitted at the CONNECTION level, not per-thread — there is no seq or
thread_id that means anything for "the socket is alive." It fires whenever a poll
tick sends nothing else, on `HUB_CHAT_WS_HEARTBEAT_INTERVAL_S` (default 15s), so a
client that stops receiving anything — heartbeat included — for longer than that
knows it's stalled rather than merely quiet.

REVOCATION ON A LIVE SOCKET — the second design call the plan doesn't spell out.
`chat/session.py`'s whole reason to exist over the terminal's copy-paste is that
`/api/chat/logout` revokes immediately, not at TTL. That guarantee is hollow if an
already-open socket, authenticated once at `ws.accept()`-time, keeps streaming for
the rest of the connection's life after logout. So the poll loop re-checks
`chat_session_valid(token)` every tick (same cheap dict lookup as the initial check)
and closes 1008 the moment the cookie is gone — expired OR revoked, same code path,
same message the initial handshake would have used.

Client-vanishing / cleanup: mirrors `/terminal/ws`'s two-task-plus-`asyncio.wait`
shape exactly (client_to_upstream/upstream_to_client there, receive/poll here) — the
first task to end (disconnect, revoked cookie, unhandled error) cancels its sibling
in `finally`, so neither a receive-loop nor a poll-loop can outlive the socket.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from chat.platform import get_store
from chat.session import chat_session_valid

router = APIRouter(prefix="/api/chat", tags=["hub-chat-ws"])

POLL_INTERVAL_S = float(os.environ.get("HUB_CHAT_WS_POLL_INTERVAL_S", "1.0"))
HEARTBEAT_INTERVAL_S = float(os.environ.get("HUB_CHAT_WS_HEARTBEAT_INTERVAL_S", "15.0"))
MAX_THREAD_ID_LEN = 64
REPLAY_BATCH = 500


def _event_frame(thread_id: str, ev: dict[str, Any]) -> dict[str, Any]:
    return {"seq": ev["seq"], "thread_id": thread_id, "type": ev["type"], **ev["payload"]}


@router.websocket("/ws")
async def chat_ws(ws: WebSocket) -> None:
    """Accept iff `hub_chat_session` is valid right now; replay + poll per-thread
    subscriptions until the client disconnects, the cookie is revoked/expires, or an
    unrecoverable error ends one side of the pair."""
    token = ws.cookies.get("hub_chat_session")
    if not chat_session_valid(token):
        # Accept FIRST, then close: a close before accept is not a WebSocket frame
        # at all — uvicorn answers the upgrade with HTTP 403, the phone's socket
        # reports 1006, and the app (which re-locks only on 1008) retries forever.
        # Seen live 2026-09-22 00:42 UTC after the hour-long session expired.
        # Starlette's TestClient reports 1008 either way, which is why the suite
        # never caught it.
        await ws.accept()
        await ws.close(code=1008)  # policy violation
        return
    await ws.accept()

    store = get_store()
    # thread_id -> how far into the log this connection has read for it. In-
    # process, per-connection state — nothing here survives a reconnect; the
    # client's own `after_seq` on each `subscribe` is what makes reconnect
    # resumable.
    cursors: dict[str, int] = {}
    # Two things write a thread's frames — a subscribe's replay and the poll
    # loop's tail — and they used to run at once: the poll loop copied a cursor,
    # awaited its way through a batch and wrote the cursor back after a
    # subscribe had already replayed the same range. `part.delta` is the one
    # frame that must not arrive twice, so every overlap appended the same words
    # again ("Found the job. Let me read…" three times in one bubble — the user,
    # 2026-09-28). One lock around read-cursor → send → write-cursor, for both.
    pump_lock = asyncio.Lock()
    # Starlette's send is not safe to call from two tasks at once; the heartbeat
    # is sent outside `pump_lock`, so the socket itself keeps its own lock.
    send_lock = asyncio.Lock()

    async def send_json(frame: dict[str, Any]) -> None:
        async with send_lock:
            await ws.send_json(frame)

    async def pump(thread_id: str, after_seq: int) -> int:
        """Send every event after `after_seq`, in order, all of it — batch after
        batch until a scan comes back empty — and return how far the log was
        read. A replay used to stop at one batch of 500 and leave the rest to
        the next poll tick, which is a reply arriving as its first words, a
        pause, then the rest. Caller holds `pump_lock`."""
        cursor = after_seq
        while True:
            events, scanned_to = store.scan_events_after(thread_id, cursor, limit=REPLAY_BATCH)
            for ev in events:
                await send_json(_event_frame(thread_id, ev))
            if scanned_to <= cursor:
                return cursor
            cursor = scanned_to

    async def handle_subscribe(msg: dict[str, Any]) -> None:
        thread_id = msg.get("thread_id")
        after_seq = msg.get("after_seq", 0)
        if not isinstance(thread_id, str) or not (1 <= len(thread_id) <= MAX_THREAD_ID_LEN):
            return
        if not isinstance(after_seq, int) or after_seq < 0:
            after_seq = 0
        thread = store.get_thread(thread_id)
        if thread is None:
            # Unknown thread_id: read routes never lazily create one, and neither
            # does this socket — nothing to subscribe to, nothing to send back.
            return
        async with pump_lock:
            min_seq = store.earliest_event_seq(thread_id)
            gap = after_seq < thread["last_seq"] and (min_seq is None or after_seq < min_seq - 1)
            if gap:
                await send_json({"seq": thread["last_seq"], "thread_id": thread_id, "type": "snapshot_required"})
                cursors[thread_id] = thread["last_seq"]
                return
            # From where the client says it is, even when this connection has
            # already sent further: a client that has just applied a snapshot
            # asks from that snapshot's version on purpose, and its own version
            # gates make anything it already holds a no-op.
            # The pump drains to the present, so what it reached IS the log's
            # end — taking the higher of it and the old cursor only mattered
            # when the log had moved backwards (a restore), and then it left
            # this thread's poll stuck above every new event.
            reached = await pump(thread_id, after_seq)
            cursors[thread_id] = reached
            await send_json({"type": "synced", "thread_id": thread_id, "seq": reached})

    async def receive_loop() -> None:
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                text = msg.get("text")
                if text is None:
                    continue
                try:
                    parsed = json.loads(text)
                except ValueError:
                    continue
                if isinstance(parsed, dict) and parsed.get("type") == "subscribe":
                    await handle_subscribe(parsed)
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def poll_loop() -> None:
        last_sent_at = time.monotonic()
        try:
            while True:
                await asyncio.sleep(POLL_INTERVAL_S)
                if not chat_session_valid(token):
                    await ws.close(code=1008)
                    return
                sent_any = False
                for thread_id in list(cursors):
                    async with pump_lock:
                        cursor = cursors.get(thread_id)
                        if cursor is None:
                            continue
                        reached = await pump(thread_id, cursor)
                        if reached > cursor:
                            cursors[thread_id] = reached
                            sent_any = True
                now = time.monotonic()
                if sent_any:
                    last_sent_at = now
                elif now - last_sent_at >= HEARTBEAT_INTERVAL_S:
                    await send_json({"type": "heartbeat"})
                    last_sent_at = now
        except (WebSocketDisconnect, RuntimeError):
            pass

    t_recv = asyncio.create_task(receive_loop())
    t_poll = asyncio.create_task(poll_loop())
    try:
        await asyncio.wait({t_recv, t_poll}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (t_recv, t_poll):
            t.cancel()
        try:
            await ws.close()
        except (RuntimeError, WebSocketDisconnect):
            # Already closed by the peer (or by the latest send): closing again raises.
            # Expected on a client that disconnects first; not an error worth a traceback.
            pass
