"""python3 -m unittest discover -s host -p 'test_*.py'

Checks what host/install.sh would install (via --render, which needs no root and starts
nothing), the ttyd command wrapper, the compose override and the macOS templates.
"""

import grp
import os
import plistlib
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOST = Path(__file__).resolve().parent
sys.path.insert(0, str(HOST / "hub-tmuxd"))
import tmuxd  # noqa: E402

ME = pwd.getpwuid(os.getuid())
MY_GROUP = grp.getgrgid(ME.pw_gid).gr_name
UNITS = ("xavier-tmux.service", "xavier-ttyd.service", "xavier-tmuxd.service")


def render(**env):
    out = Path(tempfile.mkdtemp(prefix="host-render-"))
    full = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "XAVIER_USER": ME.pw_name,
            "XAVIER_TTYD_BIN": "/usr/bin/ttyd", "XAVIER_TMUX_BIN": "/usr/bin/tmux",
            "XAVIER_PYTHON": "/usr/bin/python3", **env}
    r = subprocess.run(["bash", str(HOST / "install.sh"), "--render", str(out)], env=full,
                       capture_output=True, text=True, timeout=30)
    files = {p.name: p.read_text() for p in out.iterdir()} if r.returncode == 0 else {}
    shutil.rmtree(out, ignore_errors=True)
    return r, files


def directives(unit: str) -> dict:
    out: dict = {}
    for line in unit.splitlines():
        if line and not line.startswith(("#", "[")) and "=" in line:
            key, _, value = line.partition("=")
            out.setdefault(key, []).append(value)
    return out


