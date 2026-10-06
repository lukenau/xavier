"""Offline tests for hub_wire.py — any Python 3, no gateway imports.
    python3 -m unittest test_hub_wire -v
"""

from __future__ import annotations

import unittest

import hub_wire as w


class SessionKeys(unittest.TestCase):
    def test_roundtrip(self):
        self.assertEqual(w.session_key_for_thread("ops"), "agent:main:hub:dm:ops")
        self.assertEqual(w.thread_id_from_session_key("agent:main:hub:dm:ops"), "ops")
        self.assertEqual(w.thread_id_from_session_key("agent:main:hub:dm:thr_ab-1"), "thr_ab-1")

    def test_only_exact_dm_keys_map_back(self):
        for key in (None, "", "agent:main:discord:dm:1", "agent:main:hub:group:x",
                    "agent:main:hub:dm:", "agent:main:hub:dm:a:b", "agent:coder:hub:dm:ops",
                    "agent:main:hub:dm:" + "x" * 65):
            self.assertIsNone(w.thread_id_from_session_key(key), key)

    def test_thread_kind(self):
        self.assertEqual(w.thread_kind("brief"), "brief")
        self.assertEqual(w.thread_kind("thr_x"), "chat")


class Bounded(unittest.TestCase):
    def test_truncates_with_marker(self):
        out = w.bounded("a" * 50, 10)
        self.assertTrue(out.startswith("a" * 10))
        self.assertIn("[truncated 40 chars]", out)

    def test_redacts_before_truncating(self):
        out = w.bounded("sk-SECRET" + "x" * 100, 20, redact=lambda t: t.replace("sk-SECRET", "[R]"))
        self.assertNotIn("SECRET", out)
        self.assertTrue(out.startswith("[R]"))

    def test_non_strings_are_json(self):
        self.assertEqual(w.bounded({"a": 1}, 100), '{"a": 1}')

    def test_redactor_failure_withholds_content(self):
        def boom(_):
            raise RuntimeError("x")
        self.assertIn("withheld", w.bounded("secret", 100, redact=boom))


