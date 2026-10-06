# SPDX-License-Identifier: MIT
"""Pure mid-sentence skill-token expansion — zero gateway imports.

WHY THIS EXISTS
----------------
The gateway only treats a message as a command when the slash is the very
first character of the whole message: `MessageEvent.is_command()` is
literally `allow_gateway_control and text.lstrip().startswith("/")`
(verified against v0.21.5). A skill token written anywhere else in a
sentence — "look at the retention thing and /brainstorming whether we
archive or delete" — reaches the model as ordinary prose and the skill
never fires. This module is the pure-logic half of the fix: find a
`/skill-token` anywhere in a human-typed message, resolve it against the
SKILL registry ONLY (never a builtin, never a plugin command), and hand the
caller everything needed to rebuild the message exactly the way the
gateway's own leading-slash skill-dispatch block does
(`build_skill_invocation_message` / `build_stacked_skill_invocation_message`
in `agent/skill_commands.py`).

This file imports nothing from `gateway.*` or `agent.*` — the resolver and
both builders are passed in as callables, so it is unit-testable with
fakes (see `test_skill_expand.py`) and can never itself break on a
gateway upgrade. The caller (`adapter.py`) owns every safety gate that
requires knowing this is gateway/Hub code: whether the text is
human-typed at all (`allow_gateway_control`), whether it already starts
with a slash (the gateway's own, better-handled path), and the lazy
import of the real `agent.skill_commands` functions.

WHAT WOULD BREAK THIS ON A GATEWAY UPGRADE
-------------------------------------------
Nothing in *this* file imports gateway code, so an upgrade cannot break
it by raising an ImportError here. What CAN silently change the
*behavior* this module relies on, even though the module keeps running:
  - `resolve_skill_command_key` semantics changing so it starts matching
    a builtin or a plugin command too. This module trusts whatever
    `resolve` callable it is given completely — it has no independent
    builtin/plugin-name knowledge. Today that trust is well-founded
    because `scan_skill_commands()` excludes any slug colliding with a
    builtin *at scan time*, so membership in the
    registry `resolve_skill_command_key` checks already implies "not a
    builtin." If that scan-time exclusion is ever removed, this module's
    "skills only, never builtins" guarantee silently stops holding, with
    no error anywhere.
  - `build_skill_invocation_message` / `build_stacked_skill_invocation_message`
    changing their "return falsy on failure" contract to something else
    (e.g. raising instead of returning `None`). This module treats a
    falsy builder return as "leave the message unmodified," mirroring
    the gateway's own fallback for an unbuildable skill. A raise from
    either builder propagates straight
    up out of `expand_midsentence_skills` uncaught by design — the caller
    decides whether to catch it (adapter.py does, so a gateway change
    here degrades to "no expansion," not a broken turn).
"""

from __future__ import annotations

import re
from typing import Callable, List, Optional, Sequence, Tuple

# A candidate token is "/" + at least one letter, then letters/digits/
# underscore/hyphen. The lookbehind rejects a "/" that is itself preceded
# by a word character, ".", or another "/" — which is exactly what keeps
# this from firing inside a URL ("https://example.com/brainstorming": the
# "/" before "brainstorming" is preceded by "m", a word character) or a
# doubled "//" ("https://foo": the second "/" is preceded by the first
# "/"). It intentionally does NOT require the preceding character to be
# whitespace — "(/brainstorming)" must still match with "(" immediately
# before the slash (one of the required test cases), and "(" is neither a
# word character, ".", nor "/".
_TOKEN_RE = re.compile(r"(?<![\w./])/([A-Za-z][\w-]*)")

# Skip spans: a fenced block is found first (so an inline single backtick
# that happens to sit inside one is never separately re-matched), then
# inline `...` spans not already covered by a fenced span.
_FENCED_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_RE = re.compile(r"`[^`\n]+`")

# Mirrors `agent/skill_commands.py`'s own `_MAX_STACKED_SKILLS = 5` total
# (1 "first" + up to 4 more) — not imported (this module imports nothing
# gateway-side), just matched as a documented default so a mid-sentence
# stack cannot grow unboundedly long in one message.
DEFAULT_MAX_SKILLS = 5


def _code_spans(text: str) -> List[Tuple[int, int]]:
    spans = [m.span() for m in _FENCED_RE.finditer(text)]
    for m in _INLINE_RE.finditer(text):
        start, end = m.span()
        if not any(a <= start and end <= b for a, b in spans):
            spans.append((start, end))
    return spans


def _in_any_span(pos: int, spans: Sequence[Tuple[int, int]]) -> bool:
    return any(a <= pos < b for a, b in spans)


def _tidy(text: str) -> str:
    """Collapse whitespace left behind by removing a token span.

    Deliberately whitespace-only. Removing "/brainstorming" from "please
    /brainstorming, thanks" leaves "please , thanks" — the stray comma is
    NOT stripped. Attempting to also repair the surrounding punctuation
    (was it a comma separating clauses? part of a list? trailing a
    quote?) is a grammar-guessing problem with no safe general answer;
    getting it wrong risks silently mangling the very sentence rule 6
    exists to protect. Whitespace collapse is the one tidy-up that is
    always unambiguously correct.
    """
    return re.sub(r"[ \t]+", " ", text).strip()


