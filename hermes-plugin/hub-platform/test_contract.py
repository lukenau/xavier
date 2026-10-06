"""The request contract between this plugin and the hub server in this repo.

    python3 -m unittest test_contract -v

Inbound: the hub POSTs ``{HERMES_API_BASE}/api/platforms/hub/events`` with
``Authorization: Bearer <HUB_PLATFORM_KEY>``. The events the server builds
(``server/chat/routes.py``) are sent through the server's own code into the
adapter's ``verify_http_event_request`` / ``dispatch_http_event``, in-process.

Outbound: the plugin POSTs ``/api/platform/hub/*`` on ``HUB_API_BASE`` with the
same bearer key. A local stand-in hub records every request and answers with
what the server's own request models (``server/chat/platform.py``,
``server/chat/automations.py``) make of the body: 200 when they accept it, 422
when they do not.

The adapter imports the gateway at module level, so this file installs minimal
stand-ins for the few gateway names the plugin touches — only when no real
gateway is importable. The server half needs ``../../server`` and its
dependencies (fastapi, pydantic); without them those checks are skipped.
"""

from __future__ import annotations

import asyncio
import base64
import enum
import http.server
import importlib
import importlib.util
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from unittest import mock

_SCRATCH = tempfile.mkdtemp(prefix="hub-platform-contract-")
# The observer log goes to a scratch directory, never a real Hermes home.
os.environ.setdefault("HUB_PLATFORM_OBSERVER_DIR", _SCRATCH)

_HERE = pathlib.Path(__file__).resolve().parent
SERVER_DIR = _HERE.parents[1] / "server"
if "hub_platform" not in sys.modules:
    _pkg = types.ModuleType("hub_platform")
    _pkg.__path__ = [str(_HERE)]
    sys.modules["hub_platform"] = _pkg

KEY = "contract-test-key"
THREAD = "thr_contract"
SESSION_KEY = "agent:main:hub:dm:" + THREAD


