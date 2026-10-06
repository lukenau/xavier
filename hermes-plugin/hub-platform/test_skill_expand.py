"""Tests for skill_expand.py — plain stdlib unittest, no new dependency.

Runnable with any Python 3 (the module under test imports nothing gateway-
side) or with the container's own python — `python3 -m unittest
test_skill_expand -v` from this directory.

Every test uses fakes for `resolve`/`build_one`/`build_stacked`/
`resolve_plugin` rather than the real `agent.skill_commands` functions —
that is the entire point of `expand_midsentence_skills` taking them as
parameters (see that module's docstring). `adapter.py`'s
`expand_midsentence_skill_text` is the thin, gateway-importing glue that
supplies the real callables; it is not exercised here because importing
`adapter.py` requires `gateway.config`/`gateway.platforms.base`, which only
exist inside a running gateway — testing that glue is a gateway-side smoke
check, not a unit test.

FAKE REGISTRY used throughout: only "/brainstorming" and "/daily-briefing"
resolve, "/reset" and "/new" are modeled as builtins (never present in the
fake registry — see `test_builtin_token_never_resolves` for why that
alone is the correct model), "/not-a-skill" is modeled as a plugin-command
collision via `resolve_plugin`, and anything else is simply unknown.
"""

from __future__ import annotations

import unittest
from typing import List, Optional, Tuple

from skill_expand import expand_midsentence_skills


_SKILLS = {"brainstorming": "/brainstorming", "daily-briefing": "/daily-briefing"}


def fake_resolve(command: str) -> Optional[str]:
    """Models `agent.skill_commands.resolve_skill_command_key`.

    Normalizes underscores to hyphens exactly like the real function
    and is a pure membership check against a registry
    that — again exactly like the real one — was already purged of
    builtin-colliding slugs before this function ever runs. "/reset" and
    "/new" are simply absent, standing in for that exclusion.
    """
    return _SKILLS.get(command.replace("_", "-"))


class RecordingBuilders:
    """Fakes for build_one/build_stacked that record every call they see,
    so a test can assert not just the return value but exactly what
    instruction text and cmd_key(s) the module handed over."""

    def __init__(self):
        self.single_calls: List[Tuple[str, str]] = []
        self.stacked_calls: List[Tuple[List[str], str]] = []
        self.single_result: Optional[str] = "SKILL_MSG"
        self.stacked_result: Optional[Tuple[str, List[str], List[str]]] = (
            "STACKED_MSG",
            [],
            [],
        )

    def build_one(self, cmd_key: str, instruction: str) -> Optional[str]:
        self.single_calls.append((cmd_key, instruction))
        return self.single_result

    def build_stacked(self, cmd_keys: List[str], instruction: str):
        self.stacked_calls.append((cmd_keys, instruction))
        return self.stacked_result


def expand(text: str, *, builders: Optional[RecordingBuilders] = None, **kwargs):
    b = builders or RecordingBuilders()
    kwargs.setdefault("resolve", fake_resolve)
    kwargs.setdefault("build_one", b.build_one)
    kwargs.setdefault("build_stacked", b.build_stacked)
    return expand_midsentence_skills(text, **kwargs), b


class MidSentenceSingleSkill(unittest.TestCase):
    def test_skill_mid_sentence(self):
        text = "look at the log retention thing and /brainstorming whether we archive or delete"
        result, b = expand(text)
        self.assertEqual(result, "SKILL_MSG")
        self.assertEqual(len(b.single_calls), 1)
        cmd_key, instruction = b.single_calls[0]
        self.assertEqual(cmd_key, "/brainstorming")
        # Rule 6 (THE SENTENCE SURVIVES): both halves of the sentence
        # remain, token gone, whitespace tidied to one space.
        self.assertEqual(
            instruction,
            "look at the log retention thing and whether we archive or delete",
        )

    def test_skill_at_very_end(self):
        result, b = expand("please just run /daily-briefing")
        self.assertEqual(result, "SKILL_MSG")
        cmd_key, instruction = b.single_calls[0]
        self.assertEqual(cmd_key, "/daily-briefing")
        self.assertEqual(instruction, "please just run")

    def test_token_only_message_instruction_is_empty(self):
        """A message that is ONLY the token.

        Decision: the instruction passed to the builder is the empty
        string, not the token, and not a synthesized placeholder. This
        mirrors `build_skill_invocation_message`'s own
        `user_instruction: str = ""` default — a bare leading-slash
        "/brainstorming" with nothing after it already means "invoke with
        no extra instruction" in the gateway's native path. Treating a
        mid-sentence-only token any
        differently (e.g. refusing to expand, or inventing instruction
        text) would make identical user intent behave inconsistently
        depending on whether the token happened to be the whole message
        or part of a longer one. Rule 6 says the instruction must never be
        empty "when they wrote something" — here they wrote nothing else,
        so empty is the correct, intentional outcome, not a bug.
        """
        result, b = expand("/brainstorming")
        # Guarded by the leading-slash check inside expand_midsentence_skills
        # itself (rule 3, defense in depth) — a message that IS a leading
        # slash command is the gateway's own path, never this one.
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_token_only_message_when_not_leading(self):
        # Same "only the token" case but with leading whitespace so the
        # rule-3 leading-slash guard does not short-circuit it, isolating
        # the empty-instruction behavior itself.
        result, b = expand("  /brainstorming  ")
        # lstrip() still sees a leading "/", so this is STILL treated as a
        # leading-slash message per the module's own (intentionally
        # conservative) rule-3 check — documenting that whitespace-only
        # padding does not create a mid-sentence case.
        self.assertIsNone(result)