def expand_midsentence_skills(
    text: str,
    *,
    resolve: Callable[[str], Optional[str]],
    build_one: Callable[[str, str], Optional[str]],
    build_stacked: Optional[
        Callable[[List[str], str], Optional[Tuple[str, List[str], List[str]]]]
    ] = None,
    resolve_plugin: Optional[Callable[[str], object]] = None,
    max_skills: int = DEFAULT_MAX_SKILLS,
) -> Optional[str]:
    """Rewrite `text` if it contains one or more mid-sentence skill tokens.

    Returns the rewritten message body (what `gateway/run.py` puts into
    `event.text` on a native leading-slash skill dispatch) or `None` when
    nothing should change. `None` is the common case — no candidate token,
    nothing resolves, a resolved token's builder itself returned falsy —
    and this function is built to make that path cheap: a plain string
    scan and a couple of early returns before any copying happens.

    Parameters
    ----------
    resolve(command_without_slash) -> Optional[cmd_key]
        The ONLY authority this function trusts for "is this a skill."
        Pass `agent.skill_commands.resolve_skill_command_key` (or a fake
        for tests). Because that function's registry already excludes
        every builtin-colliding slug at scan time (see module docstring),
        this parameter is what makes "never a builtin" true by
        construction — this module does not separately special-case
        builtin names.
    build_one(cmd_key, instruction) -> Optional[str]
        `agent.skill_commands.build_skill_invocation_message` partially
        applied by the caller (e.g. with `task_id` bound via a closure).
    build_stacked(cmd_keys, instruction) -> Optional[(msg, loaded, missing)]
        `agent.skill_commands.build_stacked_skill_invocation_message`,
        likewise partially applied. Optional: if omitted and more than one
        token resolves, only the first resolved token is honored and every
        other candidate is left as literal text (as if it had never
        resolved) — see the inline comment at the call site for why this
        is the safer default over refusing the whole message.
    resolve_plugin(command_without_slash) -> truthy
        Optional extra gate. `resolve_skill_command_key`'s registry is
        proven never to contain a builtin (excluded at scan time) but is
        NOT checked against live plugin-registered commands. Pass
        `hermes_cli.plugins.get_plugin_command_handler` (already
        hyphen-normalized by the caller) to also skip a token that
        happens to collide with a plugin command. Omit (default `None`)
        to skip this check — safe only while no skill slug collides with
        a plugin command, which nothing guarantees.
    max_skills
        Cap on how many mid-sentence tokens one message can stack:
        default matches the gateway's own leading-slash stack cap.
    """
    if not text:
        return None

    # Safety rule 3 (LEAVE LEADING-SLASH ALONE), enforced again here as
    # defense in depth: the caller is expected to skip calling this
    # function at all for a message the gateway's own `is_command()`
    # would already dispatch, but repeating the (cheap) check closes the
    # gap if a caller ever forgets.
    if text.lstrip().startswith("/"):
        return None

    if "/" not in text:
        return None

    code_spans = _code_spans(text)
    resolved: List[Tuple[int, int, str]] = []  # (start, end, cmd_key)

    for match in _TOKEN_RE.finditer(text):
        if len(resolved) >= max_skills:
            break
        start, end = match.span()
        if _in_any_span(start, code_spans):
            # Safety rule 4 (NOT INSIDE CODE) — being discussed, not
            # invoked.
            continue
        token = match.group(1)
        if resolve_plugin is not None:
            try:
                if resolve_plugin(token):
                    continue
            except Exception:
                # A broken plugin-lookup must never turn into "treat this
                # as a skill" — fail toward leaving it literal.
                continue
        try:
            cmd_key = resolve(token)
        except Exception:
            continue
        if not cmd_key:
            # Safety rule 1 (builtins, by construction of `resolve`) and
            # safety rule 5 (UNKNOWN TOKENS STAY LITERAL) both land here:
            # neither is distinguishable from the other at this layer,
            # and neither needs to be — both mean "leave it as text."
            continue
        resolved.append((start, end, cmd_key))

    if not resolved:
        return None

    if len(resolved) > 1 and build_stacked is None:
        # The caller offered no stacking builder. Refusing the whole
        # message here would throw away a token the caller DID ask us to
        # expand just because a second one also happened to appear;
        # instead, honor the first (leftmost, i.e. first-typed) resolved
        # token exactly as if the message had contained only it, and
        # leave every other candidate untouched as literal text — the
        # same outcome as if it simply hadn't resolved.
        resolved = resolved[:1]

    instruction = text
    for start, end, _cmd_key in reversed(resolved):
        instruction = instruction[:start] + instruction[end:]
    instruction = _tidy(instruction)
    # Safety rule 6 (THE SENTENCE SURVIVES): `instruction` is now the
    # user's full message with only the matched skill token(s) removed —
    # never the raw text with tokens still embedded, and empty only when
    # the user's message truly contained nothing else (see
    # test_skill_expand.py's "token-only message" case for why an empty
    # instruction is the correct, intentional outcome there, not a bug).

    if len(resolved) == 1:
        cmd_key = resolved[0][2]
        try:
            msg = build_one(cmd_key, instruction)
        except Exception:
            return None
        return msg or None

    cmd_keys = [r[2] for r in resolved]
    try:
        result = build_stacked(cmd_keys, instruction)
    except Exception:
        return None
    if not result:
        return None
    msg = result[0]
    return msg or None
