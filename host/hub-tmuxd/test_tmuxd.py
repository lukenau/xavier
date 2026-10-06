"""python3 -m unittest discover -s host/hub-tmuxd -p 'test_*.py'

Unit tests run anywhere. LiveTmux starts a PRIVATE tmux server (tmux -L <unique name>,
TMUX_TMPDIR inside a fresh temporary directory), kills it afterwards, and never touches
the default server; it is skipped when tmux is not installed.
"""

import http.client
import json
import os
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import tmuxd

tmuxd.log = lambda message: None  # keep the test output readable

UUID_A = "aaaaaaaa-1111-4111-8111-111111111111"
UUID_B = "bbbbbbbb-2222-4222-8222-222222222222"
UUID_C = "cccccccc-3333-4333-8333-333333333333"
UUID_SDK = "dddddddd-4444-4444-8444-444444444444"
UUID_OUT = "11111111-2222-3333-4444-555555555555"
UUID_T = "eeeeeeee-5555-4555-8555-555555555555"
HAS_TMUX = shutil.which("tmux") is not None
_SEQ = iter(range(1_000_000))


class Box:
    """A throwaway home, Claude Code state directory, socket directory and tmux dir."""

    def __init__(self, **env) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hub-tmuxd-test-"))
        self.home = self.tmp / "home"
        self.claude = self.home / ".claude"
        self.run = self.tmp / "run"
        self.tmux_dir = self.tmp / "tmux"
        self.bin = self.tmp / "bin"
        for d in (self.home, self.claude / "sessions", self.claude / "projects", self.run,
                  self.tmux_dir, self.bin, self.home / "proj"):
            d.mkdir(parents=True, exist_ok=True)
        os.chmod(self.run, 0o750)
        self.tmux_label = f"hubtmuxd-test-{os.getpid()}-{next(_SEQ)}"
        self.env = {
            "HOME": str(self.home),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "XAVIER_RUN_DIR": str(self.run),
            "TMUX_TMPDIR": str(self.tmux_dir),
            "XAVIER_TMUX_SOCKET_NAME": self.tmux_label,
            "XAVIER_CLAUDE_BIN": str(self.bin / "claude"),
            # Must never reach a spawned process.
            "FAKE_SECRET_TOKEN": "do-not-leak",
            "AWS_SECRET_ACCESS_KEY": "do-not-leak",
            "TMUX": "/elsewhere/default,1,0",
        }
        if shutil.which("tmux"):
            self.env["XAVIER_TMUX_BIN"] = shutil.which("tmux")
        self.env.update(env)

    def config(self, **env) -> tmuxd.Config:
        return tmuxd.Config.from_env({**self.env, **env})

    def transcript(self, sid: str, cwd: str, *records: dict, entrypoint: str = "cli",
                   project: str = "proj") -> Path:
        d = self.claude / "projects" / project
        d.mkdir(parents=True, exist_ok=True)
        lines = [{"type": "user", "cwd": cwd, "entrypoint": entrypoint, "sessionId": sid,
                  "message": {"content": "a prompt that must never be returned"}}, *records]
        p = d / f"{sid}.jsonl"
        p.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in lines))
        return p

    def cli_session(self, pid: int, **doc) -> None:
        (self.claude / "sessions" / f"{pid}.json").write_text(json.dumps({"pid": pid, **doc}))

    def tmux(self, *args: str) -> subprocess.CompletedProcess:
        env = {"PATH": self.env["PATH"], "HOME": self.env["HOME"], "TMUX_TMPDIR": str(self.tmux_dir)}
        return subprocess.run(["tmux", "-L", self.tmux_label, *args], env=env,
                              capture_output=True, text=True, timeout=10)

    def close(self) -> None:
        if HAS_TMUX:
            self.tmux("kill-server")
        shutil.rmtree(self.tmp, ignore_errors=True)


class FakeTmux:
    def __init__(self, sessions=(), panes=None) -> None:
        self.rows = [dict(s) for s in sessions]
        self.panes = panes or {}
        self.calls = []

    def sessions(self):
        return [dict(r) for r in self.rows]

    def pane_pids(self):
        return dict(self.panes)

    def run(self, *args, timeout=10):
        self.calls.append(args)
        return mock.Mock(returncode=0, stdout="", stderr="")