class Builders(unittest.TestCase):
    def test_text_message(self):
        m = w.text_message("ops", "hello", run_id="t1", session_id="s1")
        self.assertEqual(m["thread_id"], "ops")
        self.assertEqual(m["kind"], "ops")
        self.assertEqual(m["role"], "assistant")
        self.assertEqual(m["status"], "complete")
        self.assertEqual(m["run_id"], "t1")
        self.assertEqual(m["hermes_session_id"], "s1")
        self.assertEqual(m["parts"], [{"type": "text", "text": "hello"}])
        self.assertNotIn("attention", m)

    def test_reasoning_rides_first(self):
        m = w.text_message("chat", "answer", reasoning="thinking…")
        self.assertEqual([p["type"] for p in m["parts"]], ["reasoning", "text"])
        m = w.text_message("chat", "answer", reasoning="   ")
        self.assertEqual([p["type"] for p in m["parts"]], ["text"])

    def test_cron_run_id_carried(self):
        m = w.text_message("cron", "brief", cron_run_id="cr1")
        self.assertEqual(m["cron_run_id"], "cr1")

    def test_image_message(self):
        m = w.image_message("chat", media_id="med_1", mime="image/png", caption="cap")
        self.assertEqual(m["parts"][0], {"type": "image", "media_id": "med_1", "mime": "image/png"})
        self.assertEqual(m["parts"][1], {"type": "text", "text": "cap"})
        m = w.image_message("chat", url="https://x/y.png")
        self.assertEqual(m["parts"], [{"type": "image", "url": "https://x/y.png"}])
        with self.assertRaises(ValueError):
            w.image_message("chat")

    def test_file_message_says_where_the_bytes_are(self):
        m = w.file_message("chat", name="report.pdf", path="/srv/hermes/x/report.pdf", mime="application/pdf")
        self.assertEqual(m["parts"][0], {"type": "file", "name": "report.pdf", "mime": "application/pdf"})
        self.assertIn("/srv/hermes/x/report.pdf", m["parts"][1]["text"])

    def test_tool_call_ok(self):
        m = w.tool_call_message("ops", tool_call_id="c1", tool_name="terminal", args={"command": "ls"},
                                result="a\nb", duration_ms=12, status="success", run_id="t1", session_id="s1")
        p = m["parts"][0]
        self.assertEqual(p["type"], "tool_call")
        self.assertEqual(p["status"], "complete")
        self.assertEqual(p["args"], '{"command": "ls"}')
        self.assertEqual(p["result"], "a\nb")
        self.assertEqual(p["duration_ms"], 12)
        self.assertNotIn("error", p)

    def test_tool_call_error_and_redaction(self):
        red = lambda t: t.replace("hunter2", "[R]")
        m = w.tool_call_message("ops", tool_call_id="c1", tool_name="terminal", args={"command": "echo hunter2"},
                                result="hunter2 leaked", status="error", error_type="Timeout",
                                error_message="took hunter2 too long", redact=red)
        p = m["parts"][0]
        self.assertEqual(p["status"], "error")
        self.assertEqual(p["error"], "Timeout took [R] too long")
        self.assertNotIn("hunter2", str(m))

    def test_tool_call_empty_args_result_are_null(self):
        p = w.tool_call_message("ops", tool_call_id="c", tool_name="t", args={}, result="")["parts"][0]
        self.assertIsNone(p["args"])
        self.assertIsNone(p["result"])

    def test_approval_message(self):
        m = w.approval_message("chat", request_id="r1", run_id="t1", command="rm -rf /tmp/x",
                               description="deletes", choices=["once", "deny"])
        p = m["parts"][0]
        self.assertEqual(p["state"], "approval_requested")
        self.assertEqual(p["choices"], ["once", "deny"])
        self.assertEqual(p["tool_call_id"], "r1")
        self.assertEqual(m["attention"], {"kind": "approval", "request_id": "r1", "run_id": "t1",
                                          "summary": "terminal: rm -rf /tmp/x"})
        self.assertNotIn("smart_denied", p)
        m = w.approval_message("chat", request_id="r1", run_id="t1", command="x", description="d",
                               choices=["once", "session", "always", "deny"], smart_denied=True)
        self.assertTrue(m["parts"][0]["smart_denied"])

    def test_approval_rejects_bad_choices(self):
        for choices in ([], ["yes"], ["once", "all"]):
            with self.assertRaises(ValueError):
                w.approval_message("chat", request_id="r", run_id="t", command="x", description="d", choices=choices)

    def test_approval_choices_matrix(self):
        self.assertEqual(w.approval_choices(allow_session=False, allow_permanent=False), ["once", "deny"])
        self.assertEqual(w.approval_choices(allow_session=True, allow_permanent=False), ["once", "session", "deny"])
        self.assertEqual(w.approval_choices(allow_session=True, allow_permanent=True), ["once", "session", "always", "deny"])

    def test_clarify_message(self):
        m = w.clarify_message("chat", clarify_id="cl1", question="Which?", choices=["a", "b"], multi_select=True, run_id="t1")
        p = m["parts"][0]
        self.assertEqual((p["type"], p["kind"], p["widget_id"]), ("widget", "clarify", "cl1"))
        self.assertEqual(p["choices"], ["a", "b"])
        self.assertTrue(p["multi_select"])
        self.assertEqual(m["attention"]["kind"], "question")
        self.assertEqual(m["attention"]["request_id"], "cl1")
        open_ended = w.clarify_message("chat", clarify_id="cl2", question="Say more", choices=None, multi_select=True)
        self.assertEqual(open_ended["parts"][0]["choices"], [])
        self.assertFalse(open_ended["parts"][0]["multi_select"])

    def test_subagent_start_stop(self):
        s = w.subagent_message("chat", phase="start", child_session_id="c1", child_role="researcher", child_goal="find x", run_id="t1")
        p = s["parts"][0]
        self.assertEqual((p["tool_name"], p["status"], p["tool_call_id"]), ("delegate_task", "running", "subagent:c1"))
        e = w.subagent_message("chat", phase="stop", child_session_id="c1", child_role="researcher",
                               child_status="ok", child_summary="done", duration_ms=5, tool_call_count=3)
        self.assertEqual(e["parts"][0]["status"], "complete")
        self.assertEqual(e["parts"][0]["result"], "done")
        f = w.subagent_message("chat", phase="stop", child_session_id="c1", child_role="r", child_status="failed")
        self.assertEqual(f["parts"][0]["status"], "error")
        with self.assertRaises(ValueError):
            w.subagent_message("chat", phase="mid", child_session_id="c", child_role="r")


