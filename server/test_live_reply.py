"""ReplyFilter: what of a thread's event stream is spoken in Live. The event shapes
are the store's own: message.upsert restating a whole message, part.delta carrying
only a part index."""
from live_reply import ReplyFilter


def up(mid, role, parts, author="agent"):
    return {"type": "message.upsert", "payload": {"message_id": mid, "role": role,
            "author_type": author, "parts": parts}}


def delta(mid, idx, d):
    return {"type": "part.delta", "payload": {"message_id": mid, "idx": idx, "delta": d}}


def said(f, evs):
    out = []
    for e in evs:
        out += [t for k, t in f.feed(e) if k == "say"]
    return "".join(out)


def test_reasoning_delta_is_not_spoken():
    f = ReplyFilter()
    assert said(f, [up("m1", "assistant", [{"type": "reasoning", "text": "The user said"}]),
                    delta("m1", 0, " hello over live voice"),
                    up("m1", "assistant", [{"type": "reasoning", "text": "The user said hello over live voice"}])]) == ""


def test_text_streams_and_restatement_is_not_repeated():
    f = ReplyFilter()
    assert said(f, [up("m2", "assistant", [{"type": "text", "text": "Not sure"}]),
                    delta("m2", 0, " which part."),
                    up("m2", "assistant", [{"type": "text", "text": "Not sure which part."}]),
                    up("m2", "assistant", [{"type": "text", "text": "Not sure which part."}])]) == "Not sure which part."


def test_user_rows_and_runtime_notices_are_not_spoken():
    f = ReplyFilter()
    assert said(f, [up("u1", "user", [{"type": "text", "text": "hello"}], author="human"),
                    up("m3", "assistant", [{"type": "text", "text": "⏩ Steered into current run (iteration 3/60)."}]),
                    delta("m3", 0, " more notice")]) == ""


def test_tool_call_and_idle_are_reported_once():
    f = ReplyFilter()
    acts = f.feed(up("m4", "assistant", [{"type": "tool_call", "name": "calendar"}]))
    acts += f.feed(up("m4", "assistant", [{"type": "tool_call", "name": "calendar"}]))
    acts += f.feed({"type": "run.status", "payload": {"status": "running"}})
    acts += f.feed({"type": "run.status", "payload": {"status": "idle"}})
    assert acts.count(("tool", "")) == 1 and acts[-1] == ("idle", "")


def test_separate_messages_are_space_joined():
    f = ReplyFilter()
    assert said(f, [up("a", "assistant", [{"type": "text", "text": "Checking."}]),
                    up("b", "assistant", [{"type": "text", "text": "Five things."}])]) == "Checking. Five things."


def test_markdown_is_flattened_for_speech():
    f = ReplyFilter()
    assert said(f, [up("m5", "assistant", [{"type": "text", "text": "**Standup** at `10`"}])]) == "Standup at 10"


def test_reasoning_then_text_in_one_message():
    f = ReplyFilter()
    assert said(f, [up("m6", "assistant", [{"type": "reasoning", "text": "think"}]),
                    up("m6", "assistant", [{"type": "reasoning", "text": "think hard"},
                                           {"type": "text", "text": "Sure."}]),
                    delta("m6", 1, " Done.")]) == "Sure. Done."


def test_has_spoken_tracks_this_reply():
    f = ReplyFilter()
    assert not f.has_spoken
    f.feed(up("m7", "assistant", [{"type": "text", "text": "Hi."}]))
    assert f.has_spoken


def test_every_busy_ack_form_is_not_spoken():
    # Hermes's busy acknowledgements: steer, redirect, queue, interrupt.
    for i, head in enumerate(["⏩ Steered into current run", "↪ Redirected current run",
                              "⏳ Queued for the next turn", "⚡ Interrupting current task"]):
        f = ReplyFilter()
        text = f"{head} (iteration 2/60, running: web_search). I'll adjust."
        assert said(f, [up(f"b{i}", "assistant", [{"type": "text", "text": text}])]) == ""


def test_working_heartbeat_is_not_spoken():
    f = ReplyFilter()
    assert said(f, [up("w1", "assistant", [{"type": "text", "text": "⏳ Working — 1 min — iteration 2/60"}])]) == ""
