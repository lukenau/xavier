"""The stream-end hook that settles the rows a stream wrote.

The end-of-session reflection turn streams its text and never calls send(), so
without this hook its row stayed `streaming` under a spinning ring with the
reply cut mid-sentence.

    python3 -m unittest test_stream_end -v
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

hooks = importlib.import_module("hub_platform.hooks")
runtime = importlib.import_module("hub_platform.runtime")
from hub_platform.hub_client import CLOSE_PATH, DELIVER_PATH, STREAM_PATH  # noqa: E402


class FakeQueue:
    def __init__(self, accept: bool = True) -> None:
        self.posts: list[tuple[str, dict]] = []
        self.accept = accept

    def enqueue(self, path: str, body: dict) -> bool:
        self.posts.append((path, body))
        return self.accept


class StreamEndTests(unittest.TestCase):
    def setUp(self) -> None:
        self.queue = FakeQueue()
        self._real_queue = runtime.queue
        self._real_lookup = runtime.hub_thread_for_session
        self._real_turns = runtime.turns
        # The real redactor imports the gateway, which is not here.
        self._real_redact = runtime.redact
        runtime.redact = lambda text: text
        runtime.queue = self.queue
        runtime.hub_thread_for_session = lambda sid: {"s1": "thr_abc"}.get(sid)

        class Turns:
            def __init__(self):
                self.tails = {"reasoning": "", "text": ""}

            def take_stream_text(self, session_id, kind="text"):
                tail, self.tails[kind] = self.tails[kind], ""
                return tail or None

        self.turns = Turns()
        runtime.turns = self.turns

    def tearDown(self) -> None:
        runtime.queue = self._real_queue
        runtime.hub_thread_for_session = self._real_lookup
        runtime.turns = self._real_turns
        runtime.redact = self._real_redact

    def end(self, **over):
        kw = {"surface": "hub", "session_id": "s1", "turn_id": "t1", "final_text": "The answer.",
              "finished": True, "error": None}
        kw.update(over)
        hooks._on_stream_end(**kw)

    def paths(self):
        return [p for p, _ in self.queue.posts]

    def test_the_streams_text_lands_whole_and_the_run_is_closed(self):
        self.end()
        self.assertEqual(self.paths(), [DELIVER_PATH, CLOSE_PATH])
        deliver = self.queue.posts[0][1]
        self.assertEqual(deliver["run_id"], "t1")
        self.assertEqual(deliver["status"], "complete")
        self.assertEqual([p["text"] for p in deliver["parts"] if p["type"] == "text"], ["The answer."])
        self.assertEqual(self.queue.posts[1][1], {"thread_id": "thr_abc", "run_id": "t1"})

    def test_buffered_tails_go_out_before_the_final(self):
        # The last <48 chars of a stream sat in the buffer for ever.
        self.turns.tails["text"] = "ends here."
        self.turns.tails["reasoning"] = "and so on"
        self.end()
        self.assertEqual(self.paths(), [STREAM_PATH, STREAM_PATH, DELIVER_PATH, CLOSE_PATH])
        self.assertEqual({p["kind"]: p["delta"] for _, p in self.queue.posts[:2]},
                         {"reasoning": "and so on", "text": "ends here."})

    def test_a_stream_with_no_prose_only_closes(self):
        # Reasoning and tool calls, then nothing said — the memory review's shape.
        self.end(final_text="")
        self.assertEqual(self.paths(), [CLOSE_PATH])

    def test_an_interrupted_stream_still_settles_what_it_said(self):
        self.end(finished=False, error="interrupted", final_text="Half a th")
        self.assertEqual(self.paths(), [DELIVER_PATH, CLOSE_PATH])

    def test_another_surface_is_not_the_hubs_business(self):
        self.end(surface="discord")
        self.assertEqual(self.queue.posts, [])

    def test_no_turn_id_means_nothing_to_close(self):
        self.end(turn_id="")
        self.assertEqual(self.queue.posts, [])

    def test_a_turn_that_streams_again_after_an_end_is_still_carried(self):
        """on_stream_end fires once per LLM stream, and a turn has one per tool
        round, so one turn can end three times, seconds apart. A guard that
        treated the first end as terminal dropped every delta of the streams
        that followed — losing reply text, which is the one thing this surface
        must never do."""
        runtime.turns = importlib.import_module("hub_platform.turns").TurnTracker()
        self.end()
        self.queue.posts.clear()
        hooks._on_stream_delta(surface="hub", session_id="s1", turn_id="t1", delta="and then more. " * 6, kind="text")
        self.assertEqual(self.paths(), [STREAM_PATH])

    def test_it_is_registered_and_session_end_is_not(self):
        registered = []

        class Ctx:
            def register_hook(self, name, fn):
                registered.append(name)

        hooks.register_hooks(Ctx())
        self.assertIn("on_stream_end", registered)
        self.assertNotIn("on_session_end", registered)


if __name__ == "__main__":
    unittest.main()