def row(name, attached=False):
    return {"name": name, "created": 1756000000, "attached": attached, "windows": 1}


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Box()
        self.addCleanup(self.box.close)

    def app(self, tmux=None, **env) -> tmuxd.App:
        app = tmuxd.App(self.box.config(**env))
        app.tmux = tmux or FakeTmux()
        return app

    def assertRejected(self, status, fn, *args):
        with self.assertRaises(tmuxd.Rejected) as cm:
            fn(*args)
        self.assertEqual(cm.exception.status, status, str(cm.exception))
        return cm.exception


class ConfigTests(Base):
    def test_safe_defaults(self):
        cfg = tmuxd.Config.from_env({"HOME": str(self.box.home)})
        self.assertEqual(cfg.socket_path, "/run/xavier/tmuxd.sock")
        self.assertEqual(cfg.socket_mode, 0o660)
        self.assertEqual((cfg.prefix, cfg.term_session, cfg.tmux_socket_name), ("claude-", "hub-term", "xavier"))
        self.assertFalse(cfg.remote_control)
        self.assertFalse(cfg.skip_permissions)
        self.assertFalse(cfg.history_show_cwd)
        self.assertEqual(cfg.cwd_roots, (os.path.realpath(self.box.home),))
        self.assertEqual(cfg.claude_bin, f"{self.box.home}/.local/bin/claude")

    def test_flags_parse_strictly(self):
        self.assertTrue(self.box.config(XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS="1").skip_permissions)
        for typo in ("ture", "2", "enable"):
            with self.assertRaises(tmuxd.ConfigError):
                self.box.config(XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=typo)

    def test_socket_mode_is_owner_and_group_at_most(self):
        self.assertEqual(self.box.config(XAVIER_SOCKET_MODE="0600").socket_mode, 0o600)
        for mode in ("0666", "0644", "0777", "660"):
            with self.assertRaises(tmuxd.ConfigError):
                self.box.config(XAVIER_SOCKET_MODE=mode)

    def test_the_terminal_session_can_never_be_killable(self):
        with self.assertRaises(tmuxd.ConfigError):
            self.box.config(XAVIER_TERM_SESSION="claude-term")

    def test_roots_must_exist_and_not_be_world_writable(self):
        shared = self.box.tmp / "shared"
        shared.mkdir()
        os.chmod(shared, 0o777)
        for roots in (str(shared), str(self.box.tmp / "missing"), "relative/dir"):
            with self.assertRaises(tmuxd.ConfigError):
                self.box.config(XAVIER_CWD_ROOTS=roots)

    def test_binaries_and_names_are_plain(self):
        bad = {"XAVIER_CLAUDE_BIN": ["claude", "/opt/my claude", "/x;rm", "/x/#(id)"],
               "XAVIER_TMUX_PREFIX": ["Claude-", "-x", "a;b", "x" * 17],
               "XAVIER_TMUX_SOCKET_NAME": ["a/b", "x" * 33],
               "XAVIER_TMUXD_SOCKET_NAME": ["../x.sock", "a/b.sock"]}
        for key, values in bad.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(tmuxd.ConfigError):
                    self.box.config(**{key: value})

    def test_child_env_keeps_only_the_allowlist(self):
        env = self.box.config().env
        self.assertNotIn("FAKE_SECRET_TOKEN", env)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertNotIn("TMUX", env)  # would point tmux at another server
        self.assertFalse(any(k.startswith("XAVIER_") for k in env))
        self.assertEqual(env["HOME"], str(self.box.home))
        self.assertEqual(env["TMUX_TMPDIR"], str(self.box.tmux_dir))
        self.assertEqual(tmuxd.child_env({"LC_TIME": "C", "GITHUB_TOKEN": "x"}),
                         {"LC_TIME": "C", "PATH": "/usr/local/bin:/usr/bin:/bin"})


