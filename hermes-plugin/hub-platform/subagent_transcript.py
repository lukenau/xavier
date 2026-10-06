# SPDX-License-Identifier: MIT
"""What a subagent actually did, read back out of the gateway's own state.

The subagent card in the app can be opened to show the child's own text and
tool calls, the way a terminal agent UI lets you open a subagent's window.

The card on the phone is built from the two lifecycle hooks, which carry a
role, a goal, a status and a summary — everything the child did in between is
dropped: `post_tool_call` fires for a child's tools but its session maps to no
Hub thread, and `on_stream_delta` never fires for a child at all (measured on
a running gateway). So the transcript is not reconstructable from the event
stream; it has to be read where it already exists.

It exists in `state.db`: every agent session, child ones included, writes its
messages there. This reads that table READ-ONLY, for one session id, and
returns the same `parts` shape the Hub already renders — so the app needs no
new renderer, just somewhere to put them.

Two things are deliberately dropped. `api_content` is the model-facing copy of
a message, carrying the whole injected skill bootstrap — thousands of tokens of
harness text that is not what the child said; `content` is. And a tool result
is bounded hard: this is a card someone opens out of curiosity, not an export.
"""

from __future__ import annotations

import json
import os
import sqlite3
from typing import Any, Callable, Dict, List, Optional

from . import paths

STATE_DB = os.environ.get("HERMES_STATE_DB") or paths.under_home("state.db")
# A subagent that ran 400 tools is not going to be read to the end on a phone.
MAX_MESSAGES = 200
MAX_TEXT_CHARS = 4000
MAX_ARGS_CHARS = 1200
MAX_RESULT_CHARS = 2000


def _clip(value: Any, limit: int, redact: Optional[Callable[[str], str]] = None) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    if redact is not None:
        text = redact(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _tool_calls(raw: Any) -> List[Dict[str, Any]]:
    """`messages.tool_calls` is JSON text in the provider's own shape."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    return [c for c in raw if isinstance(c, dict)] if isinstance(raw, list) else []


def parts_from_rows(rows: List[Dict[str, Any]], redact: Optional[Callable[[str], str]] = None) -> List[Dict[str, Any]]:
    """The child's messages, in the Hub's own part shapes.

    A tool result arrives as its own row keyed by `tool_call_id`, so results are
    folded onto the call they answer rather than listed separately — the card
    shows one row per tool call, the way the main transcript does.
    """
    parts: List[Dict[str, Any]] = []
    by_call_id: Dict[str, Dict[str, Any]] = {}

    for row in rows:
        role = str(row.get("role") or "")
        content = row.get("content")
        if role == "tool":
            call_id = str(row.get("tool_call_id") or "")
            target = by_call_id.get(call_id)
            if target is not None:
                target["result"] = _clip(content, MAX_RESULT_CHARS, redact)
                target["status"] = "complete"
            continue

        reasoning = row.get("reasoning") or row.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning.strip():
            parts.append({"type": "reasoning", "text": _clip(reasoning, MAX_TEXT_CHARS, redact)})

        if isinstance(content, str) and content.strip():
            parts.append({"type": "text", "text": _clip(content, MAX_TEXT_CHARS, redact), "role": role})

        for call in _tool_calls(row.get("tool_calls")):
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            call_id = str(call.get("id") or "")
            part = {
                "type": "tool_call",
                "tool_call_id": call_id,
                "tool_name": str(fn.get("name") or call.get("name") or "tool"),
                "args": _clip(fn.get("arguments") if fn else call.get("arguments"), MAX_ARGS_CHARS, redact),
                "status": "running",
            }
            parts.append(part)
            if call_id:
                by_call_id[call_id] = part

    return parts


def read(session_id: str, db_path: Optional[str] = None,
         redact: Optional[Callable[[str], str]] = None) -> Dict[str, Any]:
    """The transcript of one session, or an empty one when there is nothing.

    Read-only and never raises: a card that cannot be filled says so, and the
    turn that asked for it carries on.
    """
    if not session_id:
        return {"ok": False, "error": "no_session", "parts": []}
    path = db_path or STATE_DB
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT role, content, tool_call_id, tool_calls, reasoning, reasoning_content "
                    "FROM messages WHERE session_id=? AND active=1 ORDER BY id LIMIT ?",
                    (session_id, MAX_MESSAGES + 1),
                )
            ]
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return {"ok": False, "error": "unreadable", "detail": str(exc)[:200], "parts": []}

    truncated = len(rows) > MAX_MESSAGES
    return {
        "ok": True,
        "session_id": session_id,
        "truncated": truncated,
        "parts": parts_from_rows(rows[:MAX_MESSAGES], redact),
    }
