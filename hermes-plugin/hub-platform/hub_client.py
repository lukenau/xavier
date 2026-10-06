# SPDX-License-Identifier: MIT
"""Hub server HTTP client and the non-blocking delivery queue. stdlib only.

Two callers, two contracts:

* ``adapter.py``'s ``send*()`` methods need the RESULT (a ``SendResult`` must say
  whether the message landed), so they call ``HubApiClient.post`` directly, off
  the event loop via ``asyncio.to_thread``.
* ``hooks.py`` runs on the hot path of every tool call on every platform and
  may never block or raise, so it only ever ``DeliveryQueue.enqueue``s — O(1),
  bounded, drop-oldest — and one daemon thread does the posting.

Every request carries ``Authorization: Bearer <HUB_PLATFORM_KEY>``, the same key
the hub checks on ``/api/platform/hub/*`` and presents back on the gateway's
``/api/platforms/hub/events``. ``HubApiClient.key`` says where it comes from;
nothing here ever caches or logs its value.
"""

from __future__ import annotations

import collections
import http.client
import json
import logging
import os
import queue
import threading
import time
import urllib.parse
import uuid
from typing import Any, Dict, Optional, Tuple

from . import paths

logger = logging.getLogger(__name__)

_LOCAL = threading.local()

DEFAULT_BASE_URL = "http://127.0.0.1:8090"
DEFAULT_KEY_FILE = paths.under_home("hub-platform", "HUB_PLATFORM_KEY")
DELIVER_PATH = "/api/platform/hub/deliver"
MEDIA_PATH = "/api/platform/hub/media"
COMMANDS_PATH = "/api/platform/hub/commands"
STREAM_PATH = "/api/platform/hub/stream"
# Settles whatever a thread left streaming when its session ends.
CLOSE_PATH = "/api/platform/hub/close"
# Closes approval cards whose wait has ended without an answer from the Hub.
SETTLE_PATH = "/api/platform/hub/approvals/settle"


def _parse(raw: bytes) -> Dict[str, Any]:
    try:
        data = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
    except ValueError:
        return {"error": "non_json_response"}
    return data if isinstance(data, dict) else {"data": data}