class CwdTests(Base):
    def setUp(self) -> None:
        super().setUp()
        self.root = os.path.realpath(self.box.home)
        self.roots = (self.root,)

    def test_inside_a_root_resolves(self):
        self.assertEqual(tmuxd.resolve_cwd(f"{self.box.home}/proj", self.roots), f"{self.root}/proj")
        self.assertEqual(tmuxd.resolve_cwd(str(self.box.home), self.roots), self.root)

    def test_dotdot_cannot_leave_the_root(self):
        self.assertRejected(400, tmuxd.resolve_cwd, f"{self.box.home}/../run", self.roots)
        self.assertRejected(400, tmuxd.resolve_cwd, f"{self.box.home}/proj/../../..", self.roots)

    def test_a_symlink_cannot_leave_the_root(self):
        (self.box.home / "escape").symlink_to("/")
        self.assertRejected(400, tmuxd.resolve_cwd, f"{self.box.home}/escape", self.roots)
        self.assertRejected(400, tmuxd.resolve_cwd, f"{self.box.home}/escape/etc", self.roots)

    def test_a_sibling_with_the_same_prefix_is_outside(self):
        sibling = self.box.tmp / "home-evil"
        sibling.mkdir()
        self.assertRejected(400, tmuxd.resolve_cwd, str(sibling), self.roots)

    def test_shell_and_tmux_metacharacters_are_refused(self):
        for raw in (f"{self.box.home}/#(touch pwned)", f"{self.box.home}/x;", f"{self.box.home}/a b",
                    f"{self.box.home}/$(id)", f"{self.box.home}/#{{pid}}", "~/proj", "proj", "",
                    f"{self.box.home}/\nx", None, 7):
            with self.subTest(raw=raw):
                self.assertRejected(400, tmuxd.resolve_cwd, raw, self.roots)

    def test_missing_files_and_world_writable_dirs_are_refused(self):
        (self.box.home / "file").write_text("x")
        shared = self.box.home / "shared"
        shared.mkdir()
        os.chmod(shared, 0o777)
        for raw in (f"{self.box.home}/nope", f"{self.box.home}/file", str(shared)):
            with self.subTest(raw=raw):
                self.assertRejected(400, tmuxd.resolve_cwd, raw, self.roots)


class NamesAndArgv(Base):
    def test_only_prefixed_slugs_are_killable(self):
        for name in ("claude-1", "claude-a-b", "claude-" + "x" * 31):
            self.assertTrue(tmuxd.killable_name("claude-", name), name)
        for name in ("hub-term", "claude-", "claude-A", "claude-x;", "=claude-1", "claude-1 ",
                     "claude--x", "claude-#(id)", "xclaude-1", "claude-" + "x" * 32):
            self.assertFalse(tmuxd.killable_name("claude-", name), name)

    def test_spawn_runs_only_the_configured_binary(self):
        cfg = self.box.config()
        self.assertEqual(tmuxd.claude_argv(cfg), [cfg.claude_bin])
        self.assertEqual(tmuxd.claude_argv(cfg, UUID_A), [cfg.claude_bin, "--resume", UUID_A])

    def test_flags_only_when_opted_in(self):
        rc = self.box.config(XAVIER_CLAUDE_REMOTE_CONTROL="1")
        self.assertEqual(tmuxd.claude_argv(rc), [rc.claude_bin, "--remote-control"])
        skip = self.box.config(XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS="1")
        self.assertEqual(tmuxd.claude_argv(skip), [skip.claude_bin, "--dangerously-skip-permissions"])

    def test_the_daemon_never_uses_a_shell(self):
        src = Path(tmuxd.__file__).read_text()
        for needle in ("shell=True", "os.system", "os.popen", "shlex"):
            self.assertNotIn(needle, src)


