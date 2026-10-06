"""Offline tests for hub_client.py against a local stdlib HTTP server.
    python3 -m unittest test_hub_client -v
"""

from __future__ import annotations

import http.server
import importlib
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
import types
import unittest

# The plugin directory is a package whose name has a hyphen; a synthetic package
# over the same path lets its relative imports resolve.
_HERE = pathlib.Path(__file__).resolve().parent
if "hub_platform" not in sys.modules:
    _pkg = types.ModuleType("hub_platform")
    _pkg.__path__ = [str(_HERE)]
    sys.modules["hub_platform"] = _pkg
hc = importlib.import_module("hub_platform.hub_client")


class _Recorder(http.server.BaseHTTPRequestHandler):
    seen = []
    status = 200
    gate = None  # threading.Event to block responses on, for queue tests

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if self.gate is not None:
            self.gate.wait(5)
        type(self).seen.append((self.path, self.headers.get("Authorization"), json.loads(body or b"{}")))
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": type(self).status == 200, "path": self.path}).encode())

    def log_message(self, *a):
        pass


def _serve():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class ClientTests(unittest.TestCase):
    def setUp(self):
        _Recorder.seen = []
        _Recorder.status = 200
        _Recorder.gate = None
        self.httpd = _serve()
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "key")
        with open(self.key_file, "w") as f:
            f.write("test-secret\n")
        self.client = hc.HubApiClient(f"http://127.0.0.1:{self.httpd.server_address[1]}", self.key_file, timeout=2)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def test_post_carries_bearer_and_json(self):
        status, data = self.client.deliver({"thread_id": "ops", "parts": []})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        path, auth, body = _Recorder.seen[0]
        self.assertEqual(path, hc.DELIVER_PATH)
        self.assertEqual(auth, "Bearer test-secret")
        self.assertEqual(body["thread_id"], "ops")

    def test_http_error_is_returned_not_raised(self):
        _Recorder.status = 422
        status, data = self.client.media({})
        self.assertEqual(status, 422)
        self.assertFalse(data["ok"])

    def test_missing_key_is_a_status_zero(self):
        os.remove(self.key_file)
        status, data = self.client.commands({})
        self.assertEqual((status, data["error"]), (0, "hub_platform_key_unprovisioned"))
        self.assertEqual(_Recorder.seen, [])

    def test_unreachable_is_status_zero_without_exception_text(self):
        dead = hc.HubApiClient("http://127.0.0.1:1", self.key_file, timeout=0.5)
        status, data = dead.deliver({})
        self.assertEqual(status, 0)
        self.assertEqual(data["error"], "unreachable")
        self.assertNotIn("127.0.0.1", json.dumps(data))

    def test_key_is_reread_each_call(self):
        self.client.deliver({})
        with open(self.key_file, "w") as f:
            f.write("rotated\n")
        self.client.deliver({})
        self.assertEqual([s[1] for s in _Recorder.seen], ["Bearer test-secret", "Bearer rotated"])


class KeySourceTests(unittest.TestCase):
    """Where the shared secret comes from, in order: a configured key file, the
    HUB_PLATFORM_KEY environment variable, the default file under HERMES_HOME."""

    _VARS = ("HUB_PLATFORM_KEY", "HUB_PLATFORM_KEY_FILE", "HUB_API_BASE")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._env = {k: os.environ.pop(k, None) for k in self._VARS}
        self._default = hc.DEFAULT_KEY_FILE
        hc.DEFAULT_KEY_FILE = os.path.join(self.tmp.name, "default-key")

    def tearDown(self):
        hc.DEFAULT_KEY_FILE = self._default
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def _write(self, name, text):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w") as f:
            f.write(text)
        return path

    def test_the_environment_variable_is_used_when_no_file_is_configured(self):
        os.environ["HUB_PLATFORM_KEY"] = " from-env \n"
        self.assertEqual(hc.HubApiClient().key(), "from-env")

    def test_a_configured_key_file_wins_over_the_environment(self):
        os.environ["HUB_PLATFORM_KEY"] = "from-env"
        os.environ["HUB_PLATFORM_KEY_FILE"] = self._write("k", "from-file\n")
        self.assertEqual(hc.HubApiClient().key(), "from-file")

    def test_a_configured_key_file_that_is_missing_fails_closed(self):
        os.environ["HUB_PLATFORM_KEY"] = "from-env"
        os.environ["HUB_PLATFORM_KEY_FILE"] = os.path.join(self.tmp.name, "absent")
        self.assertEqual(hc.HubApiClient().key(), "")

    def test_the_default_file_under_hermes_home_is_the_last_resort(self):
        self._write("default-key", "from-default\n")
        self.assertEqual(hc.HubApiClient().key(), "from-default")

    def test_nothing_provisioned_is_empty(self):
        self.assertEqual(hc.HubApiClient().key(), "")

    def test_the_default_hub_is_this_machine_and_the_env_overrides_it(self):
        self.assertEqual(hc.HubApiClient().base_url, "http://127.0.0.1:8090")
        os.environ["HUB_API_BASE"] = "http://hub.internal:9000/"
        self.assertEqual(hc.HubApiClient().base_url, "http://hub.internal:9000")


