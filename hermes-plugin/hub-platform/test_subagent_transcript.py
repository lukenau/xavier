"""Offline tests for subagent_transcript.py, against the real state.db shape.

    python3 -m unittest test_subagent_transcript -v
"""

from __future__ import annotations

import importlib
import json
import pathlib
import sqlite3
import sys
import tempfile
import types
import unittest

_HERE = pathlib.Path(__file__).resolve().parent
if "hub_platform" not in sys.modules:
    _pkg = types.ModuleType("hub_platform")
    _pkg.__path__ = [str(_HERE)]
    sys.modules["hub_platform"] = _pkg
st = importlib.import_module("hub_platform.subagent_transcript")

# The columns this reader selects, in the order state.db declares them.
SCHEMA = """
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  role TEXT,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  reasoning TEXT,
  reasoning_content TEXT,
  api_content TEXT,
  active INTEGER DEFAULT 1
)
"""


def db_with(rows) -> str:
    path = tempfile.mkdtemp() + "/state.db"
    conn = sqlite3.connect(path)
    conn.execute(SCHEMA)
    for r in rows:
        cols = ", ".join(r)
        marks = ", ".join("?" * len(r))
        conn.execute(f"INSERT INTO messages ({cols}) VALUES ({marks})", tuple(r.values()))
    conn.commit()
    conn.close()
    return path


def call(name, args, call_id):
    return json.dumps([{"id": call_id, "type": "function", "function": {"name": name, "arguments": args}}])


class TranscriptTests(unittest.TestCase):
    def test_a_childs_turn_reads_back_as_hub_parts(self):
        path = db_with([
            {"session_id": "c1", "role": "user", "content": "Run uname -a", "active": 1},
            {"session_id": "c1", "role": "assistant", "content": "", "reasoning": "check the kernel",
             "tool_calls": call("terminal", '{"command": "uname -a"}', "t1"), "active": 1},
            {"session_id": "c1", "role": "tool", "tool_call_id": "t1", "content": "Linux example-host 6.8.0", "active": 1},
            {"session_id": "c1", "role": "assistant", "content": "Linux 6.8.0 on example-host.", "active": 1},
        ])
        out = st.read("c1", db_path=path)
        self.assertTrue(out["ok"])
        kinds = [p["type"] for p in out["parts"]]
        self.assertEqual(kinds, ["text", "reasoning", "tool_call", "text"])
        tool = out["parts"][2]
        self.assertEqual(tool["tool_name"], "terminal")
        # The result was its own row; it belongs on the call it answers.
        self.assertEqual(tool["result"], "Linux example-host 6.8.0")
        self.assertEqual(tool["status"], "complete")

    def test_the_injected_harness_prompt_is_not_what_the_child_said(self):
        """`api_content` carries thousands of tokens of skill bootstrap. The
        reader must never reach for it."""
        path = db_with([
            {"session_id": "c1", "role": "user", "content": "Find x",
             "api_content": "Find x\n\n<EXTREMELY_IMPORTANT>" + "bootstrap " * 500, "active": 1},
        ])
        out = st.read("c1", db_path=path)
        self.assertEqual(out["parts"], [{"type": "text", "text": "Find x", "role": "user"}])

    def test_another_session_is_not_this_ones_transcript(self):
        path = db_with([
            {"session_id": "c1", "role": "assistant", "content": "mine", "active": 1},
            {"session_id": "c2", "role": "assistant", "content": "not mine", "active": 1},
        ])
        self.assertEqual([p["text"] for p in st.read("c1", db_path=path)["parts"]], ["mine"])

    def test_a_compacted_row_is_not_replayed(self):
        path = db_with([
            {"session_id": "c1", "role": "assistant", "content": "dropped", "active": 0},
            {"session_id": "c1", "role": "assistant", "content": "kept", "active": 1},
        ])
        self.assertEqual([p["text"] for p in st.read("c1", db_path=path)["parts"]], ["kept"])

    def test_long_output_is_bounded_and_flagged(self):
        path = db_with([
            {"session_id": "c1", "role": "assistant", "content": "x" * 9000, "active": 1},
            {"session_id": "c1", "role": "assistant", "tool_calls": call("terminal", "y" * 9000, "t1"), "active": 1},
            {"session_id": "c1", "role": "tool", "tool_call_id": "t1", "content": "z" * 9000, "active": 1},
        ])
        parts = st.read("c1", db_path=path)["parts"]
        self.assertLessEqual(len(parts[0]["text"]), st.MAX_TEXT_CHARS)
        self.assertLessEqual(len(parts[1]["args"]), st.MAX_ARGS_CHARS)
        self.assertLessEqual(len(parts[1]["result"]), st.MAX_RESULT_CHARS)
        self.assertTrue(parts[0]["text"].endswith("…"))

    def test_a_very_long_child_says_it_was_cut(self):
        path = db_with([
            {"session_id": "c1", "role": "assistant", "content": f"m{i}", "active": 1}
            for i in range(st.MAX_MESSAGES + 5)
        ])
        out = st.read("c1", db_path=path)
        self.assertTrue(out["truncated"])
        self.assertEqual(len(out["parts"]), st.MAX_MESSAGES)

    def test_secrets_go_through_the_redactor(self):
        path = db_with([
            {"session_id": "c1", "role": "assistant", "content": "key=sk-live-123", "active": 1},
        ])
        out = st.read("c1", db_path=path, redact=lambda s: s.replace("sk-live-123", "[redacted]"))
        self.assertEqual(out["parts"][0]["text"], "key=[redacted]")

    def test_a_missing_database_is_an_empty_card_not_an_exception(self):
        out = st.read("c1", db_path="/nonexistent/state.db")
        self.assertFalse(out["ok"])
        self.assertEqual(out["parts"], [])

    def test_no_session_id_reads_nothing(self):
        self.assertEqual(st.read("", db_path="/whatever")["parts"], [])

    def test_a_tool_result_with_no_matching_call_is_dropped_rather_than_orphaned(self):
        path = db_with([
            {"session_id": "c1", "role": "tool", "tool_call_id": "gone", "content": "output", "active": 1},
        ])
        self.assertEqual(st.read("c1", db_path=path)["parts"], [])

    def test_malformed_tool_calls_json_does_not_break_the_card(self):
        path = db_with([
            {"session_id": "c1", "role": "assistant", "content": "hi", "tool_calls": "{not json", "active": 1},
        ])
        self.assertEqual([p["type"] for p in st.read("c1", db_path=path)["parts"]], ["text"])


if __name__ == "__main__":
    unittest.main()