class SpawnAndKillRules(Base):
    def setUp(self) -> None:
        super().setUp()
        claude = self.box.bin / "claude"
        claude.write_text("#!/bin/sh\nexit 0\n")
        claude.chmod(0o755)

    def test_spawn_command_has_double_dash_and_no_shell_string(self):
        tmux = FakeTmux()
        out = self.app(tmux).spawn({})
        self.assertEqual(out["name"], "claude-1")
        self.assertIsNone(out["cwd"])  # hidden unless XAVIER_TMUXD_HISTORY_SHOW_CWD=1
        self.assertEqual(out["attach"], "tmux switch-client -t claude-1")
        args = tmux.calls[-1]
        self.assertEqual(args[:6], ("new-session", "-d", "-s", "claude-1", "-c",
                                    os.path.realpath(self.box.home)))
        self.assertEqual(args[6:], ("--", str(self.box.bin / "claude")))

    def test_bad_requests_never_reach_tmux(self):
        cases = [
            {"bogus": "1"}, {"name": 5}, {"name": ["x"]}, {"host": "mac"},
            {"name": "x;"}, {"name": "#(touch p)"}, {"name": "-t"}, {"name": "Upper"},
            {"name": "a" * 32}, {"resume": "not-a-uuid"}, {"resume": UUID_A.upper()},
            {"cwd": "/"}, {"cwd": "/etc"}, {"cwd": f"{self.box.home}/../run"},
            {"cwd": f"{self.box.home}/#(touch p)"},
        ]
        for body in cases:
            tmux = FakeTmux()
            with self.subTest(body=body):
                self.assertRejected(400, self.app(tmux).spawn, body)
                self.assertEqual(tmux.calls, [])

    def test_a_named_session_that_exists_is_a_conflict(self):
        self.assertRejected(409, self.app(FakeTmux([row("claude-web")])).spawn, {"name": "web"})

    def test_auto_names_skip_taken_ones(self):
        out = self.app(FakeTmux([row("claude-1"), row("claude-2")])).spawn({})
        self.assertEqual(out["name"], "claude-3")

    def test_session_limit(self):
        tmux = FakeTmux([row(f"claude-{i}") for i in range(1, 3)] + [row("hub-term")])
        self.assertRejected(429, self.app(tmux, XAVIER_TMUXD_MAX_SESSIONS="2").spawn, {})

    def test_a_missing_or_exposed_binary_is_refused(self):
        os.unlink(self.box.bin / "claude")
        self.assertRejected(503, self.app().spawn, {})
        (self.box.bin / "claude").write_text("#!/bin/sh\n")
        os.chmod(self.box.bin / "claude", 0o755)
        os.chmod(self.box.bin, 0o777)
        self.assertRejected(503, self.app().spawn, {})
        os.chmod(self.box.bin, 0o755)

    def test_resume_takes_the_transcripts_directory(self):
        self.box.transcript(UUID_A, f"{self.box.home}/proj")
        tmux = FakeTmux()
        out = self.app(tmux).spawn({"resume": UUID_A})
        self.assertEqual(out["resumed"], UUID_A)
        args = tmux.calls[-1]
        self.assertEqual(args[5], os.path.realpath(self.box.home / "proj"))
        self.assertEqual(args[-2:], ("--resume", UUID_A))

    def test_resume_refusals(self):
        self.box.transcript(UUID_A, f"{self.box.home}/proj")
        self.box.transcript(UUID_OUT, "/tmp/elsewhere")
        self.assertRejected(404, self.app().spawn, {"resume": UUID_B})
        self.assertRejected(400, self.app().spawn, {"resume": UUID_OUT})
        self.assertRejected(400, self.app().spawn, {"resume": UUID_A, "cwd": str(self.box.home)})
        self.box.cli_session(os.getpid(), sessionId=UUID_A)  # this process is alive
        self.assertRejected(409, self.app().spawn, {"resume": UUID_A})

    def test_kill_refusals(self):
        tmux = FakeTmux([row("hub-term", attached=True), row("claude-busy", attached=True),
                         row("claude-keep"), row("claude-idle")])
        app = self.app(tmux, XAVIER_TMUX_PROTECTED="claude-keep")
        for name in ("hub-term", "claude-x;", "=claude-idle", "", "claude-"):
            self.assertRejected(400, app.kill, {"name": name})
        self.assertRejected(403, app.kill, {"name": "claude-keep"})
        self.assertRejected(404, app.kill, {"name": "claude-gone"})
        self.assertRejected(409, app.kill, {"name": "claude-busy"})
        self.assertRejected(400, app.kill, {"name": "claude-idle", "host": "mac"})
        self.assertEqual(tmux.calls, [])
        self.assertEqual(app.kill({"name": "claude-idle"}),
                         {"ok": True, "killed": "claude-idle", "host": "vps"})
        self.assertEqual(tmux.calls, [("kill-session", "-t", "=claude-idle")])

    def test_listing_marks_everything_unkillable_as_protected(self):
        app = self.app(FakeTmux([row("hub-term", attached=True), row("claude-1"), row("claude-keep"),
                                 row("mine")]), XAVIER_TMUX_PROTECTED="claude-keep")
        rows = {r["name"]: r for r in app.sessions()["sessions"]}
        self.assertEqual({n: r["protected"] for n, r in rows.items()},
                         {"hub-term": True, "claude-1": False, "claude-keep": True, "mine": True})
        self.assertEqual(rows["claude-1"]["host"], "vps")