class MidSentenceStacked(unittest.TestCase):
    def test_several_stacked(self):
        text = "before we start /brainstorming and also /daily-briefing after lunch"
        result, b = expand(text)
        self.assertEqual(result, "STACKED_MSG")
        self.assertEqual(len(b.stacked_calls), 1)
        cmd_keys, instruction = b.stacked_calls[0]
        self.assertEqual(cmd_keys, ["/brainstorming", "/daily-briefing"])
        self.assertEqual(instruction, "before we start and also after lunch")
        self.assertEqual(b.single_calls, [])

    def test_stacked_without_stacked_builder_honors_first_only(self):
        text = "before we start /brainstorming and also /daily-briefing after lunch"
        b = RecordingBuilders()
        result, _ = expand(text, builders=b, build_stacked=None)
        self.assertEqual(result, "SKILL_MSG")
        self.assertEqual(len(b.single_calls), 1)
        cmd_key, instruction = b.single_calls[0]
        self.assertEqual(cmd_key, "/brainstorming")
        # The second token is left as literal text, unresolved-looking,
        # exactly as if it had never matched at all.
        self.assertIn("/daily-briefing", instruction)

    def test_stacked_builder_returning_none_means_no_change(self):
        b = RecordingBuilders()
        b.stacked_result = None
        result, _ = expand("please do /brainstorming and /daily-briefing", builders=b)
        self.assertIsNone(result)


class Punctuation(unittest.TestCase):
    def test_trailing_comma(self):
        result, b = expand("could you /brainstorming, thanks")
        self.assertEqual(result, "SKILL_MSG")
        cmd_key, instruction = b.single_calls[0]
        self.assertEqual(cmd_key, "/brainstorming")
        # Rule 6 note (also documented in skill_expand._tidy): the comma is
        # deliberately NOT repaired — grammar-guessing is out of scope.
        self.assertEqual(instruction, "could you , thanks")

    def test_parenthesized_token(self):
        result, b = expand("let's do that (/brainstorming) before lunch")
        self.assertEqual(result, "SKILL_MSG")
        cmd_key, instruction = b.single_calls[0]
        self.assertEqual(cmd_key, "/brainstorming")
        self.assertEqual(instruction, "let's do that () before lunch")


class CodeSpans(unittest.TestCase):
    def test_token_in_fenced_block_is_not_expanded(self):
        text = "explain what this does:\n```\n/brainstorming foo\n```\nplease"
        result, b = expand(text)
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_token_in_inline_backticks_is_not_expanded(self):
        result, b = expand("what does `/brainstorming` even do here")
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_token_outside_fence_still_expands_when_another_is_fenced(self):
        text = "run /daily-briefing but don't run `/brainstorming` please"
        result, b = expand(text)
        self.assertEqual(result, "SKILL_MSG")
        cmd_key, instruction = b.single_calls[0]
        self.assertEqual(cmd_key, "/daily-briefing")
        self.assertIn("`/brainstorming`", instruction)


class UnknownAndBuiltinTokens(unittest.TestCase):
    def test_unknown_token_stays_literal(self):
        result, b = expand("try /not-a-real-skill and see what happens")
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_builtin_token_never_resolves(self):
        """Safety rule 1 (SKILLS ONLY, NEVER BUILTINS).

        Modeled the same way the real system guarantees it: `fake_resolve`
        simply has no entry for "reset" or "new", mirroring
        `scan_skill_commands()` excluding any slug colliding with a
        builtin at *scan time* — by the time anything
        calls `resolve`, a builtin name is indistinguishable from an
        unknown one, and this module needs no separate builtin-name list
        of its own for that reason. This test's job is to confirm
        `expand_midsentence_skills` does not special-case "looks like it
        might be a builtin" — it just trusts a `None` return from
        `resolve`, uniformly.
        """
        result, b = expand("please /reset the conversation and /new one after")
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_resolve_raising_is_treated_as_no_match(self):
        def broken_resolve(command: str) -> Optional[str]:
            raise RuntimeError("boom")

        result, b = expand("try /brainstorming please", resolve=broken_resolve)
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])


