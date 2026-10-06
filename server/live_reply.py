"""What of a thread's event stream is spoken aloud in Live.

Only assistant `text` parts are spoken. A `part.delta` carries a part INDEX,
not its type, so the type of every (message, idx) is learned from the
message.upsert that introduces it, and a delta on a reasoning part is dropped:
the agent's thinking is never read out. Upserts re-state a message, so only
the suffix past what was already spoken is emitted."""
import re
from typing import Any

# Hermes posts its busy acknowledgements (⏩ steer, ↪ redirect, ⏳ queue,
# ⚡ interrupt) and its ⏳ working heartbeats as ordinary assistant text.
_NOTICE = re.compile(r"^\s*[⏩↪⏳⚡]")
_MARKDOWN = re.compile(r"[*_`#>]+")


class ReplyFilter:
    def __init__(self) -> None:
        self._kinds: dict[tuple[str, int], str] = {}
        self._spoken: dict[tuple[str, int], str] = {}
        self._muted: set[str] = set()
        self.has_spoken = False

    def mute_seen(self) -> None:
        """Nothing more from any message seen so far is spoken or counted: the
        user has said something new, and a reply to what came before (which can
        keep streaming for a while after being cut off) is stale."""
        self._muted.update(mid for mid, _ in self._kinds)

    def _new_text(self, key: tuple[str, int], full: str) -> str:
        prev = self._spoken.get(key)
        if prev is None and _NOTICE.match(full):
            self._kinds[key] = "notice"
            return ""
        prev = prev or ""
        if not full.startswith(prev):
            return ""
        self._spoken[key] = full
        return full[len(prev):]

    def _say(self, text: str, opens_part: bool) -> list[tuple[str, str]]:
        text = _MARKDOWN.sub("", text)
        if not text:
            return []
        if opens_part and self.has_spoken and not text[:1].isspace():
            text = " " + text
        self.has_spoken = True
        return [("say", text)]

    def feed(self, ev: dict[str, Any]) -> list[tuple[str, str]]:
        p = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
        etype = ev.get("type")
        if etype == "run.status":
            return [("idle", "")] if p.get("status") == "idle" else []
        mid = p.get("message_id")
        if not isinstance(mid, str) or mid in self._muted:
            return []
        out: list[tuple[str, str]] = []
        if etype == "message.upsert":
            if p.get("role") != "assistant" or p.get("author_type") not in (None, "agent"):
                return []
            for idx, part in enumerate(p.get("parts") or []):
                if not isinstance(part, dict):
                    continue
                key = (mid, idx)
                kind = self._kinds.setdefault(key, part.get("type") or "")
                if kind == "tool_call" and key not in self._spoken:
                    self._spoken[key] = ""
                    out.append(("tool", ""))
                elif kind == "text":
                    opens = key not in self._spoken
                    new = self._new_text(key, part.get("text") or "")
                    if new and self._kinds[key] == "text":
                        out += self._say(new, opens)
        elif etype == "part.delta":
            key = (mid, int(p.get("idx") or 0))
            if self._kinds.get(key) == "text":
                opens = key not in self._spoken
                new = self._new_text(key, self._spoken.get(key, "") + (p.get("delta") or ""))
                if new and self._kinds[key] == "text":
                    out += self._say(new, opens)
        return out