class Titles(Base):
    """Ported from the original parse_titles cases, now read from disk."""

    def test_titles_follow_claude_codes_bookkeeping(self):
        me = os.getpid()  # a live pid the bookkeeping can point at
        self.box.cli_session(me, sessionId=UUID_A, cwd=f"{self.box.home}/proj", name="ai-1",
                             nameSource="derived")
        self.box.transcript(UUID_A, f"{self.box.home}/proj",
                            {"type": "ai-title", "aiTitle": "Fix the flaky build"})
        tmux = FakeTmux([row("claude-1"), row("hub-term")], panes={"claude-1": str(me), "hub-term": "1"})
        rows = {r["name"]: r for r in self.app(tmux).sessions()["sessions"]}
        self.assertEqual((rows["claude-1"]["title"], rows["claude-1"]["session_id"]),
                         ("Fix the flaky build", UUID_A))
        self.assertIsNone(rows["hub-term"]["title"])  # a pane without Claude Code

    def test_custom_title_wins_and_user_names_are_a_fallback(self):
        me = os.getpid()
        self.box.cli_session(me, sessionId=UUID_B, name="renamed", nameSource="user",
                             tmux="claude-2:@1.%1")  # pane pid is a wrapper: found via tmux field
        self.box.transcript(UUID_B, f"{self.box.home}/proj",
                            {"type": "custom-title", "customTitle": "renamed-by-user"},
                            {"type": "ai-title", "aiTitle": "A generated title"})
        tmux = FakeTmux([row("claude-2")], panes={"claude-2": "999999999"})
        self.assertEqual(self.app(tmux).sessions()["sessions"][0]["title"], "renamed-by-user")
        os.unlink(self.box.claude / "projects" / "proj" / f"{UUID_B}.jsonl")
        self.assertEqual(self.app(tmux).sessions()["sessions"][0]["title"], "renamed")

    def test_dead_cli_pids_are_ignored(self):
        self.box.cli_session(999999999, sessionId=UUID_A)
        tmux = FakeTmux([row("claude-1")], panes={"claude-1": "999999999"})
        self.assertIsNone(self.app(tmux).sessions()["sessions"][0]["session_id"])


class HistoryTests(Base):
    def fill(self):
        home = self.box.home
        paths = [
            self.box.transcript(UUID_C, f"{home}", {"type": "custom-title", "customTitle": "main"}),
            self.box.transcript(UUID_B, f"{home}/proj"),
            self.box.transcript(UUID_SDK, f"{home}/proj", {"type": "ai-title", "aiTitle": "Review"},
                                entrypoint="sdk-py"),
            self.box.transcript(UUID_OUT, "/tmp/elsewhere"),
            self.box.transcript(UUID_A, f"{home}/proj", {"type": "ai-title", "aiTitle": "Plan 2"}),
        ]
        for i, p in enumerate(paths):  # oldest first
            os.utime(p, (1788300000 + i, 1788300000 + i))
        (self.box.claude / "projects" / "proj" / "not-a-uuid.jsonl").write_text("{}\n")
        sub = self.box.claude / "projects" / "proj" / UUID_A
        sub.mkdir()
        (sub / f"{UUID_T}.jsonl").write_text("{}\n")  # a subagent log, one level deeper
        secret = self.box.home / "secret"
        secret.write_text(json.dumps({"type": "custom-title", "customTitle": "leaked",
                                      "cwd": str(home)}) + "\n")
        (self.box.claude / "projects" / "proj" / f"{UUID_T}.jsonl").symlink_to(secret)

    def test_titles_and_ids_only_newest_first(self):
        self.fill()
        self.box.cli_session(os.getpid(), sessionId=UUID_A)
        out = self.app().history()
        rows = out["sessions"]
        self.assertEqual([r["session_id"] for r in rows], [UUID_A, UUID_B, UUID_C])
        self.assertEqual(rows[0], {"host": "vps", "session_id": UUID_A, "title": "Plan 2", "cwd": None,
                                   "last_active": 1788300004, "live": True})
        self.assertEqual([r["title"] for r in rows], ["Plan 2", None, "main"])
        self.assertFalse(rows[1]["live"])
        self.assertNotIn("prompt", json.dumps(out))
        self.assertEqual(out["hosts"], [{"id": "vps", "label": "This machine", "ok": True, "error": None}])

    def test_cwd_only_when_the_operator_opts_in(self):
        self.fill()
        rows = self.app(XAVIER_TMUXD_HISTORY_SHOW_CWD="1").history()["sessions"]
        self.assertEqual(rows[0]["cwd"], os.path.realpath(self.box.home / "proj"))

    def test_limit(self):
        self.fill()
        self.assertEqual(len(self.app(XAVIER_TMUXD_HISTORY_LIMIT="2").history()["sessions"]), 2)


class ScannerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="hub-tmuxd-scan-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = self.dir / f"{UUID_A}.jsonl"

    def scan(self, scanner):
        return scanner.scan(self.path, os.lstat(self.path))

    def test_appends_are_read_incrementally(self):
        s = tmuxd.TranscriptScanner()
        self.path.write_text('{"cwd":"/home/u/p","entrypoint":"cli"}\n{"type":"ai-title","aiTitle":"One"}\n')
        meta = self.scan(s)
        self.assertEqual((meta.cwd, meta.entrypoint, meta.title), ("/home/u/p", "cli", "One"))
        with open(self.path, "a") as f:
            f.write('{"type":"custom-title","custom')  # half a line: not parsed yet
        self.assertEqual(self.scan(s).title, "One")
        with open(self.path, "a") as f:
            f.write('Title":"Two"}\n')
        self.assertEqual(self.scan(s).title, "Two")

    def test_a_replaced_file_is_rescanned(self):
        s = tmuxd.TranscriptScanner()
        self.path.write_text('{"type":"ai-title","aiTitle":"Old title that is long"}\n')
        self.scan(s)
        self.path.write_text('{"type":"ai-title","aiTitle":"New"}\n')
        self.assertEqual(self.scan(s).title, "New")

    def test_overlong_lines_are_skipped_whole(self):
        s = tmuxd.TranscriptScanner()
        s.MAX_LINE = 64
        s.CHUNK = 16
        self.path.write_text('{"type":"ai-title","aiTitle":"' + "x" * 200 + '"}\n'
                             '{"type":"ai-title","aiTitle":"Short"}\n')
        self.assertEqual(self.scan(s).title, "Short")

    def test_escaped_strings_decode_and_control_characters_go(self):
        s = tmuxd.TranscriptScanner()
        self.path.write_text('{"cwd":"/home/u/a\\u00e9"}\n{"type":"ai-title","aiTitle":"bell\\u0007 ok"}\n')
        meta = self.scan(s)
        self.assertEqual(meta.cwd, "/home/u/aé")
        self.assertEqual(meta.title, "bell ok")


def call(sock_path, method, path, body=None, raw=None):
    conn = http.client.HTTPConnection("localhost", timeout=15)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(15)
    s.connect(str(sock_path))
    conn.sock = s
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    conn.request(method, path, body=data, headers={"Content-Type": "application/json"})
    r = conn.getresponse()
    payload = r.read()
    conn.close()
    return r.status, json.loads(payload or b"{}")


class Served(Base):
    """A real UnixServer on a socket in the box."""

    def serve(self, **env):
        srv = tmuxd.UnixServer(self.box.config(**env))
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def stop():
            srv.shutdown()
            srv.remove_socket()
            srv.server_close()
        self.addCleanup(stop)
        return srv

    @property
    def sock(self):
        return self.box.run / "tmuxd.sock"