def _module(name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    parent, _, child = name.rpartition(".")
    if parent:
        setattr(sys.modules[parent], child, module)
    return module


def _install_gateway_stand_ins() -> bool:
    """The gateway names adapter.py imports or calls, and nothing more."""
    if importlib.util.find_spec("gateway") is not None:
        return False

    class Platform:
        def __init__(self, value: str) -> None:
            self.value = value

    class MessageType(enum.Enum):
        TEXT = "text"
        PHOTO = "photo"
        DOCUMENT = "document"

    class Record:
        """MessageEvent and SessionSource: keeps whatever it is given."""

        def __init__(self, **fields) -> None:
            self.__dict__.update(fields)

    class SendResult(Record):
        def __init__(self, success, message_id=None, error=None, raw_response=None, retryable=False) -> None:
            super().__init__(success=success, message_id=message_id, error=error,
                             raw_response=raw_response, retryable=retryable)

    class BasePlatformAdapter:
        def __init__(self, config, platform) -> None:
            self.config, self.platform = config, platform
            self._running = False
            self._active_sessions = {}
            self.handled = []

        def _mark_connected(self) -> None:
            self._running = True

        def _mark_disconnected(self) -> None:
            self._running = False

        async def handle_message(self, event) -> None:
            self.handled.append(event)

    def cache_bytes(data: bytes, name: str) -> str:
        path = os.path.join(_SCRATCH, f"cached-{len(os.listdir(_SCRATCH))}{os.path.basename(name)}")
        with open(path, "wb") as f:
            f.write(data)
        return path

    _module("gateway", __path__=[])
    _module("gateway.platforms", __path__=[])
    _module("gateway.config", Platform=Platform, PlatformConfig=Record)
    _module("gateway.session", SessionSource=Record)
    _module("gateway.platforms.base", BasePlatformAdapter=BasePlatformAdapter, MessageEvent=Record,
            MessageType=MessageType, SendResult=SendResult,
            cache_image_from_bytes=cache_bytes, cache_document_from_bytes=cache_bytes)

    calls = []
    pending = []  # the session's approval queue, as list_gateway_approvals returns it
    _module("tools", __path__=[])
    _module("tools.approval", calls=calls, pending=pending,
            list_gateway_approvals=lambda session_key: list(pending),
            ack_gateway_approval=lambda session_key, request_id: calls.append(("ack", session_key, request_id)) or True,
            resolve_gateway_approval=lambda session_key, choice, reason=None, request_id=None:
                calls.append(("resolve", session_key, choice, request_id)) or 1)
    _module("tools.clarify_gateway", calls=calls, _lock=threading.Lock(), _entries={},
            mark_awaiting_text=lambda clarify_id: calls.append(("await_text", clarify_id)) or True,
            resolve_gateway_clarify=lambda clarify_id, response: calls.append(("clarify", clarify_id, response)) or True)
    return True


STANDING_IN = _install_gateway_stand_ins()
if STANDING_IN:
    adapter_mod = importlib.import_module("hub_platform.adapter")
hooks = importlib.import_module("hub_platform.hooks")
runtime = importlib.import_module("hub_platform.runtime")
wire = importlib.import_module("hub_platform.hub_wire")
cron_feed = importlib.import_module("hub_platform.cron_feed")
widget_tool = importlib.import_module("hub_platform.widget_tool")
subagent_transcript = importlib.import_module("hub_platform.subagent_transcript")
hc = importlib.import_module("hub_platform.hub_client")


def _server():
    """(chat.platform, chat.routes, chat.automations) from ../../server, or None."""
    if not (SERVER_DIR / "chat" / "platform.py").exists():
        return None
    if str(SERVER_DIR) not in sys.path:
        sys.path.insert(0, str(SERVER_DIR))
    try:
        platform_mod = importlib.import_module("chat.platform")
        routes = importlib.import_module("chat.routes")
        automations = importlib.import_module("chat.automations")
    except Exception:
        return None
    return platform_mod, routes, automations


SERVER = _server()
needs_gateway_stand_ins = unittest.skipUnless(STANDING_IN, "a real gateway is importable; run this in the gateway's own smoke test")
needs_server = unittest.skipUnless(SERVER, "server/ or its dependencies (fastapi, pydantic) not importable")


def _server_models():
    if not SERVER:
        return {}
    platform_mod, _, automations = SERVER
    return {
        hc.DELIVER_PATH: platform_mod.DeliverRequest,
        hc.MEDIA_PATH: platform_mod.MediaUploadRequest,
        hc.COMMANDS_PATH: platform_mod.CommandCatalogPush,
        hc.STREAM_PATH: platform_mod.StreamDeltaRequest,
        hc.CLOSE_PATH: platform_mod.CloseThreadRequest,
        hc.SETTLE_PATH: platform_mod.SettleApprovalsRequest,
        cron_feed.SYNC_PATH: automations.SyncRequest,
    }


class _Hub(http.server.BaseHTTPRequestHandler):
    """The hub's platform API as the plugin meets it: every request recorded,
    every body judged by the server's own request model."""

    seen: list = []
    models: dict = {}
    answers = {hc.MEDIA_PATH: {"media_id": "med_1", "size_bytes": 3}, hc.DELIVER_PATH: {"message_id": "msg_1", "seq": 1}}

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        status, answer = 200, {"status": "ok"}
        model = self.models.get(self.path)
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            status, answer = 401, {"detail": {"code": "hub_platform_key_invalid"}}
        elif model is not None:
            try:
                model.model_validate(body)
            except Exception as exc:
                status, answer = 422, {"detail": str(exc)[:400]}
        if status == 200:
            answer.update(self.answers.get(self.path, {}))
        type(self).seen.append({"path": self.path, "auth": self.headers.get("Authorization"),
                                "body": body, "status": status})
        payload = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class _Response:
    def __init__(self, status: int, body: bytes) -> None:
        self.status, self._body = status, body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Wiring(unittest.TestCase):
    """A stand-in hub on a local port, the plugin's client and queue pointed at it."""

    @classmethod
    def setUpClass(cls):
        _Hub.models = _server_models()
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Hub)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.key_file = os.path.join(cls.tmp.name, "HUB_PLATFORM_KEY")
        with open(cls.key_file, "w") as f:
            f.write(KEY + "\n")
        cls._saved = (runtime.client, runtime.queue, runtime.hub_thread_for_session, runtime.redact, cron_feed.CRON_DIR)
        runtime.client = hc.HubApiClient(f"http://127.0.0.1:{cls.httpd.server_address[1]}", cls.key_file, timeout=3)
        runtime.queue = hc.DeliveryQueue(runtime.client)
        runtime.hub_thread_for_session = lambda sid: THREAD if sid == "s_hub" else None
        runtime.redact = lambda text: text
        cron_feed.CRON_DIR = os.path.join(cls.tmp.name, "cron")

    @classmethod
    def tearDownClass(cls):
        runtime.queue.wait_idle(5)
        runtime.queue.stop()
        runtime.client, runtime.queue, runtime.hub_thread_for_session, runtime.redact, cron_feed.CRON_DIR = cls._saved
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        _Hub.seen = []
        if STANDING_IN:
            self.adapter = adapter_mod.HubAdapter(None)
            self.adapter._mark_connected()
            sys.modules["tools.approval"].calls.clear()
            sys.modules["tools.approval"].pending.clear()

    def posted(self, path):
        runtime.queue.wait_idle(5)
        return [s for s in _Hub.seen if s["path"] == path]

    def assert_all_accepted(self):
        runtime.queue.wait_idle(5)
        refused = [(s["path"], s["status"]) for s in _Hub.seen if s["status"] != 200]
        self.assertEqual(refused, [], "the hub refused a request the plugin built")
        self.assertTrue(all(s["auth"] == f"Bearer {KEY}" for s in _Hub.seen))