class Inbound(unittest.TestCase):
    def test_message_defaults_and_shape(self):
        ev = w.parse_inbound_event({"thread_id": "ops", "text": "hi", "message_id": "m1", "client_msg_id": "c1", "seq": 7})
        self.assertEqual(ev, {"kind": "message", "context_note": "", "thread_id": "ops", "text": "hi", "message_id": "m1",
                              "client_msg_id": "c1", "seq": 7, "media": [], "mode": None})

    def test_message_with_media_only(self):
        ev = w.parse_inbound_event({"kind": "message", "thread_id": "chat", "text": "",
                                    "media": [{"media_id": "med_1", "mime": "image/png", "data_b64": "aGk="}]})
        self.assertEqual(ev["media"], [{"media_id": "med_1", "mime": "image/png", "data_b64": "aGk="}])

    def test_message_rejections(self):
        bad = [
            "nope",
            {"thread_id": "ops"},                                   # no text, no media
            {"thread_id": "bad id!", "text": "x"},
            {"thread_id": "ops", "text": 5},
            {"thread_id": "ops", "text": "x", "media": "no"},
            {"thread_id": "ops", "text": "x", "media": [{"mime": "text/plain", "data_b64": "a"}]},
            {"thread_id": "ops", "text": "x", "media": [{"mime": "image/png"}]},
            {"kind": "bogus", "thread_id": "ops", "text": "x"},
        ]
        for payload in bad:
            with self.assertRaises(ValueError, msg=repr(payload)):
                w.parse_inbound_event(payload)

    def test_approval_decision(self):
        ev = w.parse_inbound_event({"kind": "approval_decision", "thread_id": "chat", "request_id": " r1 ",
                                    "choice": "deny", "run_id": "t1", "reason": "not now"})
        self.assertEqual(ev, {"kind": "approval_decision", "thread_id": "chat", "request_id": "r1",
                              "choice": "deny", "run_id": "t1", "reason": "not now"})
        for payload in ({"kind": "approval_decision", "thread_id": "chat", "request_id": "r", "choice": "all"},
                        {"kind": "approval_decision", "thread_id": "chat", "choice": "once"},
                        {"kind": "approval_decision", "request_id": "r", "choice": "once"}):
            with self.assertRaises(ValueError):
                w.parse_inbound_event(payload)

    def test_clarify_response(self):
        ev = w.parse_inbound_event({"kind": "clarify_response", "clarify_id": "cl1", "response": "2"})
        self.assertEqual(ev["clarify_id"], "cl1")
        self.assertEqual(ev["response"], "2")
        with self.assertRaises(ValueError):
            w.parse_inbound_event({"kind": "clarify_response", "clarify_id": "cl1"})

    def test_control_kinds(self):
        self.assertEqual(w.parse_inbound_event({"kind": "ping"}), {"kind": "ping"})
        self.assertEqual(w.parse_inbound_event({"kind": "catalog_request"}), {"kind": "catalog_request"})

    def test_errors_never_echo_the_payload(self):
        try:
            w.parse_inbound_event({"thread_id": "ops", "text": 5, "secret": "hunter2"})
        except ValueError as exc:
            self.assertNotIn("hunter2", str(exc))
        else:
            self.fail("expected ValueError")


class Catalog(unittest.TestCase):
    def test_shadowed_plugin_commands_drop_and_slashes_normalize(self):
        rows = w.build_catalog(
            builtins=[{"name": "help", "description": "h", "aliases": ["h"], "busy_policy": "dispatch", "arg_hint": " x "}],
            skills=[{"name": "/brainstorming", "description": "b"}],
            aliases=[{"name": "sp-tdd", "target": "/superpowers:tdd"}, {"name": "superpowers:tdd", "target": "/superpowers:tdd"}],
            plugins=[{"name": "sp-tdd", "description": "shadowed"}, {"name": "reload", "description": "p"}],
        )
        names = [r["name"] for r in rows]
        self.assertEqual(names, ["/help", "/brainstorming", "/sp-tdd", "/superpowers:tdd", "/reload"])
        by = {r["name"]: r for r in rows}
        self.assertEqual(by["/help"]["aliases"], ["/h"])
        self.assertEqual(by["/help"]["arg_hint"], "x")
        self.assertEqual(by["/help"]["busy_policy"], "dispatch")
        self.assertEqual(by["/brainstorming"]["busy_policy"], "dispatch")
        self.assertEqual(by["/sp-tdd"]["category"], "alias")
        self.assertEqual(by["/reload"]["busy_policy"], "reject")
        self.assertIsNone(by["/reload"]["arg_hint"])

    def test_duplicates_keep_first(self):
        rows = w.build_catalog(builtins=[{"name": "x"}], skills=[{"name": "x"}], aliases=[], plugins=[])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["category"], "builtin")



