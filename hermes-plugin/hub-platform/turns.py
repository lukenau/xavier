# SPDX-License-Identifier: MIT
"""Per-session turn state shared by hooks.py (writers) and adapter.py (reader).

The gateway gives the hooks a ``session_id`` and a ``turn_id``; ``send()`` only
knows the ``session_key``. This is the small, locked, bounded map that lets the
final assistant text land under the same ``run_id`` as the tool cards that
preceded it, and lets reasoning deltas ride along with the next card or the
final text instead of needing a streaming transport hub-api does not have.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

# Enough to prove something is happening, not so little that a one-token reply
# costs a round trip per character.
FIRST_FLUSH_CHARS = 6

_NOT_CACHED = object()


class TurnTracker:
    def __init__(self, max_sessions: int = 512, max_reasoning_chars: int = 16000):
        self._max = max_sessions
        self._max_reasoning = max_reasoning_chars
        self._lock = threading.Lock()
        self._turns: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._threads: "OrderedDict[str, Optional[str]]" = OrderedDict()

    # -- turn / reasoning ---------------------------------------------------------
    def _entry(self, session_id: str) -> Dict[str, Any]:
        entry = self._turns.get(session_id)
        if entry is None:
            entry = {"turn_id": None, "reasoning": []}
            self._turns[session_id] = entry
            while len(self._turns) > self._max:
                self._turns.popitem(last=False)
        else:
            self._turns.move_to_end(session_id)
        return entry

    def note_turn(self, session_id: str, turn_id: Optional[str]) -> None:
        if not session_id:
            return
        with self._lock:
            entry = self._entry(session_id)
            if turn_id and entry["turn_id"] != turn_id:
                entry["turn_id"] = turn_id
                entry["reasoning"] = []

    def add_reasoning(self, session_id: str, turn_id: Optional[str], delta: str) -> None:
        if not session_id or not delta:
            return
        with self._lock:
            entry = self._entry(session_id)
            if turn_id and entry["turn_id"] != turn_id:
                entry["turn_id"] = turn_id
                entry["reasoning"] = []
            buf = entry["reasoning"]
            total = sum(len(x) for x in buf)
            if total >= self._max_reasoning:
                return
            buf.append(delta[: self._max_reasoning - total])

    def take_reasoning(self, session_id: str) -> Optional[str]:
        if not session_id:
            return None
        with self._lock:
            entry = self._turns.get(session_id)
            if not entry or not entry["reasoning"]:
                return None
            text = "".join(entry["reasoning"])
            entry["reasoning"] = []
            return text

    def turn(self, session_id: str) -> Optional[str]:
        if not session_id:
            return None
        with self._lock:
            entry = self._turns.get(session_id)
            return entry["turn_id"] if entry else None

    def end_turn(self, session_id: str) -> None:
        if not session_id:
            return
        with self._lock:
            self._turns.pop(session_id, None)

    # -- outbound text, batched --------------------------------------------------
    def add_stream_text(
        self, session_id: str, turn_id: Optional[str], delta: str, *, flush_at: int, kind: str = "text"
    ) -> Optional[str]:
        """Accumulate an assistant text delta; return a chunk to send when it is
        worth sending. The gateway emits a delta per token — 321 of them for one
        short reply — and one HTTP POST per token would be a pathological way to
        spend a turn. Flushing on a sentence boundary or `flush_at` characters
        keeps the text arriving in readable pieces without the traffic."""
        if not session_id or not delta:
            return None
        with self._lock:
            entry = self._entry(session_id)
            if turn_id and entry["turn_id"] != turn_id:
                entry["turn_id"] = turn_id
                entry["reasoning"] = []
                for k in [k for k in entry if k.startswith("buf:") or k.startswith("sent:")]:
                    entry[k] = [] if k.startswith("buf:") else False
            # One buffer per kind: thinking and speech interleave within a turn
            # and must not be spliced into each other's part.
            key = f"buf:{kind}"
            buf = entry.setdefault(key, [])
            buf.append(delta)
            joined = "".join(buf)
            # The FIRST chunk of a kind goes out almost at once: it is what turns
            # "sent — waiting" into "working" on the phone, and waiting a full
            # buffer for it left a grey dot sitting there for seconds while the
            # gateway was already busy. After that, full chunks.
            sent_key = f"sent:{kind}"
            threshold = FIRST_FLUSH_CHARS if not entry.get(sent_key) else flush_at
            if len(joined) >= threshold or delta.endswith("\n") or delta.endswith(". "):
                entry[key] = []
                entry[sent_key] = True
                return joined
            return None

    def take_stream_text(self, session_id: str, kind: str = "text") -> Optional[str]:
        """Whatever is still buffered — for the end of a turn."""
        with self._lock:
            entry = self._turns.get(session_id)
            key = f"buf:{kind}"
            if not entry or not entry.get(key):
                return None
            joined = "".join(entry[key])
            entry[key] = []
            return joined or None

    # -- session_id -> hub thread cache -------------------------------------------
    def cache_thread(self, session_id: str, thread_id: Optional[str]) -> None:
        with self._lock:
            self._threads[session_id] = thread_id
            self._threads.move_to_end(session_id)
            while len(self._threads) > self._max:
                self._threads.popitem(last=False)

    def cached_thread(self, session_id: str) -> Tuple[bool, Optional[str]]:
        """(cached?, thread_id). ``(True, None)`` is a positive 'not a Hub session'."""
        with self._lock:
            if session_id in self._threads:
                self._threads.move_to_end(session_id)
                return True, self._threads[session_id]
            return False, None

    def forget_thread(self, session_id: str) -> None:
        with self._lock:
            self._threads.pop(session_id, None)