@needs_gateway_stand_ins
class OutboundToTheHub(_Wiring):
    def test_a_reply_lands_on_deliver_with_the_bearer_key_and_ends_the_turn(self):
        result = asyncio.run(self.adapter.send(THREAD, "Here is the answer."))
        self.assertTrue(result.success, result.error)
        (sent,) = self.posted(hc.DELIVER_PATH)
        self.assertEqual(sent["auth"], f"Bearer {KEY}")
        self.assertEqual(sent["body"]["thread_id"], THREAD)
        self.assertIs(sent["body"]["final"], True)
        self.assertEqual(sent["body"]["parts"], [{"type": "text", "text": "Here is the answer."}])
        self.assertTrue(sent["body"]["delivery_id"])
        self.assert_all_accepted()

    def test_an_image_goes_up_as_media_then_lands_as_a_part(self):
        path = os.path.join(self.tmp.name, "chart.png")
        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n")
        result = asyncio.run(self.adapter.send_image_file(THREAD, path, caption="This week"))
        self.assertTrue(result.success, result.error)
        (upload,) = self.posted(hc.MEDIA_PATH)
        self.assertEqual((upload["body"]["mime"], upload["body"]["origin"]), ("image/png", "agent"))
        (sent,) = self.posted(hc.DELIVER_PATH)
        self.assertEqual(sent["body"]["parts"][0], {"type": "image", "media_id": "med_1", "mime": "image/png"})
        self.assert_all_accepted()

    def test_a_document_always_lands_as_a_file_part(self):
        """With the bytes in the hub when its media route takes the file, as a
        chip naming where the file is on the gateway when it does not."""
        path = os.path.join(self.tmp.name, "report.pdf")
        with open(path, "wb") as f:
            f.write(b"%PDF-1.4")
        result = asyncio.run(self.adapter.send_document(THREAD, path))
        self.assertTrue(result.success, result.error)
        (upload,) = self.posted(hc.MEDIA_PATH)
        (sent,) = self.posted(hc.DELIVER_PATH)
        part = sent["body"]["parts"][0]
        self.assertEqual((part["type"], part["name"]), ("file", "report.pdf"))
        if upload["status"] == 200:
            self.assertEqual(part["media_id"], "med_1")
        else:
            self.assertNotIn("media_id", part)
            self.assertIn("Saved on the gateway at", sent["body"]["parts"][1]["text"])
        self.assertEqual(sent["status"], 200)

    def test_an_approval_card_carries_the_request_id_and_its_choices(self):
        sys.modules["tools.approval"].pending.append({"request_id": "req_1"})
        result = asyncio.run(self.adapter.send_exec_approval(
            THREAD, "rm -rf ./build", SESSION_KEY, description="recursive delete", allow_permanent=False))
        self.assertTrue(result.success, result.error)
        (sent,) = self.posted(hc.DELIVER_PATH)
        part = sent["body"]["parts"][0]
        self.assertEqual((part["state"], part["choices"]), ("approval_requested", ["once", "session", "deny"]))
        self.assertEqual(sent["body"]["attention"]["kind"], "approval")
        self.assertEqual(sent["body"]["attention"]["request_id"], "req_1")
        self.assertIn(("ack", SESSION_KEY, "req_1"), sys.modules["tools.approval"].calls)
        self.assert_all_accepted()

    def test_a_clarify_question_is_a_widget_and_still_takes_a_typed_answer(self):
        result = asyncio.run(self.adapter.send_clarify(THREAD, "Which one?", ["A", "B"], "clar_1", SESSION_KEY))
        self.assertTrue(result.success, result.error)
        (sent,) = self.posted(hc.DELIVER_PATH)
        self.assertEqual(sent["body"]["parts"][0]["kind"], "clarify")
        self.assertEqual(sent["body"]["attention"], {"kind": "question", "request_id": "clar_1", "run_id": None,
                                                     "summary": "Which one?"})
        self.assertIn(("await_text", "clar_1"), sys.modules["tools.approval"].calls)
        self.assert_all_accepted()

    def test_a_scheduled_job_and_the_skills_review_are_filed_as_job_runs(self):
        asyncio.run(self.adapter.send("ops", "Nightly report", metadata={"job_id": "a1b2c3d4e5f6"}))
        asyncio.run(self.adapter.send(THREAD, "\U0001f4be Self-improvement review: Skill 'notes' patched."))
        job, review = self.posted(hc.DELIVER_PATH)
        self.assertEqual((job["body"]["job_id"], job["body"]["kind"]), ("a1b2c3d4e5f6", "ops"))
        self.assertEqual(review["body"]["job_id"], "skills-curator")
        self.assertTrue(review["body"]["job_run_id"].startswith("skills-curator:d"))
        self.assert_all_accepted()

    def test_cron_delivery_without_a_live_adapter_uses_the_same_route(self):
        out = asyncio.run(adapter_mod._standalone_send(None, "ops", "Backup finished"))
        self.assertTrue(out.get("success"), out)
        self.assertEqual(self.posted(hc.DELIVER_PATH)[0]["body"]["thread_id"], "ops")
        self.assert_all_accepted()


