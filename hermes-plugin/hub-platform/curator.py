# SPDX-License-Identifier: MIT
"""The background skills review is not part of the conversation it reviewed.

The gateway runs it as a fork of the session, in the same thread: without this
its tool calls, its working text and a closing "Self-improvement review" line
all land in the chat, one wall of text under whatever the user had just asked.
The fork is told apart by its turn id, which has THREE segments. A chat turn is
`<session>:<session>:<hash>` (`20260101_090000_a1b2c3:20260101_090000_a1b2c3:0f1e2d3c`);
the fork's middle segment is its own fresh uuid, with the thread's session still in
front (`20260101_090000_a1b2c3:123e4567-e89b-42d3-a456-426614174000:4b5a6978`).
Its output is filed once, as a run of the "Skills curator" job: the closing line is
the summary, its text the body.

Real reviews carry the uuid second; a uuid first is accepted too, in case a
gateway build names it that way.
"""

from __future__ import annotations

import re
import threading
from typing import Dict, Optional

JOB_ID = "skills-curator"
SUMMARY_PREFIX = "\U0001f4be Self-improvement review:"
MAX_CHARS = 16_000
MAX_HELD = 64

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# A uuid as the first segment, or as the second behind the parent's session.
_FORK_TURN = re.compile(rf"^(?:{_UUID}|[^:]+:{_UUID}):")

_held: Dict[str, str] = {}
_lock = threading.Lock()


def is_review_turn(turn_id: Optional[str]) -> bool:
    return bool(turn_id) and _FORK_TURN.match(turn_id) is not None


def is_summary(text: str) -> bool:
    return text.lstrip().startswith(SUMMARY_PREFIX)


def hold(session_id: str, text: str) -> None:
    """Keep the review's own words until its summary line arrives."""
    if not session_id or not text.strip():
        return
    with _lock:
        _held.pop(session_id, None)
        _held[session_id] = text.strip()[:MAX_CHARS]
        while len(_held) > MAX_HELD:
            _held.pop(next(iter(_held)))


def card_text(session_id: Optional[str], summary: str) -> str:
    with _lock:
        body = _held.pop(session_id, "") if session_id else ""
    summary = summary.strip()
    return f"{summary}\n\n{body}" if body and body not in summary else summary