class WithJob(unittest.TestCase):
    def test_a_job_delivery_carries_its_job_and_no_turn(self):
        body = w.with_job(
            w.text_message("ops", "backup stale", run_id="run-7", session_id="sess-1", cron_run_id="x"),
            "a1b2c3d4e5f6", "a1b2c3d4e5f6:2026-09-28_21-00-20",
        )
        self.assertEqual(body["job_id"], "a1b2c3d4e5f6")
        self.assertEqual(body["job_run_id"], "a1b2c3d4e5f6:2026-09-28_21-00-20")
        for key in ("run_id", "hermes_session_id", "cron_run_id"):
            self.assertNotIn(key, body)

    def test_anything_else_is_left_as_it_was(self):
        body = w.text_message("thr_1", "hello", run_id="run-7", session_id="sess-1")
        self.assertEqual(w.with_job(dict(body), None, None), body)

    def test_a_job_with_no_run_file_still_names_its_job(self):
        body = w.with_job(w.text_message("ops", "x"), "a1b2c3d4e5f6", None)
        self.assertEqual(body["job_id"], "a1b2c3d4e5f6")
        self.assertNotIn("job_run_id", body)


if __name__ == "__main__":
    unittest.main()


class StopEvent(unittest.TestCase):
    def test_stop_needs_only_the_thread(self):
        self.assertEqual(w.parse_inbound_event({"kind": "stop", "thread_id": "ops"}),
                         {"kind": "stop", "thread_id": "ops"})

    def test_stop_ignores_a_client_supplied_run_id(self):
        """The client does not get to choose which run is interrupted — the
        adapter resolves the thread to the session whose turn is in flight."""
        ev = w.parse_inbound_event({"kind": "stop", "thread_id": "ops", "run_id": "someone-elses"})
        self.assertNotIn("run_id", ev)

    def test_stop_still_needs_a_well_formed_thread_id(self):
        with self.assertRaises(ValueError):
            w.parse_inbound_event({"kind": "stop"})
        with self.assertRaises(ValueError):
            w.parse_inbound_event({"kind": "stop", "thread_id": "../../etc"})


class BusyMode(unittest.TestCase):
    """The composer's three chips. `redirect` is the word on the button and
    `interrupt` is the word the gateway uses for the same thing."""

    def test_each_chip_maps_to_a_gateway_mode(self):
        for chip, mode in (("queue", "queue"), ("steer", "steer"), ("redirect", "interrupt")):
            ev = w.parse_inbound_event({"thread_id": "ops", "text": "hi", "mode": chip})
            self.assertEqual(ev["mode"], mode)

    def test_case_and_padding_do_not_matter(self):
        self.assertEqual(w.parse_inbound_event({"thread_id": "ops", "text": "hi", "mode": " Steer "})["mode"], "steer")

    def test_no_mode_leaves_the_gateway_setting_alone(self):
        self.assertIsNone(w.parse_inbound_event({"thread_id": "ops", "text": "hi"})["mode"])

    def test_an_unknown_mode_is_ignored_rather_than_guessed(self):
        self.assertIsNone(w.parse_inbound_event({"thread_id": "ops", "text": "hi", "mode": "yolo"})["mode"])
        self.assertIsNone(w.parse_inbound_event({"thread_id": "ops", "text": "hi", "mode": 7})["mode"])


class SubagentTranscriptEventTests(unittest.TestCase):
    """The read-only request behind the expandable subagent card."""

    def test_it_carries_the_thread_and_the_child(self):
        ev = w.parse_inbound_event(
            {"kind": "subagent_transcript", "thread_id": "thr_abc123", "child_session_id": "20260922_205330_939ccf"}
        )
        self.assertEqual(ev, {"kind": "subagent_transcript", "thread_id": "thr_abc123",
                              "child_session_id": "20260922_205330_939ccf"})

    def test_a_missing_or_absurd_child_is_refused(self):
        for child in (None, "", 7, "x" * 129):
            with self.assertRaises(ValueError):
                w.parse_inbound_event({"kind": "subagent_transcript", "thread_id": "thr_abc123",
                                       "child_session_id": child})

    def test_it_still_needs_a_real_thread(self):
        with self.assertRaises(ValueError):
            w.parse_inbound_event({"kind": "subagent_transcript", "thread_id": "../etc", "child_session_id": "c1"})