class HubApiClient:
    def __init__(self, base_url: Optional[str] = None, key_file: Optional[str] = None, timeout: float = 5.0):
        self.base_url = (base_url or os.environ.get("HUB_API_BASE") or DEFAULT_BASE_URL).rstrip("/")
        self.key_file = key_file or os.environ.get("HUB_PLATFORM_KEY_FILE") or None
        self.timeout = timeout

    def key(self) -> str:
        """The shared secret, looked up on every call.

        A configured key file (``HUB_PLATFORM_KEY_FILE``) wins and is re-read each
        time, so a rotation needs no restart. Without one, ``HUB_PLATFORM_KEY``
        from the environment (Hermes loads ``$HERMES_HOME/.env`` into it); without
        that, the file ``$HERMES_HOME/hub-platform/HUB_PLATFORM_KEY``. Empty means
        unprovisioned, and every caller then fails closed."""
        if not self.key_file:
            from_env = os.environ.get("HUB_PLATFORM_KEY", "").strip()
            if from_env:
                return from_env
        try:
            with open(self.key_file or DEFAULT_KEY_FILE, "r", encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""

    def _connection(self, *, fresh: bool = False) -> http.client.HTTPConnection:
        """One kept-alive connection per calling thread.

        `urllib.request` opens and tears down a TCP connection per call. A
        reasoning-heavy turn posts hundreds of stream chunks through one queue
        thread, and measured against a real hub that handshake was half the
        round trip — 11.4ms per POST against 6.5ms on a kept-alive socket, which
        is four seconds of queue backlog over a 300-chunk turn, enough for tool
        cards and the working indicator to lag behind the text."""
        cache = getattr(_LOCAL, "conns", None)
        if cache is None:
            cache = _LOCAL.conns = {}
        conn = cache.pop(self.base_url, None) if fresh else cache.get(self.base_url)
        if fresh and conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            conn = None
        if conn is None:
            parts = urllib.parse.urlsplit(self.base_url)
            factory = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
            conn = factory(parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80),
                           timeout=self.timeout)
            cache[self.base_url] = conn
        return conn

    def post(self, path: str, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        """Returns (http_status, parsed_body). Status 0 means the request never got
        an HTTP answer (no key, unreachable, timeout); the dict then carries a
        short fixed ``error`` code — never exception text, which can embed URLs.

        A 4xx/5xx is a normal return here, not an exception — `http.client` does
        not raise on status the way `urlopen` did."""
        key = self.key()
        if not key:
            return 0, {"error": "hub_platform_key_unprovisioned"}
        payload = json.dumps(body, default=str).encode("utf-8")
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        detail = "unknown"
        # Twice: a kept-alive socket the server has since closed fails on use,
        # not on idle, so the first attempt is the one that discovers it.
        for attempt in (0, 1):
            conn = self._connection(fresh=attempt == 1)
            try:
                conn.request("POST", path, body=payload, headers=headers)
                resp = conn.getresponse()
                return resp.status, _parse(resp.read())
            except Exception as exc:
                detail = type(exc).__name__
                try:
                    conn.close()
                except Exception:
                    pass
                getattr(_LOCAL, "conns", {}).pop(self.base_url, None)
        return 0, {"error": "unreachable", "detail": detail}

    def deliver(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self.post(DELIVER_PATH, body)

    def media(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self.post(MEDIA_PATH, body)

    def commands(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self.post(COMMANDS_PATH, body)


_STOP = object()
_IDEMPOTENT_PATHS = (DELIVER_PATH, STREAM_PATH, CLOSE_PATH, SETTLE_PATH)


class _Waiter:
    """The caller of `post_in_order`, parked until the queue thread has posted
    its item — or dropped it."""

    __slots__ = ("done", "result")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Tuple[int, Dict[str, Any]] = (0, {"error": "queue_timeout"})

    def resolve(self, result: Tuple[int, Dict[str, Any]]) -> None:
        self.result = result
        self.done.set()


class DeliveryQueue:
    """One daemon thread, one bounded FIFO, drop-oldest when full.

    Drop-oldest rather than drop-newest: when hub-api is down for a while the
    freshest tool cards are the ones worth keeping once it is back, and the
    bound keeps memory flat however long that outage lasts. Every drop is
    counted and surfaced in ``stats()`` — never silent.
    """

    def __init__(self, client: HubApiClient, maxsize: int = 256, *, start: bool = True):
        self._client = client
        self._q: "queue.Queue[Any]" = queue.Queue(maxsize=maxsize)
        # Holds the one item a coalescing drain looked at and decided not to
        # merge. Only the queue thread touches it.
        self._pushback: "collections.deque[Any]" = collections.deque()
        # The waiter of the item `_next` last handed out, for `_run` to answer.
        self._waiter: Optional[_Waiter] = None
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._autostart = start
        self._sent = 0
        self._failed = 0
        self._dropped = 0
        self._last_status: Optional[int] = None
        self._last_warn = 0.0
        self._idle = threading.Event()
        self._idle.set()

    def enqueue(self, path: str, body: Dict[str, Any]) -> bool:
        return self._put(path, body, None)

    def post_in_order(
        self, path: str, body: Dict[str, Any], timeout: float = 10.0
    ) -> Tuple[int, Dict[str, Any]]:
        """Post from the queue's own thread, in FIFO order, and wait for the
        answer. A widget posted straight through the client overtook the deltas
        of the text that introduced it — the turn's words were still queued
        here. A caller that stops waiting leaves its item in place:
        it is still posted, just not reported."""
        waiter = _Waiter()
        if not self._put(path, body, waiter):
            return 0, {"error": "queue_full"}
        waiter.done.wait(timeout)
        return waiter.result

    def _put(self, path: str, body: Dict[str, Any], waiter: Optional[_Waiter]) -> bool:
        if path in _IDEMPOTENT_PATHS and not body.get("delivery_id"):
            # The client sends again on a fresh socket when a kept-alive one
            # fails on use: the same body, so the same id, and hub-api answers
            # the repeat from its record instead of applying it twice.
            body["delivery_id"] = uuid.uuid4().hex
        item = (path, body, waiter)
        try:
            self._q.put_nowait(item)
        except queue.Full:
            try:
                self._drop(self._q.get_nowait())
            except queue.Empty:
                pass
            try:
                self._q.put_nowait(item)
            except queue.Full:
                self._drop(item)
                return False
        self._idle.clear()
        if self._autostart:
            self._ensure_thread()
        return True

    def _drop(self, item: Any) -> None:
        self._dropped += 1
        if item is not _STOP and item[2] is not None:
            item[2].resolve((0, {"error": "queue_full"}))

    def _ensure_thread(self) -> None:
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="hub-platform-delivery", daemon=True)
                self._thread.start()

    def _next(self) -> Any:
        """The next thing to post, with any stream deltas queued behind it for the
        same part folded into it.

        Under load the queue drains slower than the gateway fills it, and every
        item behind the backlog — a tool card, the end of a turn — waits for all
        of it. Merging the deltas that are ALREADY waiting costs nothing (they
        would have been concatenated on arrival anyway) and turns a growing
        backlog into a self-limiting one."""
        item = self._pushback.popleft() if self._pushback else self._q.get()
        if item is _STOP:
            return item
        path, first, waiter = item
        self._waiter = waiter
        # An in-order post is answered as itself: never folded into a batch,
        # and never a batch's head.
        if path != STREAM_PATH or waiter is not None:
            return (path, first)
        merged = dict(first)
        while True:
            try:
                nxt = self._pushback.popleft() if self._pushback else self._q.get_nowait()
            except queue.Empty:
                break
            if (
                nxt is _STOP
                or nxt[0] != STREAM_PATH
                or nxt[2] is not None
                or any(nxt[1].get(k) != merged.get(k) for k in ("thread_id", "run_id", "kind"))
            ):
                self._pushback.append(nxt)
                break
            merged["delta"] = (merged.get("delta") or "") + (nxt[1].get("delta") or "")
            self._q.task_done()
        return (path, merged)

    def _run(self) -> None:
        while True:
            item = self._next()
            if item is _STOP:
                self._q.task_done()
                break
            path, body = item
            waiter, self._waiter = self._waiter, None
            try:
                status, data = self._client.post(path, body)
                if status == 422 and "delivery_id" in body and "delivery_id" in json.dumps(data):
                    # A hub from before delivery ids refuses the field
                    # outright. Delivered without it beats not at all.
                    status, data = self._client.post(path, {k: v for k, v in body.items() if k != "delivery_id"})
            except Exception as exc:  # the client is written not to raise; belt and braces
                status, data = 0, {"error": "client_exception", "detail": type(exc).__name__}
            if waiter is not None:
                waiter.resolve((status, data))
            self._last_status = status
            if 200 <= status < 300:
                self._sent += 1
            else:
                self._failed += 1
                now = time.monotonic()
                if now - self._last_warn > 60:
                    self._last_warn = now
                    logger.warning(
                        "hub-platform delivery to %s failed: status=%s error=%s (failed=%d dropped=%d; further failures at debug for 60s)",
                        path, status, data.get("error") or data.get("detail") or "-", self._failed, self._dropped,
                    )
                else:
                    logger.debug("hub-platform delivery to %s failed: status=%s", path, status)
            self._q.task_done()
            if self._q.empty() and not self._pushback:
                self._idle.set()

    def wait_idle(self, timeout: float = 5.0) -> bool:
        """Test/shutdown aid: block until every queued item has been attempted."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._q.empty() and not self._pushback and self._idle.wait(0.05):
                return True
        return self._q.empty() and not self._pushback

    def stop(self, timeout: float = 2.0) -> None:
        if self._thread is not None and self._thread.is_alive():
            self._q.put(_STOP)
            self._thread.join(timeout)

    def stats(self) -> Dict[str, Any]:
        return {
            "queued": self._q.qsize(),
            "sent": self._sent,
            "failed": self._failed,
            "dropped": self._dropped,
            "last_status": self._last_status,
        }

    # test aid: what is waiting, in order, without consuming it
    def _pending(self):
        with self._q.mutex:
            return [(item[0], item[1]) for item in self._q.queue if item is not _STOP]
