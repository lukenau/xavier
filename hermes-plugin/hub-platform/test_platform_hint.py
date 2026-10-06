"""Offline tests for platform_hint.py.
    python3 -m unittest test_platform_hint -v
"""

from __future__ import annotations

import json
import unittest

from platform_hint import PLATFORM_HINT


class HintTests(unittest.TestCase):
    def test_it_points_schedule_questions_at_the_calendar(self):
        # Without this a "what's my schedule" question is answered in prose.
        self.assertIn("schedule", PLATFORM_HINT)
        self.assertIn("`calendar`", PLATFORM_HINT)

    def test_it_says_to_use_components_unprompted(self):
        self.assertIn("WITHOUT being asked", PLATFORM_HINT)

    def test_the_example_call_has_name_at_the_top_level(self):
        """Models kept nesting `name` inside `arguments`, and every such
        `tool_call` failed. The example the model copies must be the correct
        shape and must be valid JSON."""
        lines = [line for line in PLATFORM_HINT.splitlines() if line.startswith('{"name": "hub_widget"')]
        self.assertEqual(len(lines), 1, "exactly one hub_widget example expected")
        call = json.loads(lines[0])
        self.assertEqual(call["name"], "hub_widget")
        self.assertNotIn("name", call["arguments"])
        self.assertEqual(call["arguments"]["kind"], "calendar")

    def test_questions_go_to_clarify_not_a_widget(self):
        self.assertIn("`clarify`", PLATFORM_HINT)

    def test_it_stays_a_hint_not_a_manual(self):
        """It rides in every Hub session's system prompt, so it has a budget."""
        self.assertLess(len(PLATFORM_HINT), 2600)


if __name__ == "__main__":
    unittest.main()