class ContextNoteTests(unittest.TestCase):
    """Something that happened while the agent was not being spoken to — a
    checklist item ticked — rides with the next message."""

    def _msg(self, **extra):
        body = {"kind": "message", "thread_id": "thr_abc123", "text": "hi", "message_id": "m1",
                "client_msg_id": "c1", "seq": 1}
        body.update(extra)
        return w.parse_inbound_event(body)

    def test_it_rides_along_when_there_is_one(self):
        self.assertEqual(self._msg(context_note='The user marked "Draft" as done.')["context_note"],
                         'The user marked "Draft" as done.')

    def test_no_note_is_an_empty_string_not_a_missing_key(self):
        self.assertEqual(self._msg()["context_note"], "")

    def test_an_absurd_note_is_refused_rather_than_forwarded(self):
        with self.assertRaises(ValueError):
            self._msg(context_note="x" * 2001)
        with self.assertRaises(ValueError):
            self._msg(context_note={"not": "a string"})


class Files(unittest.TestCase):
    """A file is a document the agent reads and a download the app opens."""

    def _msg(self, **item):
        return w.parse_inbound_event({"kind": "message", "thread_id": "chat", "text": "", "media": [item]})["media"]

    def test_an_inbound_file_keeps_a_cleaned_name(self):
        got = self._msg(media_id="med_1", mime="application/pdf", name="../a/rep\r\nort.pdf", data_b64="aGk=")
        self.assertEqual(got, [{"media_id": "med_1", "mime": "application/pdf", "data_b64": "aGk=", "name": "report.pdf"}])

    def test_an_inbound_image_is_unchanged_and_carries_no_name(self):
        got = self._msg(media_id="med_2", mime="image/png", data_b64="aGk=", name="ignored.png")
        self.assertEqual(got, [{"media_id": "med_2", "mime": "image/png", "data_b64": "aGk="}])

    def test_a_file_without_a_name_or_with_a_junk_type_is_refused(self):
        for item in (
            {"mime": "application/pdf", "data_b64": "aGk="},
            {"mime": "application/pdf", "name": "   ", "data_b64": "aGk="},
            {"mime": "not a mime", "name": "a.bin", "data_b64": "aGk="},
            {"mime": "a/b/c", "name": "a.bin", "data_b64": "aGk="},
        ):
            with self.assertRaises(ValueError, msg=repr(item)):
                self._msg(**item)

    def test_clean_name_never_returns_a_path_or_nothing(self):
        self.assertEqual(w.clean_name("../../etc/passwd"), "passwd")
        self.assertEqual(w.clean_name("C:\\Users\\l\\x.docx"), "x.docx")
        for empty in ("", "   ", "..", None, 5):
            self.assertEqual(w.clean_name(empty), "file")

    def test_guess_mime_falls_back_to_a_type_that_claims_nothing(self):
        self.assertEqual(w.guess_mime("report.pdf"), "application/pdf")
        self.assertEqual(w.guess_mime("data.zzzunknown"), "application/octet-stream")

    def test_a_file_the_server_holds_says_so_and_carries_no_gateway_path(self):
        body = w.file_message("chat", name="r.pdf", path="/srv/hermes/r.pdf", mime="application/pdf",
                              caption="the report", media_id="med_9", size_bytes=14)
        part, text = body["parts"]
        self.assertEqual(part, {"type": "file", "name": "r.pdf", "mime": "application/pdf",
                                "media_id": "med_9", "size_bytes": 14})
        self.assertEqual(text, {"type": "text", "text": "the report"})
        self.assertNotIn("/srv/hermes", repr(body))

    def test_a_file_with_no_caption_is_just_the_part(self):
        body = w.file_message("chat", name="r.pdf", path="/srv/hermes/r.pdf", media_id="med_9")
        self.assertEqual(len(body["parts"]), 1)

    def test_a_file_the_server_cannot_hold_still_lands_as_the_chip_with_its_path(self):
        body = w.file_message("chat", name="big.zip", path="/srv/hermes/big.zip", mime="application/zip")
        part, text = body["parts"]
        self.assertNotIn("media_id", part)
        self.assertIn("Saved on the gateway at /srv/hermes/big.zip", text["text"])
