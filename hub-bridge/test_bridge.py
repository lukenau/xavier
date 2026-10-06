"""hub-bridge tests — stdlib unittest, no sockets, no real exec.

Run: python3 -m unittest -v   (from this directory)

Covers the security-critical logic: the bearer-key gate (refusal, acceptance,
fail-closed), the read/write allowlist split, and the allowlist rejecting
injection, unknown commands, path traversal and option injection. The exec layer
is stubbed, so nothing runs `docker` or `hermes`.
"""
import importlib
import os
import tempfile
import unittest

# Point the key file at a temp path BEFORE importing the module (the default path
# does not exist in CI, which must read as "fail closed", not crash).
_KEYDIR = tempfile.mkdtemp()
_KEYFILE = os.path.join(_KEYDIR, "HUB_BRIDGE_KEY")
os.environ["HUB_BRIDGE_KEY_FILE"] = _KEYFILE
os.environ["BRIDGE_EXEC"] = "local"

bridge = importlib.import_module("bridge")

KEY = "k" * 48


def _write_key(value: str | None) -> None:
    if value is None:
        if os.path.exists(_KEYFILE):
            os.remove(_KEYFILE)
        return
    with open(_KEYFILE, "w", encoding="utf-8") as fh:
        fh.write(value + "\n")


class Headers(dict):
    """Minimal case-sensitive stand-in for the handler's self.headers.get()."""
    def get(self, name, default=None):
        return dict.get(self, name, default)


def auth_header(value: str | None) -> Headers:
    return Headers({} if value is None else {"Authorization": value})


class AuthTests(unittest.TestCase):
    def setUp(self):
        _write_key(KEY)

    def test_fail_closed_when_no_key_configured(self):
        _write_key(None)
        ok, status, _ = bridge.authorize(auth_header(f"Bearer {KEY}"))
        self.assertFalse(ok)
        self.assertEqual(status, 503)

    def test_missing_bearer_is_401(self):
        ok, status, _ = bridge.authorize(auth_header(None))
        self.assertFalse(ok)
        self.assertEqual(status, 401)

    def test_wrong_key_is_401(self):
        ok, status, _ = bridge.authorize(auth_header("Bearer wrong"))
        self.assertFalse(ok)
        self.assertEqual(status, 401)

    def test_malformed_scheme_is_401(self):
        ok, status, _ = bridge.authorize(auth_header(KEY))  # no "Bearer " prefix
        self.assertFalse(ok)
        self.assertEqual(status, 401)

    def test_correct_key_accepted(self):
        ok, status, _ = bridge.authorize(auth_header(f"Bearer {KEY}"))
        self.assertTrue(ok)
        self.assertEqual(status, 200)