class HooksAndFeedsToTheHub(_Wiring):
    def test_tool_cards_streams_and_settlements_are_accepted(self):
        hooks._on_post_tool_call(session_id="s_hub", turn_id="t1", tool_call_id="call_1", tool_name="terminal",
                                 args={"command": "ls"}, result="a\nb", duration_ms=12, status="ok")
        hooks._on_stream_delta(surface="hub", session_id="s_hub", turn_id="t1", kind="reasoning", delta="Thinking it over")
        hooks._on_stream_delta(surface="hub", session_id="s_hub", turn_id="t1", kind="text", delta="Hello there, ")
        hooks._on_subagent_start(parent_session_id="s_hub", parent_turn_id="t1", child_session_id="child_1",
                                 child_role="researcher", child_goal="find x")
        hooks._on_subagent_stop(parent_session_id="s_hub", parent_turn_id="t1", child_session_id="child_1",
                                child_role="researcher", child_status="completed", child_summary="found x",
                                tool_call_history=[{}], duration_ms=900)
        hooks._on_stream_end(surface="hub", session_id="s_hub", turn_id="t1", final_text="Hello there, world.",
                             finished=True)
        if STANDING_IN:
            hooks._on_post_approval_response(session_key=SESSION_KEY, choice="deny")
        runtime.queue.wait_idle(5)
        paths = {s["path"] for s in _Hub.seen}
        expected = {hc.DELIVER_PATH, hc.STREAM_PATH, hc.CLOSE_PATH} | ({hc.SETTLE_PATH} if STANDING_IN else set())
        self.assertEqual(paths, expected)
        self.assert_all_accepted()

    def test_a_widget_is_drawn_through_deliver(self):
        out = json.loads(widget_tool.hub_widget({"kind": "metric", "props": {"label": "Spend", "value": 14}},
                                                session_id="s_hub"))
        self.assertEqual(out, {"drawn": "metric", "thread_id": THREAD})
        self.assert_all_accepted()

    def test_the_command_catalog_push_is_accepted(self):
        rows = wire.build_catalog(
            builtins=[{"name": "stop", "description": "Stop", "busy_policy": "interrupt_then_dispatch"},
                      {"name": "new", "aliases": ["reset"], "description": "New session", "busy_policy": "reject"}],
            skills=[{"name": "/brainstorming", "description": "Think it through"}],
            aliases=[{"name": "todo", "target": "/brainstorming"}],
            plugins=[{"name": "todo", "description": "shadowed"}, {"name": "hub-sync", "arg_hint": "[now]"}],
        )
        status, _ = runtime.client.commands({"version": 1, "commands": rows})
        self.assertEqual(status, 200)
        self.assert_all_accepted()

    def test_jobs_and_runs_feed_the_automations_view(self):
        cron = os.path.join(self.tmp.name, "cron")
        os.makedirs(os.path.join(cron, "output", "a1b2c3d4e5f6"), exist_ok=True)
        with open(os.path.join(cron, "jobs.json"), "w") as f:
            json.dump({"jobs": [{"id": "a1b2c3d4e5f6", "name": "disk-watch", "no_agent": True,
                                 "schedule": {"display": "0 21 * * *"}, "deliver": "hub:ops"}]}, f)
        with open(os.path.join(cron, "output", "a1b2c3d4e5f6", "2026-09-28_21-00-20.md"), "w") as f:
            f.write("# Cron Job: disk-watch\n\n**Mode:** no_agent (script)\n\n---\n\nall clear\n")
        stats = cron_feed.CronFeed(runtime.client, cron).tick()
        self.assertEqual(stats, {"jobs": 1, "runs": 1, "failed": 0})
        self.assert_all_accepted()