@unittest.skipUnless(shutil.which("bash") and sys.platform.startswith("linux"), "Linux + bash only")
class Rendered(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r, cls.files = render()

    def test_renders_everything_with_no_placeholder_left(self):
        self.assertEqual(self.r.returncode, 0, self.r.stderr)
        self.assertEqual(sorted(self.files), sorted([*UNITS, "tmuxd.conf"]))
        for name, text in self.files.items():
            self.assertIsNone(re.search(r"@[A-Z_]+@", text), name)

    def test_ttyd_never_listens_on_tcp(self):
        unit = directives(self.files["xavier-ttyd.service"])
        argv = unit["ExecStart"][0].split()
        self.assertEqual(argv[0], "/usr/bin/ttyd")
        iface = argv[argv.index("--interface") + 1]
        self.assertEqual(iface, "/run/xavier/ttyd.sock")
        self.assertTrue(iface.endswith(".sock"))  # anything else: ttyd binds TCP 7681
        for flag in ("-p", "--port", "-a", "--url-arg", "-c", "--credential", "-6", "--ipv6"):
            self.assertNotIn(flag, argv)
        self.assertIn("--writable", argv)
        self.assertEqual(argv[argv.index("--base-path") + 1], "/terminal")
        self.assertEqual(unit["IPAddressDeny"], ["any"])
        self.assertEqual(unit["RestrictAddressFamilies"], ["AF_UNIX AF_NETLINK"])

    def test_socket_directory_and_modes(self):
        for name in ("xavier-ttyd.service", "xavier-tmuxd.service"):
            unit = directives(self.files[name])
            self.assertEqual(unit["RuntimeDirectory"], ["xavier"], name)
            self.assertEqual(unit["RuntimeDirectoryMode"], ["0750"], name)
            self.assertEqual(unit["RuntimeDirectoryPreserve"], ["yes"], name)
            self.assertEqual(unit["User"], [ME.pw_name], name)
            self.assertEqual(unit["Group"], ["xavier-hub"], name)
        self.assertEqual(directives(self.files["xavier-ttyd.service"])["UMask"], ["0117"])
        tmux = directives(self.files["xavier-tmux.service"])
        self.assertEqual(tmux["RuntimeDirectory"], ["xavier-tmux"])
        self.assertEqual(tmux["RuntimeDirectoryMode"], ["0700"])
        self.assertEqual(tmux["Group"], [MY_GROUP])  # shells never run in the hub's group
        for text in self.files.values():
            self.assertNotRegex(text, r"\b0?666\b|\b0?777\b|chmod")

    def test_hardening_on_every_unit(self):
        for name in UNITS:
            unit = directives(self.files[name])
            for key, value in (("NoNewPrivileges", "yes"), ("ProtectSystem", "strict"),
                               ("PrivateTmp", "yes"), ("RestrictSUIDSGID", "yes")):
                self.assertEqual(unit.get(key), [value], f"{name} {key}")
        self.assertEqual(directives(self.files["xavier-ttyd.service"])["ProtectHome"], ["read-only"])
        tmuxd_unit = directives(self.files["xavier-tmuxd.service"])
        self.assertEqual(tmuxd_unit["ProtectHome"], ["read-only"])
        self.assertEqual(tmuxd_unit["RestrictAddressFamilies"], ["AF_UNIX"])
        self.assertEqual(directives(self.files["xavier-tmux.service"])["ReadWritePaths"], [ME.pw_dir])

    def test_all_three_share_one_private_tmux_server(self):
        tmux = directives(self.files["xavier-tmux.service"])
        self.assertEqual(tmux["ExecStart"], ["/usr/bin/tmux -L xavier -D"])
        for name in UNITS:
            self.assertIn("TMUX_TMPDIR=/run/xavier-tmux", directives(self.files[name])["Environment"], name)
        for name in ("xavier-ttyd.service", "xavier-tmuxd.service"):
            unit = directives(self.files[name])
            self.assertEqual(unit["Requires"], ["xavier-tmux.service"])
            self.assertIn("XAVIER_TMUX_SOCKET_NAME=xavier", unit["Environment"])

    def test_tmuxd_conf_ships_the_safe_defaults(self):
        conf = dict(line.split("=", 1) for line in self.files["tmuxd.conf"].splitlines()
                    if line and not line.startswith("#"))
        self.assertEqual(conf["XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"], "0")
        self.assertEqual(conf["XAVIER_CLAUDE_REMOTE_CONTROL"], "0")
        self.assertEqual(conf["XAVIER_TMUXD_HISTORY_SHOW_CWD"], "0")
        self.assertEqual(conf["XAVIER_CWD_ROOTS"], ME.pw_dir)
        cfg = tmuxd.Config.from_env({**conf, "HOME": ME.pw_dir})
        self.assertFalse(cfg.skip_permissions or cfg.remote_control or cfg.history_show_cwd)
        self.assertEqual(cfg.claude_bin, f"{ME.pw_dir}/.local/bin/claude")


@unittest.skipUnless(shutil.which("bash") and sys.platform.startswith("linux"), "Linux + bash only")
class RenderRefusals(unittest.TestCase):
    def refused(self, needle=None, **env):
        r, _ = render(**env)
        self.assertNotEqual(r.returncode, 0, env)
        if needle:
            self.assertIn(needle, r.stderr)

    def test_a_ttyd_socket_name_that_would_mean_tcp(self):
        for name in ("ttyd", "eth0", "ttyd.socket.bak", "../ttyd.sock", "a b.sock"):
            with self.subTest(name=name):
                self.refused(XAVIER_TTYD_SOCKET_NAME=name)
        self.refused("TCP", XAVIER_TTYD_SOCKET_NAME="lo")

    def test_socket_directory_outside_run(self):
        for d in ("/tmp/xavier", "/run/../etc", "/run/a/b", "/srv/hub", "/run/"):
            with self.subTest(d=d):
                self.refused(XAVIER_RUN_DIR=d)

    def test_root_and_odd_users(self):
        self.refused("root", XAVIER_USER="root")
        self.refused(XAVIER_USER="no-such-user-xyz")
        self.refused(XAVIER_USER="bad;name")
        self.refused(XAVIER_SOCKET_GROUP=MY_GROUP)

    def test_paths_that_could_break_a_unit_line(self):
        for env in ({"XAVIER_CWD_ROOTS": "/home/x;rm"}, {"XAVIER_CWD_ROOTS": "/*"},
                    {"XAVIER_CWD_ROOTS": f"{ME.pw_dir}/../.."}, {"XAVIER_CLAUDE_BIN": "/a b/claude"},
                    {"XAVIER_RW_PATHS": "/srv/$(id)"}, {"XAVIER_SHELL_PATH": "/bin:relative"},
                    {"XAVIER_TERM_SESSION": "claude-term"}, {"XAVIER_TTYD_BIN": "/usr/bin/ttyd|x"}):
            with self.subTest(env=env):
                self.refused(**env)

    def test_extra_writable_paths_are_rendered(self):
        r, files = render(XAVIER_RW_PATHS="/srv/a /srv/b")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(directives(files["xavier-tmux.service"])["ReadWritePaths"],
                         [f"{ME.pw_dir} /srv/a /srv/b"])


class Scripts(unittest.TestCase):
    def test_shell_syntax(self):
        if shutil.which("bash"):
            subprocess.run(["bash", "-n", str(HOST / "install.sh")], check=True)
        subprocess.run(["sh", "-n", str(HOST / "terminal" / "xavier-term")], check=True)

    def test_wrapper_attaches_with_a_normal_umask(self):
        tmp = Path(tempfile.mkdtemp(prefix="host-wrapper-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        fake = tmp / "tmux"
        fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$OUT"; umask >> "$OUT"\n')
        fake.chmod(0o755)
        out = tmp / "out"
        env = {"PATH": "/usr/bin:/bin", "XAVIER_TMUX_BIN": str(fake), "OUT": str(out)}
        subprocess.run(["sh", "-c", f"umask 0117; exec {HOST / 'terminal' / 'xavier-term'}"],
                       env=env, check=True, timeout=10)
        lines = out.read_text().split()
        self.assertEqual(lines[:-1], ["-L", "xavier", "new-session", "-A", "-s", "hub-term"])
        self.assertEqual(int(lines[-1], 8), 0o022)

    def test_no_template_or_program_widens_a_socket(self):
        for p in [*HOST.rglob("*.in"), HOST / "install.sh", HOST / "terminal" / "xavier-term",
                  HOST / "hub-tmuxd" / "tmuxd.py", HOST / "compose.host.yml"]:
            text = p.read_text()
            self.assertNotRegex(text, r"\b0?666\b|0o666|\b0?777\b|0o777|chmod [ao]?\+", p.name)

    def test_compose_override(self):
        text = (HOST / "compose.host.yml").read_text()
        body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
        self.assertIn('"${XAVIER_RUN_DIR:-/run/xavier}:/run/xavier:ro"', body)
        self.assertIn("${XAVIER_HUB_GID:?", body)
        self.assertIn('HUB_TTYD_SOCK: "/run/xavier/${XAVIER_TTYD_SOCKET_NAME:-ttyd.sock}"', body)
        self.assertIn('HUB_TMUXD_SOCK: "/run/xavier/${XAVIER_TMUXD_SOCKET_NAME:-tmuxd.sock}"', body)
        for bad in ("0.0.0.0", "docker.sock", "privileged", "network_mode", "ports:", "/data"):
            self.assertNotIn(bad, body)

    def test_macos_templates(self):
        fill = {"@HOME@": "/Users/someone", "@REPO@": "/Users/someone/xavier", "@BREW@": "/opt/homebrew"}
        for name in ("terminal/local.xavier.ttyd.plist.in", "hub-tmuxd/local.xavier.tmuxd.plist.in"):
            text = (HOST / name).read_text()
            for k, v in fill.items():
                text = text.replace(k, v)
            self.assertIsNone(re.search(r"@[A-Z_]+@", text), name)
            plist = plistlib.loads(text.encode())
            argv = plist["ProgramArguments"]
            if "--interface" in argv:
                self.assertTrue(argv[argv.index("--interface") + 1].endswith(".sock"))
                self.assertNotIn("--port", argv)
                self.assertEqual(plist["Umask"], "0077")
            else:
                self.assertEqual(plist["EnvironmentVariables"]["XAVIER_SOCKET_MODE"], "0600")


if __name__ == "__main__":
    unittest.main()