class PluginCollisionGate(unittest.TestCase):
    def test_resolve_plugin_gate_skips_a_matching_token(self):
        """The residual-gap check: even if `resolve`
        somehow matched a token that also collides with a live plugin
        command, `resolve_plugin` lets the caller veto it before
        `resolve` is even consulted."""

        def always_resolves(command: str) -> Optional[str]:
            return "/brainstorming"

        def plugin_collision(token: str) -> bool:
            return token == "brainstorming"

        result, b = expand(
            "run /brainstorming now",
            resolve=always_resolves,
            resolve_plugin=plugin_collision,
        )
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_resolve_plugin_raising_fails_toward_literal(self):
        def broken_plugin_gate(token: str) -> bool:
            raise RuntimeError("boom")

        result, b = expand("run /brainstorming now", resolve_plugin=broken_plugin_gate)
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])


class LeadingSlashAndUrls(unittest.TestCase):
    def test_leading_slash_message_untouched(self):
        """Safety rule 3 (LEAVE LEADING-SLASH ALONE) — the gateway's own
        `is_command()` path handles this message; this module must be a
        no-op for it, defense in depth against a caller that forgets to
        pre-filter."""
        result, b = expand("/brainstorming what should we build next")
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_leading_slash_with_leading_whitespace_untouched(self):
        result, b = expand("   /brainstorming what should we build next")
        self.assertIsNone(result)

    def test_url_containing_skill_name_is_not_matched(self):
        """A URL slash is not a command slash. Uses a resolver that would
        happily match ANY token, so if the token regex wrongly matched
        inside the URL, this test would catch it via a non-None result —
        the only thing preventing a match here is the regex's lookbehind,
        not the fake resolver being picky."""

        def resolve_anything(command: str) -> Optional[str]:
            return f"/{command}"

        result, b = expand(
            "see https://example.com/brainstorming for the docs",
            resolve=resolve_anything,
        )
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_double_slash_is_not_matched(self):
        def resolve_anything(command: str) -> Optional[str]:
            return f"/{command}"

        result, b = expand("look in //brainstorming/path for it", resolve=resolve_anything)
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])


class AgentSynthesizedText(unittest.TestCase):
    """Safety rule 2 (NEVER on agent-synthesized text).

    `expand_midsentence_skills` itself takes no `allow_gateway_control`
    parameter — it is pure text-in, text-out, with zero notion of who
    produced `text`. That is a deliberate design choice (see the header of
    skill_expand.py): the gate belongs to the caller,
    which is the one place that actually knows whether `event
    .allow_gateway_control` is `True` (human-typed) or `False`
    (agent/plugin-synthesized).

    This test is therefore deliberately a NEGATIVE proof of that division
    of labor: it feeds this function text shaped exactly like
    agent-synthesized prose containing a skill token, with no
    `allow_gateway_control` concept in sight, and confirms the pure
    function expands it anyway — showing that this module provides zero
    protection against rule 2 on its own. That is not a bug in this
    module; it is exactly why `adapter.expand_midsentence_skill_text`
    checks `allow_gateway_control` as its very first line, before this
    function — or even the lazy `agent.skill_commands` import — is ever
    reached. A test that this module refuses agent-synthesized text would
    be testing a guarantee this module was never designed to provide, and
    would misrepresent where the real safety boundary lives.
    """

    def test_pure_function_has_no_agent_synthesized_awareness(self):
        agent_like_text = (
            "Here is a summary of what I found. Next, I will invoke "
            "/brainstorming to explore options."
        )
        result, b = expand(agent_like_text)
        self.assertEqual(result, "SKILL_MSG")
        self.assertEqual(len(b.single_calls), 1)


class EdgeCases(unittest.TestCase):
    def test_empty_text_returns_none(self):
        result, b = expand("")
        self.assertIsNone(result)

    def test_no_slash_at_all_returns_none_cheaply(self):
        result, b = expand("just an ordinary sentence with no commands in it")
        self.assertIsNone(result)
        self.assertEqual(b.single_calls, [])

    def test_build_one_returning_none_means_no_change(self):
        b = RecordingBuilders()
        b.single_result = None
        result, _ = expand("please run /brainstorming now", builders=b)
        self.assertIsNone(result)

    def test_build_one_raising_means_no_change(self):
        def broken_build_one(cmd_key: str, instruction: str) -> Optional[str]:
            raise RuntimeError("boom")

        result, _ = expand("please run /brainstorming now", build_one=broken_build_one)
        self.assertIsNone(result)

    def test_max_skills_caps_the_scan(self):
        text = "note: " + " ".join("/brainstorming" for _ in range(10)) + " and /daily-briefing"
        b = RecordingBuilders()
        result, _ = expand(text, builders=b, max_skills=2)
        self.assertEqual(result, "STACKED_MSG")
        cmd_keys, _instruction = b.stacked_calls[0]
        self.assertEqual(len(cmd_keys), 2)


if __name__ == "__main__":
    unittest.main()