class RouteAuthTests(unittest.TestCase):
    """Every endpoint except /healthz must gate on the key before doing anything."""
    def setUp(self):
        _write_key(KEY)
        self._orig = bridge.run_command
        bridge.run_command = lambda argv: {"stdout": "RAN", "stderr": "", "code": 0}

    def tearDown(self):
        bridge.run_command = self._orig

    def test_healthz_is_open(self):
        status, payload = bridge.route_get("/healthz", {}, auth_header(None))
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})

    def test_run_requires_key(self):
        status, _ = bridge.route_post("/run", auth_header(None), {"argv": ["cron", "list"]})
        self.assertEqual(status, 401)

    def test_run_write_requires_key(self):
        status, _ = bridge.route_post(
            "/run-write", auth_header(None), {"argv": ["config", "set", "model.default", "x"]})
        self.assertEqual(status, 401)

    def test_config_raw_requires_key(self):
        status, _ = bridge.route_get("/config-raw", {}, auth_header(None))
        self.assertEqual(status, 401)

    def test_run_with_key_runs(self):
        status, payload = bridge.route_post(
            "/run", auth_header(f"Bearer {KEY}"), {"argv": ["cron", "list"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["stdout"], "RAN")


class ReadWriteSplitTests(unittest.TestCase):
    def test_write_rejected_on_read_endpoint(self):
        self.assertFalse(bridge.validate_argv(["config", "set", "model.default", "x"]))
        self.assertFalse(bridge.validate_argv(["cron", "remove", "job1"]))
        self.assertFalse(bridge.validate_argv(["gateway", "restart"]))

    def test_read_rejected_on_write_endpoint(self):
        self.assertFalse(bridge.validate_write_argv(["config", "show"]))
        self.assertFalse(bridge.validate_write_argv(["cron", "list"]))
        self.assertFalse(bridge.validate_write_argv(["doctor"]))

    def test_reads_accepted_on_read(self):
        for argv in (["config", "show"], ["cron", "list", "--all"], ["doctor"],
                     ["kanban", "list", "--json"], ["sessions", "list", "--limit", "50"],
                     ["auth", "status", "nous"]):
            self.assertTrue(bridge.validate_argv(argv), argv)

    def test_writes_accepted_on_write(self):
        for argv in (["config", "set", "model.default", "claude-sonnet-4-6"],
                     ["cron", "pause", "job_1"], ["cron", "run", "job_1", "--accept-hooks"],
                     ["cron", "create", "30m", "do a thing", "--name", "x"],
                     ["pairing", "approve", "telegram", "12345"], ["gateway", "restart"]):
            self.assertTrue(bridge.validate_write_argv(argv), argv)


class AllowlistRejectionTests(unittest.TestCase):
    def test_unknown_commands(self):
        for argv in (["rm", "-rf", "/"], ["bash"], ["sh", "-c", "id"], ["config", "edit"],
                     ["cron", "nuke"], ["eval", "x"], ["--version"]):
            self.assertFalse(bridge.validate_argv(argv), argv)
            self.assertFalse(bridge.validate_write_argv(argv), argv)

    def test_shell_metachar_injection(self):
        for bad in ("job1; rm -rf /", "job1 && id", "job1\nid", "job1\x00", "$(id)", "`id`", "a|b"):
            self.assertFalse(bridge.validate_write_argv(["cron", "remove", bad]), bad)

    def test_path_traversal_in_names(self):
        self.assertFalse(bridge.validate_argv(["config", "get", "../../etc/passwd"]))
        self.assertFalse(bridge.validate_write_argv(["cron", "remove", "../../x"]))
        self.assertFalse(bridge.validate_argv(["kanban", "show", "../secret"]))

    def test_option_injection_values(self):
        # A value or field that starts with '-' must be rejected, so it can't be
        # read as a flag by the downstream CLI.
        self.assertFalse(bridge.validate_write_argv(["config", "set", "model.default", "--force"]))
        self.assertFalse(bridge.validate_write_argv(["cron", "create", "--malicious"]))
        self.assertFalse(bridge.validate_write_argv(
            ["cron", "create", "30m", "p", "--name", "--deliver"]))

    def test_config_set_refuses_secret_and_env_keys(self):
        for key in ("model.api_key", "gateway.telegram.token", "some.password",
                    "AWS_SECRET", "OPENAI_API_KEY", "PATH"):
            self.assertFalse(bridge.validate_write_argv(["config", "set", key, "v"]), key)

    def test_config_set_refuses_the_model_endpoint(self):
        for key in ("model.base_url", "model.api_mode"):
            self.assertFalse(bridge.validate_write_argv(["config", "set", key, "https://x.example"]), key)
        self.assertTrue(bridge.validate_write_argv(["config", "set", "model.default", "some/model"]))

    def test_config_set_allows_plain_scalar_key(self):
        self.assertTrue(bridge.validate_write_argv(["config", "set", "agent.max_turns", "40"]))

    def test_malformed_argv(self):
        for argv in (None, [], "config show", ["config", 1], [""], ["config", "show", "\n"]):
            self.assertFalse(bridge.validate_argv(argv), argv)


class ParamValidationTests(unittest.TestCase):
    def test_spend_params(self):
        now = int(bridge.time.time())
        self.assertIsNotNone(bridge.validate_spend(
            {"cutoff_epoch": now - 86400, "split_epoch": now - 3600, "granularity": "day"}))
        # bad granularity, bool-as-int, cutoff after split, too-far lookback
        self.assertIsNone(bridge.validate_spend(
            {"cutoff_epoch": now, "split_epoch": now, "granularity": "year"}))
        self.assertIsNone(bridge.validate_spend(
            {"cutoff_epoch": True, "split_epoch": now, "granularity": "day"}))
        self.assertIsNone(bridge.validate_spend(
            {"cutoff_epoch": now, "split_epoch": now - 100, "granularity": "day"}))
        self.assertIsNone(bridge.validate_spend(
            {"cutoff_epoch": now - 300 * 86400, "split_epoch": now, "granularity": "day"}))

    def test_cron_logs_params(self):
        self.assertEqual(bridge.validate_cron_logs({"limit": 40}), 40)
        self.assertIsNone(bridge.validate_cron_logs({"limit": 0}))
        self.assertIsNone(bridge.validate_cron_logs({"limit": 9999}))
        self.assertIsNone(bridge.validate_cron_logs({"limit": True}))
        self.assertIsNone(bridge.validate_cron_logs({"limit": "40"}))


class ExecTemplateTests(unittest.TestCase):
    """The exec template can only ever run `hermes <argv>` — an argv cannot turn
    into a different program or a `docker run`."""
    def test_local_mode_has_no_docker(self):
        # module imported with BRIDGE_EXEC=local
        self.assertEqual(bridge._hermes_cmd(["cron", "list"]), ["hermes", "cron", "list"])

    def test_docker_mode_fixed_prefix(self):
        orig = bridge.BRIDGE_EXEC
        try:
            bridge.BRIDGE_EXEC = "docker"
            cmd = bridge._hermes_cmd(["cron", "list"])
            self.assertEqual(cmd[:3], ["docker", "exec", bridge.HERMES_CONTAINER])
            self.assertEqual(cmd[3], "hermes")
        finally:
            bridge.BRIDGE_EXEC = orig


if __name__ == "__main__":
    unittest.main()
