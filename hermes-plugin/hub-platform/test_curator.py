"""The background skills review is filed as one "Skills curator" card, not posted into the chat.

    python3 -m unittest test_curator -v
"""

from __future__ import annotations

import importlib
import os
import pathlib
import sys
import tempfile
import types
import unittest

# The observer log goes to a scratch directory, never a real Hermes home.
os.environ.setdefault("HUB_PLATFORM_OBSERVER_DIR", tempfile.mkdtemp(prefix="hub-platform-test-"))

_HERE = pathlib.Path(__file__).resolve().parent
if "hub_platform" not in sys.modules:
    _pkg = types.ModuleType("hub_platform")
    _pkg.__path__ = [str(_HERE)]
    sys.modules["hub_platform"] = _pkg

curator = importlib.import_module("hub_platform.curator")
hooks = importlib.import_module("hub_platform.hooks")
runtime = importlib.import_module("hub_platform.runtime")

CHAT = "20260101_090000_a1b2c3:0f1e2d3c"
FORK = "123e4567-e89b-42d3-a456-426614174000:4b5a6978"
# What a v0.21 gateway writes: the thread's session first, then the session again
# for a chat turn or the review fork's own uuid, then a hash.
CHAT3 = "20260101_090000_a1b2c3:20260101_090000_a1b2c3:0f1e2d3c"
FORK3 = "20260101_090000_a1b2c3:123e4567-e89b-42d3-a456-426614174000:4b5a6978"


class FakeQueue:
    def __init__(self) -> None:
        self.posts: list[tuple[str, dict]] = []

    def enqueue(self, path: str, body: dict) -> bool:
        self.posts.append((path, body))
        return True


class Curator(unittest.TestCase):
    def setUp(self) -> None:
        self.queue = FakeQueue()
        self._saved = (runtime.queue, runtime.hub_thread_for_session, runtime.redact)
        runtime.queue = self.queue
        runtime.hub_thread_for_session = lambda sid: "thr_abc"
        runtime.redact = lambda text: text
        curator._held.clear()

    def tearDown(self) -> None:
        runtime.queue, runtime.hub_thread_for_session, runtime.redact = self._saved

    def test_the_three_segment_shapes_a_v021_gateway_writes(self):
        self.assertFalse(curator.is_review_turn(CHAT3))
        self.assertTrue(curator.is_review_turn(FORK3))

    def test_a_three_segment_review_is_kept_out_of_the_thread(self):
        call = dict(session_id="s1", tool_call_id="t", tool_name="skill_manage", args={}, result="ok", duration_ms=1, status="ok")
        self.assertFalse(hooks._forward_tool_call({**call, "turn_id": FORK3}))
        self.assertTrue(hooks._forward_tool_call({**call, "turn_id": CHAT3}))
        self.assertEqual(1, len(self.queue.posts))
        hooks._on_stream_delta(surface="hub", session_id="s1", turn_id=FORK3, kind="text", delta="x" * 5000)
        self.assertEqual(1, len(self.queue.posts))

    def test_the_two_run_shapes_the_store_holds(self):
        self.assertFalse(curator.is_review_turn(CHAT))
        self.assertTrue(curator.is_review_turn(FORK))
        self.assertFalse(curator.is_review_turn(""))
        self.assertFalse(curator.is_review_turn(None))

    def test_a_review_tool_call_is_not_forwarded_and_a_chat_one_is(self):
        call = dict(session_id="s1", tool_call_id="t", tool_name="skill_manage", args={}, result="ok", duration_ms=1, status="ok")
        self.assertFalse(hooks._forward_tool_call({**call, "turn_id": FORK}))
        self.assertEqual([], self.queue.posts)
        self.assertTrue(hooks._forward_tool_call({**call, "turn_id": CHAT}))
        self.assertEqual(1, len(self.queue.posts))

    def test_a_review_stream_end_posts_nothing_and_holds_its_words(self):
        hooks._on_stream_end(surface="hub", session_id="s1", turn_id=FORK, final_text="Updated `cron-automation`.", finished=True)
        self.assertEqual([], self.queue.posts)
        text = curator.card_text("s1", "💾 Self-improvement review: Skill 'cron-automation' patched.")
        self.assertEqual("💾 Self-improvement review: Skill 'cron-automation' patched.\n\nUpdated `cron-automation`.", text)

    def test_a_chat_stream_end_still_settles_its_rows(self):
        hooks._on_stream_end(surface="hub", session_id="s1", turn_id=CHAT, final_text="hello", finished=True)
        self.assertTrue(self.queue.posts)

    def test_a_review_delta_is_not_streamed_into_the_thread(self):
        hooks._on_stream_delta(surface="hub", session_id="s1", turn_id=FORK, kind="text", delta="x" * 5000)
        self.assertEqual([], self.queue.posts)

    def test_a_summary_with_nothing_held_is_just_the_summary(self):
        self.assertEqual("💾 Self-improvement review: x", curator.card_text("s9", "💾 Self-improvement review: x"))

    def test_only_the_summary_line_is_recognised(self):
        self.assertTrue(curator.is_summary("  💾 Self-improvement review: Skill 'a' created."))
        self.assertFalse(curator.is_summary("Self-improvement review notes for you"))

    def test_held_text_is_bounded(self):
        for i in range(curator.MAX_HELD + 10):
            curator.hold(f"s{i}", "x")
        self.assertEqual(curator.MAX_HELD, len(curator._held))


if __name__ == "__main__":
    unittest.main()
