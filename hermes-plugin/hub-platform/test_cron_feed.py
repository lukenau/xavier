"""Offline tests for cron_feed.py: the run-file parser, the run id a delivery
belongs to, and the feed's send-once bookkeeping.
    python3 -m unittest test_cron_feed -v
"""

from __future__ import annotations

import importlib
import json
import os
import pathlib
import sys
import tempfile
import time
import types
import unittest

_HERE = pathlib.Path(__file__).resolve().parent
if "hub_platform" not in sys.modules:
    _pkg = types.ModuleType("hub_platform")
    _pkg.__path__ = [str(_HERE)]
    sys.modules["hub_platform"] = _pkg
cf = importlib.import_module("hub_platform.cron_feed")

SCRIPT_OK = """# Cron Job: disk-watch

**Job ID:** a1b2c3d4e5f6
**Run Time:** 2026-09-28 21:00:20
**Mode:** no_agent (script)

---

⚠️ disk-watch:
• backup stale — last snapshot 136h ago
"""

SCRIPT_SILENT = """# Cron Job: price-watch

**Job ID:** b2c3d4e5f6a1
**Run Time:** 2026-09-29 15:31:01
**Mode:** no_agent (script)
**Status:** silent (empty output)
"""

SCRIPT_FAILED = """# Cron Job: Porch light ON (7 PM)

**Job ID:** c3d4e5f6a1b2
**Run Time:** 2026-08-28 19:03:09
**Mode:** no_agent (script)
**Status:** script failed

Script exited with code 28
stdout:
000
"""

AGENT_OK = """# Cron Job: Package tracker

**Job ID:** d4e5f6a1b2c3
**Run Time:** 2026-09-29 10:06:25
**Schedule:** 0 10 * * *

## Prompt

[IMPORTANT: You are running as a scheduled cron job.]

## Response

Reply in this shape.

## Response

**Package update**
- Water bottle · Arriving today
"""

AGENT_SILENT = AGENT_OK.rsplit("## Response", 1)[0] + "## Response\n\n[SILENT]\n"

AGENT_FAILED = """# Cron Job: weekly-reminder (FAILED)

**Job ID:** e5f6a1b2c3d4
**Run Time:** 2026-07-27 12:00:40
**Schedule:** 0 12 * * *

## Prompt

Send the weekly reminder.

## Error

```
RuntimeError: HTTP 400: Your credit balance is too low.
```
"""


class ParseRunFile(unittest.TestCase):
    def test_script_output_follows_the_rule(self):
        run = cf.parse_run_file(SCRIPT_OK)
        self.assertEqual(run["name"], "disk-watch")
        self.assertEqual(run["status"], "ok")
        self.assertTrue(run["output"].startswith("⚠️ disk-watch:"))
        self.assertTrue(run["output"].endswith("136h ago"))

    def test_a_silent_script_run_has_no_output(self):
        run = cf.parse_run_file(SCRIPT_SILENT)
        self.assertEqual((run["status"], run["output"]), ("silent", ""))

    def test_a_failed_script_keeps_what_it_printed(self):
        run = cf.parse_run_file(SCRIPT_FAILED)
        self.assertEqual(run["status"], "failed")
        self.assertTrue(run["output"].startswith("Script exited with code 28"))

    def test_an_agent_run_is_what_follows_the_last_response_heading(self):
        run = cf.parse_run_file(AGENT_OK)
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["output"], "**Package update**\n- Water bottle · Arriving today")

    def test_the_prompt_never_becomes_the_output(self):
        for text in (AGENT_SILENT, AGENT_OK.split("## Response")[0]):
            run = cf.parse_run_file(text)
            self.assertEqual((run["status"], run["output"]), ("silent", ""))

    def test_a_run_that_died_reports_its_error(self):
        run = cf.parse_run_file(AGENT_FAILED)
        self.assertEqual(run["name"], "weekly-reminder")
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["output"], "RuntimeError: HTTP 400: Your credit balance is too low.")

    def test_a_script_that_prints_the_marker_is_silent(self):
        for body in ("[SILENT]", "[SILENT]\nnothing moved", "checked 4 accounts\n[SILENT]"):
            run = cf.parse_run_file(SCRIPT_OK.split("---")[0] + "---\n\n" + body + "\n")
            self.assertEqual((run["status"], run["output"]), ("silent", ""), body)
        run = cf.parse_run_file(SCRIPT_OK.split("---")[0] + "---\n\nI considered staying [SILENT] but here it is\n")
        self.assertEqual(run["status"], "ok")

    def test_a_died_run_whose_prompt_holds_a_response_heading_reports_the_error(self):
        text = AGENT_FAILED.replace(
            "Send the weekly reminder.",
            "Send the weekly reminder.\n\n## Response\n\n[SILENT]\n\nYou are a helpful assistant.",
        )
        run = cf.parse_run_file(text)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["output"], "RuntimeError: HTTP 400: Your credit balance is too low.")

    def test_long_output_is_cut_and_says_so(self):
        run = cf.parse_run_file(SCRIPT_OK + "x" * (cf.MAX_OUTPUT_CHARS + 10))
        self.assertTrue(run["truncated"])
        self.assertEqual(len(run["output"]), cf.MAX_OUTPUT_CHARS)


class FakeClient:
    def __init__(self, status: int = 200):
        self.status = status
        self.posts = []

    def post(self, path, body):
        self.posts.append((path, json.loads(json.dumps(body))))
        return self.status, {}


def write(path: str, text: str, mtime: float) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    os.utime(path, (mtime, mtime))