class SocketTests(Served):
    def test_socket_is_born_0660_and_0600_on_request(self):
        self.serve()
        self.assertEqual(stat.S_IMODE(os.lstat(self.sock).st_mode), 0o660)
        self.assertTrue(stat.S_ISSOCK(os.lstat(self.sock).st_mode))

    def test_owner_only_mode(self):
        self.serve(XAVIER_SOCKET_MODE="0600")
        self.assertEqual(stat.S_IMODE(os.lstat(self.sock).st_mode), 0o600)

    def test_refuses_a_directory_others_can_reach(self):
        for mode in (0o755, 0o770, 0o751, 0o777):
            os.chmod(self.box.run, mode)
            with self.subTest(mode=oct(mode)), self.assertRaises(tmuxd.ConfigError):
                tmuxd.UnixServer(self.box.config())
        os.chmod(self.box.run, 0o750)

    def test_creates_a_missing_directory_owner_only(self):
        run = self.box.tmp / "fresh" / "run"
        srv = tmuxd.UnixServer(self.box.config(XAVIER_RUN_DIR=str(run)))
        self.addCleanup(srv.server_close)
        self.assertEqual(stat.S_IMODE(os.stat(run).st_mode), 0o700)

    def test_never_replaces_a_file_that_is_not_a_socket(self):
        self.sock.write_text("not a socket")
        with self.assertRaises(tmuxd.ConfigError):
            tmuxd.UnixServer(self.box.config())
        self.assertEqual(self.sock.read_text(), "not a socket")

    def test_replaces_a_stale_socket_but_not_a_live_one(self):
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(str(self.sock))
        stale.close()  # file left behind, nobody listening
        self.serve()
        with self.assertRaises(tmuxd.ConfigError):
            tmuxd.UnixServer(self.box.config())

    def test_http_edges(self):
        self.serve()
        self.assertEqual(call(self.sock, "GET", "/healthz"), (200, {"ok": True}))
        self.assertEqual(call(self.sock, "GET", "/nope")[0], 404)
        self.assertEqual(call(self.sock, "GET", "/spawn")[0], 404)
        self.assertEqual(call(self.sock, "POST", "/sessions")[0], 404)
        self.assertEqual(call(self.sock, "POST", "/kill", raw=b"{not json")[0], 400)
        self.assertEqual(call(self.sock, "POST", "/kill", raw=b"[1]")[0], 400)
        self.assertEqual(call(self.sock, "POST", "/spawn", raw=b"x" * 5000)[0], 413)
        status, body = call(self.sock, "POST", "/kill", {"name": "hub-term"})
        self.assertEqual(status, 400)
        self.assertIn("claude-*", body["error"])


FAKE_CLAUDE = r"""#!/bin/sh
# Stand-in for Claude Code: records how it was started, registers itself the way the
# CLI does (sessions/<pid>.json), then stays alive.
name=$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)
out="$HOME/fake-claude"
mkdir -p "$out" "$HOME/.claude/sessions"
sid=@UUID_T@
prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && sid="$a"; prev="$a"; done
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","tmux":"%s:@0.%%0"}' "$$" "$sid" "$PWD" "$name" \
  > "$HOME/.claude/sessions/$$.json"
{
  echo "pid=$$"
  echo "pwd=$PWD"
  echo "argc=$#"
  for a in "$@"; do echo "arg=$a"; done
  env | sed 's/^/env=/'
} > "$out/$name.tmp" && mv "$out/$name.tmp" "$out/$name"
exec sleep 300
"""


