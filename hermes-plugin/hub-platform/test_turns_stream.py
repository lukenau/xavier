"""The delta buffer — the thing standing between one token and one HTTP post."""
import unittest

from turns import TurnTracker


class StreamBuffering(unittest.TestCase):
    def setUp(self):
        self.t = TurnTracker()

    def test_holds_tokens_until_the_chunk_is_worth_sending(self):
        self.t.add_stream_text("s1", "t1", "opening", flush_at=48)  # the fast opener
        for token in ["He", "llo", " there"]:
            self.assertIsNone(self.t.add_stream_text("s1", "t1", token, flush_at=48))
        chunk = self.t.add_stream_text("s1", "t1", "x" * 40, flush_at=48)
        self.assertEqual(chunk, "Hello there" + "x" * 40)
        # …and the buffer starts over rather than resending what already went.
        self.assertIsNone(self.t.add_stream_text("s1", "t1", "next", flush_at=48))

    def test_flushes_early_on_a_sentence_or_line_end(self):
        self.assertEqual(self.t.add_stream_text("s1", "t1", "Done. ", flush_at=48), "Done. ")
        self.assertEqual(self.t.add_stream_text("s1", "t1", "Line\n", flush_at=48), "Line\n")

    def test_a_new_turn_never_inherits_the_last_one_s_tail(self):
        self.t.add_stream_text("s1", "t1", "opener", flush_at=48)
        self.t.add_stream_text("s1", "t1", "half a sentence", flush_at=48)
        # A new turn's own first chunk leaves at once, and carries none of t1.
        self.assertEqual(self.t.add_stream_text("s1", "t2", "new one", flush_at=48), "new one")

    def test_take_drains_once(self):
        self.t.add_stream_text("s1", "t1", "opener", flush_at=48)
        self.t.add_stream_text("s1", "t1", "tail", flush_at=48)
        self.assertEqual(self.t.take_stream_text("s1"), "tail")
        self.assertIsNone(self.t.take_stream_text("s1"))

    def test_ignores_nothing_useful(self):
        self.assertIsNone(self.t.add_stream_text("", "t1", "x", flush_at=48))
        self.assertIsNone(self.t.add_stream_text("s1", "t1", "", flush_at=48))

    def test_reasoning_and_text_buffers_do_not_bleed_into_each_other(self):
        self.t.add_reasoning("s1", "t1", "thinking about it")
        self.t.add_stream_text("s1", "t1", "opener", flush_at=48)  # past the fast first chunk
        self.t.add_stream_text("s1", "t1", "saying it", flush_at=48)
        self.assertEqual(self.t.take_reasoning("s1"), "thinking about it")
        self.assertEqual(self.t.take_stream_text("s1"), "saying it")

    def test_thinking_and_speech_keep_separate_buffers_within_a_turn(self):
        self.t.add_stream_text("s1", "t1", "opening", flush_at=48, kind="reasoning")
        self.t.add_stream_text("s1", "t1", "opening", flush_at=48, kind="text")
        self.t.add_stream_text("s1", "t1", "half a thought", flush_at=48, kind="reasoning")
        self.t.add_stream_text("s1", "t1", "half a word", flush_at=48, kind="text")
        self.assertEqual(self.t.take_stream_text("s1", "reasoning"), "half a thought")
        self.assertEqual(self.t.take_stream_text("s1", "text"), "half a word")

    def test_a_new_turn_clears_both_kinds(self):
        self.t.add_stream_text("s1", "t1", "old think", flush_at=48, kind="reasoning")
        self.t.add_stream_text("s1", "t1", "old speech", flush_at=48, kind="text")
        self.t.add_stream_text("s1", "t2", "new", flush_at=48, kind="text")
        self.assertIsNone(self.t.take_stream_text("s1", "reasoning"))
        self.assertEqual(self.t.take_stream_text("s1", "text"), "new")


if __name__ == "__main__":
    unittest.main()


class FirstFlush(unittest.TestCase):
    def setUp(self):
        self.t = TurnTracker()

    def test_the_first_chunk_of_a_turn_leaves_almost_at_once(self):
        # It is what flips the phone from "sent — waiting" to "working".
        self.assertEqual(self.t.add_stream_text("s", "t1", "Alright", flush_at=48), "Alright")

    def test_and_then_it_settles_into_full_chunks(self):
        self.t.add_stream_text("s", "t1", "Alright", flush_at=48)
        self.assertIsNone(self.t.add_stream_text("s", "t1", "more text", flush_at=48))

    def test_each_kind_gets_its_own_fast_first_chunk(self):
        self.assertEqual(self.t.add_stream_text("s", "t1", "hmm ok", flush_at=48, kind="reasoning"), "hmm ok")
        self.assertEqual(self.t.add_stream_text("s", "t1", "Answer", flush_at=48, kind="text"), "Answer")

    def test_a_new_turn_is_fast_again(self):
        self.t.add_stream_text("s", "t1", "Alright", flush_at=48)
        self.assertEqual(self.t.add_stream_text("s", "t2", "Next up", flush_at=48), "Next up")