class QueueTests(unittest.TestCase):
    def setUp(self):
        _Recorder.seen = []
        _Recorder.status = 200
        _Recorder.gate = None
        self.httpd = _serve()
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "key")
        with open(self.key_file, "w") as f:
            f.write("k\n")
        self.client = hc.HubApiClient(f"http://127.0.0.1:{self.httpd.server_address[1]}", self.key_file, timeout=2)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def test_delivers_in_order(self):
        q = hc.DeliveryQueue(self.client, maxsize=8)
        for i in range(5):
            self.assertTrue(q.enqueue(hc.DELIVER_PATH, {"i": i}))
        self.assertTrue(q.wait_idle(5))
        self.assertEqual([s[2]["i"] for s in _Recorder.seen], [0, 1, 2, 3, 4])
        self.assertEqual(q.stats()["sent"], 5)
        q.stop()

    def test_drop_oldest_when_full(self):
        q = hc.DeliveryQueue(self.client, maxsize=2, start=False)
        for i in range(4):
            q.enqueue(hc.DELIVER_PATH, {"i": i})
        self.assertEqual([b["i"] for _, b in q._pending()], [2, 3])
        self.assertEqual(q.stats()["dropped"], 2)

    def test_failures_are_counted_not_raised(self):
        _Recorder.status = 503
        q = hc.DeliveryQueue(self.client, maxsize=8)
        q.enqueue(hc.DELIVER_PATH, {"i": 1})
        self.assertTrue(q.wait_idle(5))
        self.assertEqual((q.stats()["failed"], q.stats()["last_status"]), (1, 503))
        q.stop()


if __name__ == "__main__":
    unittest.main()


class KeepAliveTests(unittest.TestCase):
    """The connection is reused across posts. `urllib.request` opened and tore
    down a socket per call, which measured 11.4ms against a real hub
    versus 6.5ms kept alive — four seconds of queue backlog over a 300-chunk
    turn, which is what made tool cards lag behind the text."""

    def setUp(self):
        _Recorder.seen = []
        _Recorder.status = 200
        _Recorder.gate = None
        self.httpd = _serve()
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "key")
        with open(self.key_file, "w") as f:
            f.write("test-secret\n")
        hc._LOCAL.__dict__.pop("conns", None)
        self.client = hc.HubApiClient(f"http://127.0.0.1:{self.httpd.server_address[1]}", self.key_file, timeout=2)

    def tearDown(self):
        hc._LOCAL.__dict__.pop("conns", None)
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def test_the_same_socket_serves_every_post(self):
        for _ in range(5):
            self.assertEqual(self.client.deliver({"thread_id": "t"})[0], 200)
        self.assertEqual(len(_Recorder.seen), 5)
        self.assertEqual(len(hc._LOCAL.conns), 1)

    def test_a_socket_the_server_closed_is_retried_on_a_fresh_one(self):
        self.assertEqual(self.client.deliver({"thread_id": "t"})[0], 200)
        # Exactly the failure a kept-alive socket has: fine while idle, dead on use.
        hc._LOCAL.conns[self.client.base_url].close()
        self.assertEqual(self.client.deliver({"thread_id": "t"})[0], 200)
        self.assertEqual(len(_Recorder.seen), 2)

    def test_an_unreachable_host_still_reports_status_zero(self):
        dead = hc.HubApiClient("http://127.0.0.1:1", self.key_file, timeout=0.5)
        status, data = dead.deliver({})
        self.assertEqual((status, data["error"]), (0, "unreachable"))