@unittest.skipUnless(HAS_TMUX, "tmux is not installed")
class LiveTmux(Served):
    def setUp(self) -> None:
        super().setUp()
        fake = self.box.bin / "claude"
        fake.write_text(FAKE_CLAUDE.replace("@UUID_T@", UUID_T))
        fake.chmod(0o755)
        self.marker = self.box.tmp / "pwned"

    def started(self, name, timeout=8.0):
        path = self.box.home / "fake-claude" / name
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.exists():
                rec = {"arg": [], "env": {}}
                for line in path.read_text().splitlines():
                    key, _, value = line.partition("=")
                    if key == "arg":
                        rec["arg"].append(value)
                    elif key == "env":
                        k, _, v = value.partition("=")
                        rec["env"][k] = v
                    else:
                        rec[key] = value
                return rec
            time.sleep(0.05)
        self.fail(f"{name} never started")

    def names(self):
        r = self.box.tmux("list-sessions", "-F", "#{session_name}")
        return sorted(r.stdout.split()) if r.returncode == 0 else []

    def test_spawn_runs_claude_alone_in_a_scrubbed_environment(self):
        self.serve()
        status, body = call(self.sock, "POST", "/spawn", {})
        self.assertEqual(status, 200, body)
        rec = self.started(body["name"])
        self.assertEqual(rec["arg"], [])  # no permission bypass, no remote control
        self.assertEqual(rec["pwd"], os.path.realpath(self.box.home))
        for leaked in ("FAKE_SECRET_TOKEN", "AWS_SECRET_ACCESS_KEY", "XAVIER_CLAUDE_BIN"):
            self.assertNotIn(leaked, rec["env"])
        self.assertEqual(rec["env"]["HOME"], str(self.box.home))

    def test_opt_in_flags_reach_the_binary(self):
        self.serve(XAVIER_CLAUDE_REMOTE_CONTROL="1", XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS="1")
        status, body = call(self.sock, "POST", "/spawn", {"name": "flags"})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.started("claude-flags")["arg"],
                         ["--remote-control", "--dangerously-skip-permissions"])

    def test_injection_payloads_change_nothing(self):
        self.serve()
        m = self.marker
        payloads = [
            {"name": f"x#(touch {m})"}, {"name": "a;"}, {"name": "a ;"},
            {"cwd": f"{self.box.home}/#(touch {m})"}, {"cwd": f"{self.box.home}/x;"},
            {"resume": f"#(touch {m})"}, {"resume": f"{UUID_A};"},
        ]
        for body in payloads:
            with self.subTest(body=body):
                self.assertEqual(call(self.sock, "POST", "/spawn", body)[0], 400)
        for name in (f"claude-x#(touch {m})", "claude-a;", "=claude-1"):
            self.assertEqual(call(self.sock, "POST", "/kill", {"name": name})[0], 400)
        time.sleep(0.3)
        self.assertFalse(m.exists())
        self.assertEqual(self.names(), [])

    def test_kill_is_limited_to_the_daemons_sessions(self):
        self.serve()
        self.assertEqual(self.box.tmux("new-session", "-d", "-s", "hub-term", "--", "sleep", "300").returncode, 0)
        self.assertEqual(call(self.sock, "POST", "/spawn", {"name": "a"})[0], 200)
        self.started("claude-a")
        listing = {r["name"]: r for r in call(self.sock, "GET", "/sessions")[1]["sessions"]}
        self.assertTrue(listing["hub-term"]["protected"])
        self.assertFalse(listing["claude-a"]["protected"])
        self.assertEqual(listing["claude-a"]["session_id"], UUID_T)
        self.assertEqual(call(self.sock, "POST", "/kill", {"name": "hub-term"})[0], 400)
        self.assertEqual(call(self.sock, "POST", "/kill", {"name": "claude-a"})[0], 200)
        self.assertEqual(self.names(), ["hub-term"])

    def test_resume_starts_in_the_transcripts_directory(self):
        self.box.transcript(UUID_A, f"{self.box.home}/proj", {"type": "ai-title", "aiTitle": "Plan"})
        self.serve()
        status, body = call(self.sock, "POST", "/spawn", {"resume": UUID_A})
        self.assertEqual(status, 200, body)
        rec = self.started(body["name"])
        self.assertEqual(rec["pwd"], os.path.realpath(self.box.home / "proj"))
        self.assertEqual(rec["arg"], ["--resume", UUID_A])
        # Now that it is open in a running CLI, a second resume would fork it.
        self.assertEqual(call(self.sock, "POST", "/spawn", {"resume": UUID_A})[0], 409)
        hist = call(self.sock, "GET", "/history")[1]["sessions"]
        self.assertEqual([(h["session_id"], h["title"], h["live"], h["cwd"]) for h in hist],
                         [(UUID_A, "Plan", True, None)])

    def test_session_limit_holds_against_a_real_server(self):
        self.serve(XAVIER_TMUXD_MAX_SESSIONS="1")
        self.assertEqual(call(self.sock, "POST", "/spawn", {})[0], 200)
        self.assertEqual(call(self.sock, "POST", "/spawn", {})[0], 429)


if __name__ == "__main__":
    unittest.main()