class Feed(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.now = time.time()
        write(os.path.join(self.dir, "output", "a1b2c3d4e5f6", "2026-09-27_21-00-20.md"), SCRIPT_OK, self.now - 90000)
        write(os.path.join(self.dir, "output", "a1b2c3d4e5f6", "2026-09-28_21-00-20.md"), SCRIPT_OK, self.now - 3600)
        write(os.path.join(self.dir, "output", "b2c3d4e5f6a1", "2026-09-29_15-31-01.md"), SCRIPT_SILENT, self.now - 60)
        write(os.path.join(self.dir, "output", "a1b2c3d4e5f6_20260716.txt"), "stray", self.now)
        with open(os.path.join(self.dir, "jobs.json"), "w") as f:
            json.dump({"jobs": [
                {"id": "a1b2c3d4e5f6", "name": "disk-watch", "no_agent": True, "enabled": True, "state": "scheduled",
                 "schedule": {"display": "0 21 * * *"}, "deliver": "telegram:1,hub:ops",
                 "next_run_at": "2026-09-29T21:00:00-04:00", "last_status": "ok"},
                {"id": "f6a1b2c3d4e5", "name": "bill-reminder", "enabled": False, "state": "paused",
                 "paused_at": "x", "deliver": "origin", "next_run_at": "2026-09-30T09:00:00-04:00",
                 "origin": {"platform": "hub", "chat_id": "thr_0123456789abcdef", "user_id": "hub-user"}},
            ]}, f)

    def test_a_delivery_belongs_to_the_newest_run_file(self):
        out = os.path.join(self.dir, "output")
        self.assertEqual(cf.run_id_for("a1b2c3d4e5f6", out), "a1b2c3d4e5f6:2026-09-28_21-00-20")
        self.assertIsNone(cf.run_id_for("ffffffffffff", out))
        self.assertIsNone(cf.run_id_for("../etc", out))

    def test_the_first_pass_sends_the_schedule_and_every_run_oldest_first(self):
        client = FakeClient()
        stats = cf.CronFeed(client, self.dir).tick()
        self.assertEqual(stats, {"jobs": 2, "runs": 3, "failed": 0})
        (_, jobs_body), (_, runs_body) = client.posts
        self.assertTrue(jobs_body["jobs_complete"])
        watch, bill = jobs_body["jobs"]
        self.assertEqual((watch["mode"], watch["state"], watch["schedule"]), ("script", "active", "0 21 * * *"))
        self.assertEqual((bill["mode"], bill["state"], bill["next_run_at"]), ("agent", "paused", None))
        self.assertEqual(bill["origin"], {"platform": "hub", "chat_id": "thr_0123456789abcdef"})
        self.assertEqual([r["run_id"] for r in runs_body["runs"]], [
            "a1b2c3d4e5f6:2026-09-27_21-00-20",
            "a1b2c3d4e5f6:2026-09-28_21-00-20",
            "b2c3d4e5f6a1:2026-09-29_15-31-01",
        ])
        self.assertEqual(runs_body["runs"][2]["status"], "silent")
        self.assertEqual(runs_body["runs"][2]["job_name"], "price-watch")

    def test_nothing_is_sent_twice_and_a_new_file_is_sent_once(self):
        client = FakeClient()
        feed = cf.CronFeed(client, self.dir)
        feed.tick()
        client.posts.clear()
        self.assertEqual(feed.tick(), {"jobs": 0, "runs": 0, "failed": 0})
        self.assertEqual(client.posts, [])
        write(os.path.join(self.dir, "output", "b2c3d4e5f6a1", "2026-09-29_15-46-01.md"), SCRIPT_SILENT, self.now)
        self.assertEqual(feed.tick()["runs"], 1)
        self.assertEqual([r["run_id"] for r in client.posts[0][1]["runs"]], ["b2c3d4e5f6a1:2026-09-29_15-46-01"])

    def test_a_pass_that_did_not_land_is_tried_again(self):
        client = FakeClient(status=0)
        feed = cf.CronFeed(client, self.dir)
        # The schedule and the runs are tried independently: both failed.
        self.assertEqual(feed.tick(), {"jobs": 0, "runs": 0, "failed": 2})
        client.status = 200
        self.assertEqual(feed.tick(), {"jobs": 2, "runs": 3, "failed": 0})

    def test_one_refused_run_does_not_hold_the_rest(self):
        class Refuses(FakeClient):
            def post(self, path, body):
                self.posts.append((path, body))
                runs = body.get("runs", [])
                if any(r["run_id"].endswith("2026-09-28_21-00-20") for r in runs):
                    return 422, {}
                return 200, {}
        client = Refuses()
        feed = cf.CronFeed(client, self.dir)
        stats = feed.tick()
        self.assertEqual((stats["runs"], stats.get("refused"), stats["failed"]), (3, 1, 0))
        self.assertEqual(feed.tick()["runs"], 0)  # the refused one is not retried forever

    def test_an_unreadable_schedule_is_never_sent_as_an_empty_one(self):
        with open(os.path.join(self.dir, "jobs.json"), "w") as f:
            f.write("{not json")
        client = FakeClient()
        stats = cf.CronFeed(client, self.dir).tick()
        self.assertEqual(stats["jobs"], 0)
        self.assertTrue(all("jobs" not in body for _, body in client.posts))

    def test_runs_go_up_in_batches(self):
        for n in range(cf.BATCH + 5):
            write(os.path.join(self.dir, "output", "0f0f0f0f0f0f", f"2026-09-29_00-{n:02d}-00.md"), SCRIPT_SILENT, self.now - 500 + n)
        client = FakeClient()
        cf.CronFeed(client, self.dir).tick()
        sizes = [len(body["runs"]) for _, body in client.posts if "runs" in body]
        self.assertEqual(sizes, [cf.BATCH, 8])


if __name__ == "__main__":
    unittest.main()