class CoalesceTests(unittest.TestCase):
    """Stream deltas already waiting behind each other are posted as one. They
    would have been concatenated on arrival anyway, so nothing is lost, and a
    backlog stops growing without bound while a tool card waits behind it."""

    def setUp(self):
        self.client = hc.HubApiClient("http://127.0.0.1:1", "/nonexistent", timeout=0.1)
        self.q = hc.DeliveryQueue(self.client, start=False)

    def _next(self):
        return self.q._next()

    def test_consecutive_deltas_for_one_part_become_one_post(self):
        for ch in "hello":
            self.q.enqueue(hc.STREAM_PATH, {"thread_id": "t", "run_id": "r", "kind": "text", "delta": ch})
        path, body = self._next()
        self.assertEqual(path, hc.STREAM_PATH)
        self.assertEqual(body["delta"], "hello")
        self.assertTrue(self.q._q.empty())

    def test_a_different_part_is_not_merged_into_the_run_before_it(self):
        self.q.enqueue(hc.STREAM_PATH, {"thread_id": "t", "run_id": "r", "kind": "reasoning", "delta": "ab"})
        self.q.enqueue(hc.STREAM_PATH, {"thread_id": "t", "run_id": "r", "kind": "text", "delta": "cd"})
        self.assertEqual(self._next()[1]["delta"], "ab")
        self.assertEqual(self._next()[1]["delta"], "cd")

    def test_a_tool_card_behind_a_run_of_deltas_keeps_its_place(self):
        for ch in "abc":
            self.q.enqueue(hc.STREAM_PATH, {"thread_id": "t", "run_id": "r", "kind": "text", "delta": ch})
        self.q.enqueue(hc.DELIVER_PATH, {"thread_id": "t", "parts": []})
        self.q.enqueue(hc.STREAM_PATH, {"thread_id": "t", "run_id": "r", "kind": "text", "delta": "d"})
        path, merged = self._next()
        self.assertRegex(merged.pop("delivery_id"), r"^[0-9a-f]{32}$")
        self.assertEqual((path, merged), (hc.STREAM_PATH, {"thread_id": "t", "run_id": "r", "kind": "text", "delta": "abc"}))
        self.assertEqual(self._next()[0], hc.DELIVER_PATH)
        self.assertEqual(self._next()[1]["delta"], "d")

    def test_a_delivery_is_never_merged_with_anything(self):
        self.q.enqueue(hc.DELIVER_PATH, {"thread_id": "t", "parts": [1]})
        self.q.enqueue(hc.DELIVER_PATH, {"thread_id": "t", "parts": [2]})
        self.assertEqual(self._next()[1]["parts"], [1])
        self.assertEqual(self._next()[1]["parts"], [2])

    def test_another_thread_is_never_merged_in(self):
        self.q.enqueue(hc.STREAM_PATH, {"thread_id": "a", "run_id": "r", "kind": "text", "delta": "1"})
        self.q.enqueue(hc.STREAM_PATH, {"thread_id": "b", "run_id": "r", "kind": "text", "delta": "2"})
        self.assertEqual(self._next()[1]["thread_id"], "a")
        self.assertEqual(self._next()[1]["thread_id"], "b")


class DeliveryIdTests(unittest.TestCase):
    """Every /deliver, /stream and /close body carries a `delivery_id`. The
    client retries once on a fresh socket, and a POST whose response was lost
    after hub-api applied it was applied again — the same words twice in the
    stored text, a second row for a card.
    The retry re-sends the same body, so the same id, and hub-api answers a
    repeat from its record."""

    def setUp(self):
        self.q = hc.DeliveryQueue(hc.HubApiClient("http://127.0.0.1:1", "/nonexistent", timeout=0.1), start=False)

    def test_enqueue_stamps_the_three_idempotent_paths_and_no_other(self):
        for path in (hc.DELIVER_PATH, hc.STREAM_PATH, hc.CLOSE_PATH, hc.MEDIA_PATH, hc.COMMANDS_PATH):
            self.q.enqueue(path, {"thread_id": "t"})
        stamped = {path: body.get("delivery_id") for path, body in self.q._pending()}
        for path in (hc.DELIVER_PATH, hc.STREAM_PATH, hc.CLOSE_PATH):
            self.assertRegex(stamped[path], r"^[0-9a-f]{32}$", path)
        self.assertEqual(len({stamped[p] for p in (hc.DELIVER_PATH, hc.STREAM_PATH, hc.CLOSE_PATH)}), 3)
        self.assertIsNone(stamped[hc.MEDIA_PATH])
        self.assertIsNone(stamped[hc.COMMANDS_PATH])

    def test_an_id_already_present_is_kept(self):
        self.q.enqueue(hc.DELIVER_PATH, {"thread_id": "t", "delivery_id": "given"})
        self.assertEqual(self.q._pending()[0][1]["delivery_id"], "given")

    def test_merged_deltas_keep_the_first_id(self):
        for ch in "abc":
            self.q.enqueue(hc.STREAM_PATH, {"thread_id": "t", "run_id": "r", "kind": "text", "delta": ch})
        ids = [body["delivery_id"] for _, body in self.q._pending()]
        self.assertEqual(len(set(ids)), 3)
        path, merged = self.q._next()
        self.assertEqual((path, merged["delta"], merged["delivery_id"]), (hc.STREAM_PATH, "abc", ids[0]))