@needs_gateway_stand_ins
class InboundFromTheHub(unittest.TestCase):
    """What the gateway's events route hands the adapter: the bearer header to
    the verifier, the JSON body to the dispatcher."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "HUB_PLATFORM_KEY")
        with open(self.key_file, "w") as f:
            f.write(KEY)
        self._saved = (runtime.client, runtime.redact)
        runtime.client = hc.HubApiClient("http://127.0.0.1:9", self.key_file)
        runtime.redact = lambda text: text
        self.adapter = adapter_mod.HubAdapter(None)
        self.adapter._mark_connected()
        sys.modules["tools.approval"].calls.clear()

    def tearDown(self):
        runtime.client, runtime.redact = self._saved
        self.tmp.cleanup()

    def test_only_the_shared_key_as_a_bearer_gets_in(self):
        verify = self.adapter.verify_http_event_request
        self.assertEqual(verify(f"Bearer {KEY}"), (True, ""))
        self.assertEqual(verify("Bearer wrong"), (False, "invalid_hub_bearer"))
        self.assertEqual(verify(KEY), (False, "missing_hub_bearer"))
        self.assertEqual(verify(""), (False, "missing_hub_bearer"))
        os.remove(self.key_file)
        self.assertEqual(verify(f"Bearer {KEY}"), (False, "hub_platform_key_unprovisioned"))

    def test_ping_reports_the_adapter_and_its_queue(self):
        out = asyncio.run(self.adapter.dispatch_http_event({"kind": "ping"}))
        self.assertTrue(out["ok"])
        self.assertTrue(out["connected"])
        self.assertEqual(set(out["queue"]), {"queued", "sent", "failed", "dropped", "last_status"})

    def test_a_malformed_event_is_refused_without_echoing_it(self):
        out = asyncio.run(self.adapter.dispatch_http_event({"kind": "message", "thread_id": "../x", "text": "secret"}))
        self.assertEqual((out["ok"], out["error"]), (False, "invalid_event"))
        self.assertNotIn("secret", json.dumps(out))
        self.assertEqual(self.adapter.handled, [])


@needs_gateway_stand_ins
@needs_server
class EventsTheServerSends(unittest.TestCase):
    """The server's own code builds and signs each event; the request it would
    put on the wire is handed to the adapter in-process, and the adapter's
    answer goes back to the server code that asked."""

    def setUp(self):
        self.platform_mod, self.routes, _ = SERVER
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "HUB_PLATFORM_KEY")
        with open(self.key_file, "w") as f:
            f.write(KEY + "\n")
        self.requests = []
        self.adapter = adapter_mod.HubAdapter(None)
        self.adapter._mark_connected()
        self._saved = (runtime.client, runtime.redact, subagent_transcript.STATE_DB,
                       self.platform_mod.HUB_PLATFORM_KEY_FILE, self.routes.HERMES_API_BASE, self.routes.get_store)
        runtime.client = hc.HubApiClient("http://127.0.0.1:9", self.key_file)
        runtime.redact = lambda text: text
        self.platform_mod.HUB_PLATFORM_KEY_FILE = pathlib.Path(self.key_file)
        self.routes.HERMES_API_BASE = "http://gateway.test"
        self.routes.get_store = lambda: types.SimpleNamespace(
            get_thread=lambda thread_id: {"id": thread_id},
            resolve_attention=lambda **kw: None,
            thread_has_subagent=lambda thread_id, child: True,
        )
        sys.modules["tools.approval"].calls.clear()
        patcher = mock.patch.object(urllib.request, "urlopen", self._gateway)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        (runtime.client, runtime.redact, subagent_transcript.STATE_DB,
         self.platform_mod.HUB_PLATFORM_KEY_FILE, self.routes.HERMES_API_BASE, self.routes.get_store) = self._saved
        self.tmp.cleanup()

    def _gateway(self, req, timeout=None):
        self.requests.append(req)
        self.assertEqual(req.full_url, "http://gateway.test/api/platforms/hub/events")
        self.assertEqual(req.get_method(), "POST")
        ok, code = self.adapter.verify_http_event_request(req.get_header("Authorization") or "")
        if not ok:
            raise urllib.error.HTTPError(req.full_url, 401, code, {}, None)
        result = asyncio.run(self.adapter.dispatch_http_event(json.loads(req.data)))
        return _Response(200, json.dumps(result).encode())

    def test_a_typed_message_becomes_a_turn_on_the_thread_session(self):
        image = base64.b64encode(b"\x89PNG\r\n").decode()
        status, reason = self.routes._forward_send_to_gateway(
            thread_id=THREAD, message_id="msg_9", client_msg_id="c_9", seq=3, text="what's on today?",
            media=[{"media_id": "med_2", "mime": "image/png", "data_b64": image}],
            mode="steer", notes=['The user marked "Draft" as done.'],
        )
        self.assertEqual((status, reason), ("forwarded", ""))
        self.assertEqual(self.requests[0].get_header("Authorization"), f"Bearer {KEY}")
        (event,) = self.adapter.handled
        self.assertEqual(event.text, 'what\'s on today?\n\n[The user marked "Draft" as done.]')
        self.assertEqual((event.source.chat_id, event.source.chat_type), (THREAD, "dm"))
        self.assertEqual(event.user_id, adapter_mod.HUB_USER_ID)
        self.assertEqual(event.message_type.value, "photo")
        self.assertEqual(event.media_types, ["image/png"])
        self.assertEqual(event.metadata, {"hub_client_msg_id": "c_9", "hub_seq": 3})
        self.assertEqual(event.source.busy_mode_override, "steer")

    def test_stop_dispatches_the_gateways_own_stop_command(self):
        self.assertEqual(self.routes.chat_thread_stop(THREAD)["status"], "ok")
        (event,) = self.adapter.handled
        self.assertEqual((event.text, event.metadata), ("/stop", {"hub_stop": True}))

    def test_a_clarify_answer_resolves_the_parked_question(self):
        req = self.routes.ClarifyAnswerRequest(thread_id=THREAD, response="Option B")
        self.assertEqual(self.routes.chat_clarify_answer("clar_1", req)["status"], "ok")
        self.assertIn(("clarify", "clar_1", "Option B"), sys.modules["tools.approval"].calls)

    def test_an_approval_decision_resolves_by_its_request_id(self):
        # server/chat/approval.py builds exactly this body after a passkey-signed decision.
        status, _ = self.routes.forward_gateway_event({
            "kind": "approval_decision", "thread_id": THREAD, "run_id": "run_1",
            "request_id": "req_1", "choice": "deny",
        })
        self.assertEqual(status, "forwarded")
        self.assertIn(("resolve", SESSION_KEY, "deny", "req_1"), sys.modules["tools.approval"].calls)

    def test_a_subagent_transcript_round_trips(self):
        db = os.path.join(self.tmp.name, "state.db")
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
                     " tool_call_id TEXT, tool_calls TEXT, reasoning TEXT, reasoning_content TEXT, active INTEGER)")
        conn.execute("INSERT INTO messages (session_id, role, content, active) VALUES ('child_1', 'assistant', 'done', 1)")
        conn.commit()
        conn.close()
        subagent_transcript.STATE_DB = db
        out = self.routes.subagent_transcript(THREAD, "child_1")
        self.assertEqual(out["parts"], [{"type": "text", "text": "done", "role": "assistant"}])

    def test_a_hub_holding_a_different_key_is_turned_away(self):
        with open(self.key_file, "w") as f:
            f.write("another-key")
        runtime.client = hc.HubApiClient("http://127.0.0.1:9", os.path.join(self.tmp.name, "gateway-key"))
        with open(os.path.join(self.tmp.name, "gateway-key"), "w") as f:
            f.write(KEY)
        self.assertEqual(self.routes.forward_gateway_event({"kind": "stop", "thread_id": THREAD}),
                         ("pending", "gateway returned 401"))
        self.assertEqual(self.adapter.handled, [])


@needs_gateway_stand_ins
class Registration(unittest.TestCase):
    def test_the_platform_hooks_and_tool_register_on_the_plugin_context(self):
        calls = []
        ctx = types.SimpleNamespace(
            register_platform=lambda **kw: calls.append(("platform", kw)),
            register_hook=lambda name, cb: calls.append(("hook", name)),
            register_tool=lambda **kw: calls.append(("tool", kw)),
        )
        adapter_mod.register(ctx)
        hooks.register_hooks(ctx)
        widget_tool.register_widget_tool(ctx)
        platform = [kw for kind, kw in calls if kind == "platform"][0]
        self.assertEqual(platform["name"], "hub")
        self.assertEqual(platform["cron_deliver_env_var"], "HUB_HOME_CHANNEL")
        self.assertEqual((platform["allowed_users_env"], platform["allow_all_env"]),
                         ("HUB_ALLOWED_USERS", "HUB_ALLOW_ALL_USERS"))
        self.assertTrue(callable(platform["standalone_sender_fn"]))
        self.assertEqual(sorted(name for kind, name in calls if kind == "hook"), [
            "on_stream_delta", "on_stream_end", "post_approval_response",
            "post_tool_call", "subagent_start", "subagent_stop",
        ])
        tool = [kw for kind, kw in calls if kind == "tool"][0]
        self.assertEqual((tool["name"], tool["toolset"]), ("hub_widget", "hub"))


if __name__ == "__main__":
    unittest.main()