class InOrderTests(unittest.TestCase):
    """`post_in_order` gives a caller the result AND a place in the FIFO. A
    widget posted straight through the client overtook the deltas of the text
    that introduced it."""

    def setUp(self):
        _Recorder.seen = []
        _Recorder.status = 200
        _Recorder.gate = None
        self.httpd = _serve()
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "key")
        with open(self.key_file, "w") as f:
            f.write("k\n")
        self.client = hc.HubApiClient(f"http://127.0.0.1:{self.httpd.server_address[1]}", self.key_file, timeout=2)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def _post_in_order_in_background(self, q, path, body, timeout):
        """Call post_in_order on another thread and return once its item is queued."""
        result = []
        t = threading.Thread(target=lambda: result.append(q.post_in_order(path, body, timeout=timeout)), daemon=True)
        t.start()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not any(b is body for _, b in q._pending()):
            time.sleep(0.01)
        return t, result

    def test_it_is_posted_after_everything_queued_before_it_and_returns_the_response(self):
        q = hc.DeliveryQueue(self.client, maxsize=8, start=False)
        for i in range(3):
            q.enqueue(hc.DELIVER_PATH, {"i": i})
        t, result = self._post_in_order_in_background(q, hc.DELIVER_PATH, {"i": "widget"}, timeout=5)
        self.assertEqual([b["i"] for _, b in q._pending()], [0, 1, 2, "widget"])
        q._ensure_thread()
        t.join(5)
        self.assertEqual([s[2]["i"] for s in _Recorder.seen], [0, 1, 2, "widget"])
        self.assertEqual(result, [(200, {"ok": True, "path": hc.DELIVER_PATH})])
        self.assertEqual(q.stats()["sent"], 4)
        for _, _, body in _Recorder.seen:
            self.assertRegex(body["delivery_id"], r"^[0-9a-f]{32}$")
        q.stop()

    def test_it_times_out_cleanly_and_the_item_keeps_its_place(self):
        q = hc.DeliveryQueue(self.client, start=False)
        started = time.monotonic()
        self.assertEqual(q.post_in_order(hc.DELIVER_PATH, {"i": 1}, timeout=0.05), (0, {"error": "queue_timeout"}))
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual([b["i"] for _, b in q._pending()], [1])

    def test_a_waiter_dropped_by_a_full_queue_is_released_with_queue_full(self):
        q = hc.DeliveryQueue(self.client, maxsize=1, start=False)
        t, result = self._post_in_order_in_background(q, hc.DELIVER_PATH, {"i": "widget"}, timeout=5)
        self.assertTrue(q.enqueue(hc.DELIVER_PATH, {"i": "newer"}))
        t.join(2)
        self.assertEqual(result, [(0, {"error": "queue_full"})])
        self.assertEqual(([b["i"] for _, b in q._pending()], q.stats()["dropped"]), (["newer"], 1))

    def test_it_is_never_folded_into_a_stream_batch(self):
        q = hc.DeliveryQueue(self.client, start=False)
        part = {"thread_id": "t", "run_id": "r", "kind": "text"}
        q.enqueue(hc.STREAM_PATH, dict(part, delta="a"))
        t, result = self._post_in_order_in_background(q, hc.STREAM_PATH, dict(part, delta="b"), timeout=0.2)
        q.enqueue(hc.STREAM_PATH, dict(part, delta="c"))
        self.assertEqual([body["delta"] for _, body in (q._next(), q._next(), q._next())], ["a", "b", "c"])
        t.join(2)
        self.assertEqual(result, [(0, {"error": "queue_timeout"})])


class RollbackTests(unittest.TestCase):
    def test_a_hub_api_that_refuses_delivery_ids_gets_the_body_without_one(self):
        """A hub from before delivery ids has extra='forbid' models: a
        delivery_id is a 422 and every delivery would go silent."""
        posts = []

        class Client:
            def post(self, path, body):
                posts.append(dict(body))
                if "delivery_id" in body:
                    return 422, {"detail": [{"type": "extra_forbidden", "loc": ["body", "delivery_id"]}]}
                return 200, {"ok": True}

        q = hc.DeliveryQueue(Client(), start=False)
        q.enqueue(hc.DELIVER_PATH, {"thread_id": "t", "parts": []})
        q._ensure_thread()
        self.assertTrue(q.wait_idle())
        q.stop()
        self.assertEqual(["delivery_id" in p for p in posts], [True, False])
        self.assertEqual(q.stats()["sent"], 1)
