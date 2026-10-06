#!/usr/bin/env python3
"""hub-tmuxd: lists, starts, resumes and stops the Claude Code tmux sessions behind the
Xavier hub's shell picker. HTTP/1.0 + JSON over a unix socket; the hub (server/app.py,
HUB_TMUXD_SOCK) is the only intended client.

  GET  /healthz   {"ok": true}
  GET  /sessions  {"sessions": [{name, created, attached, windows, protected, host,
                                 title, session_id}], "hosts": [{id, label, ok, error}]}
  GET  /history   {"sessions": [{host, session_id, title, cwd, last_active, live}],
                   "hosts": [...]}
  POST /spawn     {"name"?: slug, "cwd"?: path, "resume"?: session id, "host"?: "vps"}
  POST /kill      {"name": "<prefix><slug>", "host"?: "vps"}

Access control is the filesystem. The daemon refuses to start unless its socket
directory belongs to it and is closed to everyone else, and it creates the socket 0660
(XAVIER_SOCKET_MODE) so that only this user and one group, the hub's, can connect.
Anything that CAN connect may start Claude Code in an allowed directory and stop the
sessions this daemon owns; Face ID is enforced by the hub before it calls here.

Every tmux call is an argv list, never a shell string, against the kit's own tmux server
(tmux -L XAVIER_TMUX_SOCKET_NAME) with a scrubbed environment. Caller-supplied values are
matched against strict patterns before they reach tmux, because tmux re-parses its
arguments: an argument ending in ";" starts a second tmux command, and the -s and -c
values are expanded as formats, in which #(...) runs a shell command.

Configuration is environment only (host/README.md lists every variable). Python 3.9+,
standard library only.
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
from dataclasses import dataclass, field, replace
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

LOCAL_ID = "vps"  # the app and the hub both treat this id as "the machine the hub runs on"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# No '#', ';', '$', quotes, spaces or '~': see the module docstring for why '#' and ';'
# matter to tmux. The same set as the hub's _TMUX_CWD_RE.
CWD_RE = re.compile(r"^/[A-Za-z0-9_./-]{0,254}$")
BIN_RE = re.compile(r"^/[A-Za-z0-9_./+-]{1,254}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
PREFIX_RE = re.compile(r"^[a-z][a-z0-9-]{0,15}$")
SOCKET_NAME_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$")
LIST_FMT = "#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}"
PANE_FMT = "#{session_name}\t#{pane_pid}"
MAX_BODY = 4096
MAX_JSON_FILE = 64 * 1024
# The only variables a tmux client (and so a tmux server it starts, and every session
# in it) inherits from this daemon. Everything else is dropped: a token exported where
# the daemon was started must not reach a prompt-injectable Claude Code process.
ENV_KEEP = ("HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TZ", "TERM",
            "TMUX_TMPDIR", "CLAUDE_CONFIG_DIR")
SPAWN_KEYS = frozenset({"host", "name", "cwd", "resume"})
KILL_KEYS = frozenset({"host", "name"})


class ConfigError(Exception):
    pass


class Rejected(Exception):
    """A request the daemon refuses, with the HTTP status to answer it with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _flag(env, name: str) -> bool:
    raw = env.get(name, "").strip().lower()
    if raw in ("", "0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    raise ConfigError(f"{name} must be 0 or 1, not {raw!r}")


def _int(env, name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    if not raw.isdigit() or not lo <= int(raw) <= hi:
        raise ConfigError(f"{name} must be a whole number from {lo} to {hi}")
    return int(raw)


def _bin(env, name: str, default: str) -> str:
    value = env.get(name, "").strip() or default
    if not BIN_RE.match(value):
        raise ConfigError(f"{name} must be an absolute path of letters, digits and ._+-/")
    return value


def _which(name: str, path: str) -> str:
    for d in path.split(os.pathsep):
        candidate = os.path.join(d, name)
        if d.startswith("/") and os.access(candidate, os.X_OK):
            return candidate
    return f"/usr/bin/{name}"


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def child_env(env) -> dict[str, str]:
    out = {k: env[k] for k in ENV_KEEP if env.get(k)}
    out.update({k: v for k, v in env.items() if k.startswith("LC_") and v})
    out.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    return out


@dataclass(frozen=True)
class Config:
    socket_path: str
    socket_mode: int
    tmux_bin: str
    tmux_socket_name: str
    term_session: str
    prefix: str
    protected: frozenset
    claude_bin: str
    remote_control: bool
    skip_permissions: bool
    cwd_roots: tuple
    max_sessions: int
    history_limit: int
    history_show_cwd: bool
    host_label: str
    claude_dir: Path
    env: dict = field(repr=False)

    @classmethod
    def from_env(cls, env) -> "Config":
        home = env.get("HOME", "").strip()
        if not home.startswith("/"):
            raise ConfigError("HOME must be set to an absolute path")
        run_dir = env.get("XAVIER_RUN_DIR", "").strip() or "/run/xavier"
        if not CWD_RE.match(run_dir):
            raise ConfigError("XAVIER_RUN_DIR must be an absolute path of letters, digits and ._-/")
        sock_name = env.get("XAVIER_TMUXD_SOCKET_NAME", "").strip() or "tmuxd.sock"
        if not SOCKET_NAME_RE.match(sock_name):
            raise ConfigError("XAVIER_TMUXD_SOCKET_NAME must be a plain file name")
        mode_raw = env.get("XAVIER_SOCKET_MODE", "").strip() or "0660"
        if mode_raw not in ("0660", "0600"):
            raise ConfigError("XAVIER_SOCKET_MODE must be 0660 (owner and group) or 0600 (owner only)")

        tmux_socket_name = env.get("XAVIER_TMUX_SOCKET_NAME", "").strip() or "xavier"
        term_session = env.get("XAVIER_TERM_SESSION", "").strip() or "hub-term"
        for name, value in (("XAVIER_TMUX_SOCKET_NAME", tmux_socket_name),
                            ("XAVIER_TERM_SESSION", term_session)):
            if not LABEL_RE.match(value):
                raise ConfigError(f"{name} must be 1-32 letters, digits, _ or -")
        prefix = env.get("XAVIER_TMUX_PREFIX", "").strip() or "claude-"
        if not PREFIX_RE.match(prefix):
            raise ConfigError("XAVIER_TMUX_PREFIX must be lowercase letters, digits and -, "
                              "starting with a letter (at most 16)")
        if killable_name(prefix, term_session):
            raise ConfigError("XAVIER_TERM_SESSION must not start with XAVIER_TMUX_PREFIX, "
                              "or the hub could stop the terminal's own session")
        protected = frozenset(p.strip() for p in env.get("XAVIER_TMUX_PROTECTED", "").split(",")
                              if p.strip())
        for p in protected:
            if not LABEL_RE.match(p):
                raise ConfigError("XAVIER_TMUX_PROTECTED must be a comma list of session names")

        roots = []
        for raw in (env.get("XAVIER_CWD_ROOTS", "").strip() or home).split(os.pathsep):
            raw = raw.strip()
            if not raw:
                continue
            real = os.path.realpath(raw)
            if not raw.startswith("/") or not CWD_RE.match(real) or not os.path.isdir(real):
                raise ConfigError(f"XAVIER_CWD_ROOTS: {raw!r} is not an existing absolute directory")
            if os.stat(real).st_mode & stat.S_IWOTH:
                raise ConfigError(f"XAVIER_CWD_ROOTS: {raw!r} is world-writable; other users "
                                  "could plant project files there")
            roots.append(real)
        if not roots:
            raise ConfigError("XAVIER_CWD_ROOTS is empty")

        label = env.get("XAVIER_HOST_LABEL", "").strip() or "This machine"
        if len(label) > 40 or not label.isprintable():
            raise ConfigError("XAVIER_HOST_LABEL must be at most 40 printable characters")
        claude_dir = env.get("CLAUDE_CONFIG_DIR", "").strip() or os.path.join(home, ".claude")
        scrubbed = child_env(env)
        return cls(
            socket_path=os.path.join(run_dir, sock_name),
            socket_mode=int(mode_raw, 8),
            tmux_bin=_bin(env, "XAVIER_TMUX_BIN", _which("tmux", scrubbed["PATH"])),
            tmux_socket_name=tmux_socket_name,
            term_session=term_session,
            prefix=prefix,
            protected=protected,
            claude_bin=_bin(env, "XAVIER_CLAUDE_BIN", os.path.join(home, ".local/bin/claude")),
            remote_control=_flag(env, "XAVIER_CLAUDE_REMOTE_CONTROL"),
            skip_permissions=_flag(env, "XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"),
            cwd_roots=tuple(roots),
            max_sessions=_int(env, "XAVIER_TMUXD_MAX_SESSIONS", 8, 1, 64),
            history_limit=_int(env, "XAVIER_TMUXD_HISTORY_LIMIT", 30, 1, 200),
            history_show_cwd=_flag(env, "XAVIER_TMUXD_HISTORY_SHOW_CWD"),
            host_label=label,
            claude_dir=Path(claude_dir),
            env=scrubbed,
        )


def killable_name(prefix: str, name: str) -> bool:
    return name.startswith(prefix) and bool(SLUG_RE.match(name[len(prefix):]))


def resolve_cwd(raw, roots) -> str:
    """The real directory a session may start in, or Rejected. Symlinks and '..' are
    resolved BEFORE the root check, so neither can lead outside the allowed roots."""
    if not isinstance(raw, str) or not CWD_RE.match(raw):
        raise Rejected(400, "cwd must be an absolute path of letters, digits and . _ - /")
    real = os.path.realpath(raw)
    if not CWD_RE.match(real):
        raise Rejected(400, "cwd resolves to a path with unsupported characters")
    if not any(_within(real, root) for root in roots):
        raise Rejected(400, "cwd is outside the directories this host allows")
    try:
        st = os.stat(real)
    except OSError:
        raise Rejected(400, "cwd does not exist") from None
    if not stat.S_ISDIR(st.st_mode):
        raise Rejected(400, "cwd is not a directory")
    if st.st_mode & stat.S_IWOTH:
        raise Rejected(400, "cwd is world-writable")
    return real


def claude_argv(cfg: Config, resume: str | None = None) -> list[str]:
    """Only the configured binary. Permission bypass is never added unless the operator set
    XAVIER_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1; remote control only with
    XAVIER_CLAUDE_REMOTE_CONTROL=1."""
    argv = [cfg.claude_bin]
    if cfg.remote_control:
        argv.append("--remote-control")
    if cfg.skip_permissions:
        argv.append("--dangerously-skip-permissions")
    if resume:
        argv += ["--resume", resume]
    return argv


def clean_text(value, limit: int = 200) -> str | None:
    if not isinstance(value, str):
        return None
    text = "".join(ch for ch in value if ch.isprintable()).strip()
    return text[:limit] or None


def _read_json(path: Path):
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_JSON_FILE + 1)
    except OSError:
        return None
    if len(data) > MAX_JSON_FILE:
        return None
    try:
        return json.loads(data)
    except ValueError:
        return None


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


# --- Claude Code's own bookkeeping ------------------------------------------------
# Every running CLI writes <claude_dir>/sessions/<pid>.json (sessionId, cwd, name,
# nameSource, tmux) and logs custom-title / ai-title records into its transcript at
# <claude_dir>/projects/<cwd-slug>/<sessionId>.jsonl. Both are read, never written.

@dataclass
class TranscriptMeta:
    cwd: str | None = None
    entrypoint: str | None = None
    custom_title: str | None = None
    ai_title: str | None = None

    @property
    def title(self) -> str | None:
        return clean_text(self.custom_title) or clean_text(self.ai_title)


_FIELD_RES = {key: re.compile(rb'"' + key.encode() + rb'"\s*:\s*"((?:[^"\\]|\\.){0,4096})"')
              for key in ("cwd", "entrypoint")}


def _first_string(line: bytes, key: str) -> str | None:
    m = _FIELD_RES[key].search(line)
    if not m:
        return None
    try:
        value = json.loads(b'"' + m.group(1) + b'"')
    except ValueError:
        return None
    return value if isinstance(value, str) else None


@dataclass
class _ScanState:
    dev: int
    ino: int
    offset: int = 0
    tail: bytes = b""
    skipping: bool = False
    meta: TranscriptMeta = field(default_factory=TranscriptMeta)


class TranscriptScanner:
    """Transcripts are append-only JSONL and can run to hundreds of megabytes, so each file
    is read once and then only from where the previous scan stopped. Lines longer than
    MAX_LINE are skipped whole: the records wanted here are small."""

    CHUNK = 1 << 20
    MAX_LINE = 1 << 20
    MAX_TITLE_LINE = 64 * 1024
    MAX_FILES = 2048

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._states: dict[str, _ScanState] = {}

    def scan(self, path: Path, st: os.stat_result) -> TranscriptMeta:
        key = str(path)
        with self._lock:
            s = self._states.get(key)
            if s is None or (s.dev, s.ino) != (st.st_dev, st.st_ino) or st.st_size < s.offset:
                s = _ScanState(dev=st.st_dev, ino=st.st_ino)
            if st.st_size > s.offset:
                try:
                    with open(path, "rb") as f:
                        f.seek(s.offset)
                        left = st.st_size - s.offset
                        while left > 0:
                            chunk = f.read(min(self.CHUNK, left))
                            if not chunk:
                                break
                            left -= len(chunk)
                            s.offset += len(chunk)
                            self._feed(s, chunk)
                except OSError:
                    pass
            if key not in self._states and len(self._states) >= self.MAX_FILES:
                self._states.clear()
            self._states[key] = s
            return replace(s.meta)

    def _feed(self, s: _ScanState, chunk: bytes) -> None:
        parts = chunk.split(b"\n")
        for i, part in enumerate(parts):
            last = i == len(parts) - 1
            if s.skipping:
                if not last:
                    s.skipping = False
                continue
            if last:
                s.tail += part
                if len(s.tail) > self.MAX_LINE:
                    s.tail, s.skipping = b"", True
                continue
            line, s.tail = s.tail + part, b""
            if len(line) <= self.MAX_LINE:
                self._line(s.meta, line)

    def _line(self, meta: TranscriptMeta, line: bytes) -> None:
        if meta.cwd is None and b'"cwd"' in line:
            meta.cwd = _first_string(line, "cwd")
        if meta.entrypoint is None and b'"entrypoint"' in line:
            meta.entrypoint = _first_string(line, "entrypoint")
        if (b'"custom-title"' in line or b'"ai-title"' in line) and len(line) <= self.MAX_TITLE_LINE:
            try:
                doc = json.loads(line)
            except ValueError:
                return
            if not isinstance(doc, dict):
                return
            if doc.get("type") == "custom-title" and doc.get("customTitle"):
                meta.custom_title = str(doc["customTitle"])
            elif doc.get("type") == "ai-title" and doc.get("aiTitle"):
                meta.ai_title = str(doc["aiTitle"])


class ClaudeState:
    def __init__(self, claude_dir: Path) -> None:
        self.dir = claude_dir
        self.scanner = TranscriptScanner()

    def live_cli_sessions(self) -> dict[str, dict]:
        """pid -> sessions/<pid>.json, for CLIs that are still running."""
        out: dict[str, dict] = {}
        try:
            entries = list(os.scandir(self.dir / "sessions"))
        except OSError:
            return out
        for e in entries:
            pid = e.name[:-5] if e.name.endswith(".json") else ""
            if not pid.isdigit() or not e.is_file(follow_symlinks=False):
                continue
            if not _pid_alive(int(pid)):
                continue
            doc = _read_json(Path(e.path))
            if isinstance(doc, dict):
                out[pid] = doc
        return out

    def running_ids(self) -> set[str]:
        """Every session id open in a live CLI, in a tmux pane or not. Resuming one of these
        would fork its transcript into two writers."""
        return {str(d["sessionId"]) for d in self.live_cli_sessions().values() if d.get("sessionId")}

    def _project_dirs(self) -> list[str]:
        try:
            return [e.path for e in os.scandir(self.dir / "projects") if e.is_dir(follow_symlinks=False)]
        except OSError:
            return []

    def transcripts(self) -> list[tuple[Path, os.stat_result, str]]:
        """(path, lstat, session id) for top-level transcripts, newest first. Subagent logs
        one directory deeper, non-UUID names and anything that is not a regular file
        (a symlink to ~/.ssh/id_ed25519, say) are skipped."""
        found = []
        for d in self._project_dirs():
            try:
                entries = list(os.scandir(d))
            except OSError:
                continue
            for e in entries:
                sid = e.name[:-6] if e.name.endswith(".jsonl") else ""
                if not UUID_RE.match(sid):
                    continue
                try:
                    st = os.lstat(e.path)
                except OSError:
                    continue
                if stat.S_ISREG(st.st_mode):
                    found.append((Path(e.path), st, sid))
        found.sort(key=lambda t: t[1].st_mtime, reverse=True)
        return found

    def find_transcript(self, session_id: str) -> tuple[Path, os.stat_result] | None:
        if not UUID_RE.match(session_id):
            return None
        best = None
        for d in self._project_dirs():
            p = Path(d) / f"{session_id}.jsonl"
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and (best is None or st.st_mtime > best[1].st_mtime):
                best = (p, st)
        return best

    def title_for(self, session_id: str) -> str | None:
        hit = self.find_transcript(session_id)
        return self.scanner.scan(*hit).title if hit else None


# --- tmux -------------------------------------------------------------------------

class Tmux:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def run(self, *args: str, timeout: float = 10) -> subprocess.CompletedProcess:
        argv = [self.cfg.tmux_bin, "-L", self.cfg.tmux_socket_name, *args]
        try:
            return subprocess.run(argv, capture_output=True, encoding="utf-8", errors="replace",
                                  timeout=timeout, env=self.cfg.env, stdin=subprocess.DEVNULL,
                                  cwd="/")
        except subprocess.TimeoutExpired:
            raise Rejected(504, "tmux did not answer in time") from None
        except OSError as exc:
            raise Rejected(503, f"cannot run tmux: {exc.strerror}") from None

    def sessions(self) -> list[dict]:
        r = self.run("list-sessions", "-F", LIST_FMT)
        if r.returncode != 0:  # no server, or no sessions: nothing to list
            return []
        rows = []
        for line in r.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) != 4:
                continue
            name, created, attached, windows = parts
            rows.append({
                "name": name[:64],
                "created": int(created) if created.isdigit() else None,
                "attached": attached not in ("0", ""),
                "windows": int(windows) if windows.isdigit() else 0,
            })
        return rows

    def pane_pids(self) -> dict[str, str]:
        """session name -> pid of its first pane."""
        r = self.run("list-panes", "-a", "-F", PANE_FMT)
        out: dict[str, str] = {}
        if r.returncode != 0:
            return out
        for line in r.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[1].isdigit():
                out.setdefault(parts[0], parts[1])
        return out


# --- the API ------------------------------------------------------------------------

class App:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.tmux = Tmux(cfg)
        self.claude = ClaudeState(cfg.claude_dir)
        self.spawn_lock = threading.Lock()

    def host_row(self, ok: bool = True, error: str | None = None) -> dict:
        return {"id": LOCAL_ID, "label": self.cfg.host_label, "ok": ok, "error": error}

    def killable(self, name: str) -> bool:
        return killable_name(self.cfg.prefix, name) and name not in self.cfg.protected

    def sessions(self) -> dict:
        try:
            rows = self.tmux.sessions()
        except Rejected as exc:
            return {"sessions": [], "hosts": [self.host_row(False, str(exc))]}
        try:
            titles = self._titles({r["name"] for r in rows}) if rows else {}
        except Rejected:
            titles = {}  # titles are a nicety; the list itself already answered
        for row in rows:
            info = titles.get(row["name"], {})
            row.update(protected=not self.killable(row["name"]), host=LOCAL_ID,
                       title=info.get("title"), session_id=info.get("session_id"))
        return {"sessions": rows, "hosts": [self.host_row()]}

    def _titles(self, names: set) -> dict[str, dict]:
        panes = self.tmux.pane_pids()
        live = self.claude.live_cli_sessions()
        # A pane whose pid is a wrapper shell, not the CLI: the CLI records its own pane as
        # "session:@window.%pane" in the tmux field.
        by_tmux: dict[str, str] = {}
        for pid, doc in live.items():
            if isinstance(doc.get("tmux"), str) and doc["tmux"]:
                by_tmux.setdefault(doc["tmux"].split(":", 1)[0], pid)
        out: dict[str, dict] = {}
        for name in names:
            doc = live.get(panes.get(name, "")) or live.get(by_tmux.get(name, ""))
            if not doc:
                continue
            sid = str(doc.get("sessionId") or "")
            sid = sid if UUID_RE.match(sid) else None
            title = self.claude.title_for(sid) if sid else None
            if not title and doc.get("nameSource") == "user":
                title = clean_text(doc.get("name"))
            out[name] = {"title": title, "session_id": sid}
        return out

    def history(self) -> dict:
        live = self.claude.running_ids()
        rows: list[dict] = []
        for scanned, (path, st, sid) in enumerate(self.claude.transcripts()):
            if len(rows) >= self.cfg.history_limit or scanned >= self.cfg.history_limit * 4:
                break
            meta = self.claude.scanner.scan(path, st)
            if (meta.entrypoint or "").startswith("sdk"):  # headless subprocesses, not shells
                continue
            try:
                cwd = resolve_cwd(meta.cwd, self.cfg.cwd_roots)
            except Rejected:
                continue
            rows.append({"host": LOCAL_ID, "session_id": sid, "title": meta.title,
                         "cwd": cwd if self.cfg.history_show_cwd else None,
                         "last_active": int(st.st_mtime), "live": sid in live})
        return {"sessions": rows, "hosts": [self.host_row()]}

    def _fields(self, body: dict, allowed: frozenset) -> dict:
        extra = set(body) - allowed
        if extra:
            raise Rejected(400, f"unexpected field(s): {', '.join(sorted(extra)[:5])}")
        for key, value in body.items():
            if value is not None and not isinstance(value, str):
                raise Rejected(400, f"{key} must be a string")
        host = body.get("host") or LOCAL_ID
        if host != LOCAL_ID:
            raise Rejected(400, "unknown host: this hub-tmuxd manages only the machine it runs on")
        return {k: v for k, v in body.items() if v}

    def _check_claude(self) -> None:
        """Another local user must not be able to swap the binary a spawn runs."""
        real = os.path.realpath(self.cfg.claude_bin)
        try:
            modes = [os.stat(p).st_mode for p in
                     (real, os.path.dirname(real), os.path.dirname(self.cfg.claude_bin))]
        except OSError:
            raise Rejected(503, "the Claude Code binary (XAVIER_CLAUDE_BIN) was not found") from None
        if not stat.S_ISREG(modes[0]) or not os.access(real, os.X_OK):
            raise Rejected(503, "XAVIER_CLAUDE_BIN is not an executable file")
        if any(m & stat.S_IWOTH for m in modes):
            raise Rejected(503, "XAVIER_CLAUDE_BIN or its directory is world-writable")

    def spawn(self, body: dict) -> dict:
        req = self._fields(body, SPAWN_KEYS)
        slug, resume = req.get("name", ""), req.get("resume", "")
        if slug and not SLUG_RE.match(slug):
            raise Rejected(400, "name must match [a-z0-9][a-z0-9-]{0,30}")
        if resume and not UUID_RE.match(resume):
            raise Rejected(400, "resume must be a Claude Code session id")
        if resume:
            hit = self.claude.find_transcript(resume)
            if hit is None:
                raise Rejected(404, "no transcript with that session id")
            # The transcript's own directory, never the caller's: `claude --resume` only
            # finds a session from the directory it was recorded in.
            try:
                cwd = resolve_cwd(self.claude.scanner.scan(*hit).cwd, self.cfg.cwd_roots)
            except Rejected:
                raise Rejected(400, "that session's directory is gone or outside the allowed roots") from None
            if "cwd" in req and resolve_cwd(req["cwd"], self.cfg.cwd_roots) != cwd:
                raise Rejected(400, "cwd does not match the transcript's directory; omit it to resume")
            if resume in self.claude.running_ids():
                raise Rejected(409, "that session is already open in a running Claude Code")
        else:
            cwd = resolve_cwd(req.get("cwd", self.cfg.cwd_roots[0]), self.cfg.cwd_roots)
        self._check_claude()
        with self.spawn_lock:
            existing = {s["name"] for s in self.tmux.sessions()}
            if sum(1 for n in existing if killable_name(self.cfg.prefix, n)) >= self.cfg.max_sessions:
                raise Rejected(429, f"already {self.cfg.max_sessions} sessions (XAVIER_TMUXD_MAX_SESSIONS)")
            if slug:
                name = self.cfg.prefix + slug
            else:
                n = 1
                while f"{self.cfg.prefix}{n}" in existing:
                    n += 1
                name = f"{self.cfg.prefix}{n}"
            if name in existing:
                raise Rejected(409, f"session {name} already exists")
            r = self.tmux.run("new-session", "-d", "-s", name, "-c", cwd, "--",
                              *claude_argv(self.cfg, resume or None))
        if r.returncode != 0:
            raise Rejected(500, (r.stderr or "tmux failed").strip()[:300])
        log(f"spawned {name} in {cwd}" + (f", resuming {resume}" if resume else ""))
        return {"ok": True, "name": name, "host": LOCAL_ID,
                "cwd": cwd if self.cfg.history_show_cwd else None,
                "resumed": resume or None, "attach": f"tmux switch-client -t {name}"}

    def kill(self, body: dict) -> dict:
        req = self._fields(body, KILL_KEYS)
        name = req.get("name", "")
        if not killable_name(self.cfg.prefix, name):
            raise Rejected(400, f"only {self.cfg.prefix}* sessions can be stopped here")
        if name in self.cfg.protected:
            raise Rejected(403, f"{name} is protected")
        live = {s["name"]: s for s in self.tmux.sessions()}
        if name not in live:
            raise Rejected(404, f"no session {name}")
        if live[name]["attached"]:
            raise Rejected(409, f"{name} has an attached client; detach first")
        r = self.tmux.run("kill-session", "-t", f"={name}")  # '=': exact name, no prefix match
        if r.returncode != 0:
            raise Rejected(404, (r.stderr or "no such session").strip()[:300])
        log(f"stopped {name}")
        return {"ok": True, "killed": name, "host": LOCAL_ID}


# --- HTTP over the unix socket ------------------------------------------------------

def log(message: str) -> None:
    print(f"hub-tmuxd: {message}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "hub-tmuxd"
    sys_version = ""
    timeout = 15  # a client that stops talking cannot hold a thread

    def log_message(self, fmt: str, *args) -> None:
        log(fmt % args)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _dispatch(self, routes: dict) -> None:
        if not self.server.slots.acquire(blocking=False):
            return self._json(503, {"error": "busy"})
        try:
            route = routes.get(urlsplit(self.path).path)
            if route is None:
                return self._json(404, {"error": "not found"})
            self._json(200, route())
        except Rejected as exc:
            self._json(exc.status, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the daemon
            log(f"internal error on {self.command} {self.path}: {exc!r}")
            self._json(500, {"error": "internal error"})
        finally:
            self.server.slots.release()

    def _body(self) -> dict:
        raw_len = self.headers.get("Content-Length") or "0"
        if not raw_len.isdigit():
            raise Rejected(400, "bad Content-Length")
        n = int(raw_len)
        if n > MAX_BODY:
            raise Rejected(413, "request body too large")
        if n == 0:
            return {}
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            raise Rejected(400, "body must be JSON") from None
        if not isinstance(data, dict):
            raise Rejected(400, "body must be a JSON object")
        return data

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        app = self.server.app
        self._dispatch({"/healthz": lambda: {"ok": True}, "/sessions": app.sessions,
                        "/history": app.history})

    def do_POST(self) -> None:  # noqa: N802
        app = self.server.app
        self._dispatch({"/spawn": lambda: app.spawn(self._body()),
                        "/kill": lambda: app.kill(self._body())})


def check_socket_dir(directory: str) -> None:
    """The directory is the real access control: it must belong to this user and be
    closed to everyone but its group (0750, from systemd's RuntimeDirectory=, or 0700)."""
    try:
        st = os.lstat(directory)
    except FileNotFoundError:
        os.makedirs(directory, mode=0o700)
        os.chmod(directory, 0o700)
        st = os.lstat(directory)
    mode = stat.S_IMODE(st.st_mode)
    if not stat.S_ISDIR(st.st_mode):
        raise ConfigError(f"{directory} is not a directory")
    if st.st_uid != os.geteuid():
        raise ConfigError(f"{directory} must be owned by uid {os.geteuid()}, not {st.st_uid}")
    if mode & 0o027:
        raise ConfigError(f"{directory} is mode {mode:04o}; it must be 0750 or 0700 "
                          "(no access for others, no group write)")


def clear_stale_socket(path: str) -> None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(st.st_mode):
        raise ConfigError(f"{path} exists and is not a socket; refusing to replace it")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(1)
        probe.connect(path)
    except OSError:
        os.unlink(path)  # nobody answers: left over from an unclean exit
        return
    finally:
        probe.close()
    raise ConfigError(f"another process is already serving {path}")


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.app = App(cfg)
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(cfg.socket_path, Handler, bind_and_activate=False)
        try:
            self.server_bind()
            self.server_activate()
        except BaseException:
            self.server_close()
            raise

    def server_bind(self) -> None:
        path = self.cfg.socket_path
        check_socket_dir(os.path.dirname(path))
        clear_stale_socket(path)
        # Born with its final mode: there is no window in which a wider socket exists.
        old = os.umask(0o177 if self.cfg.socket_mode == 0o600 else 0o117)
        try:
            self.socket.bind(path)
        finally:
            os.umask(old)
        os.chmod(path, self.cfg.socket_mode)
        self._inode = os.lstat(path).st_ino

    def remove_socket(self) -> None:
        try:
            if os.lstat(self.cfg.socket_path).st_ino == self._inode:
                os.unlink(self.cfg.socket_path)
        except (OSError, AttributeError):
            pass


def main() -> int:
    try:
        cfg = Config.from_env(os.environ)
        srv = UnixServer(cfg)
    except ConfigError as exc:
        log(f"not starting: {exc}")
        return 2
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    flags = [f for f, on in (("--remote-control", cfg.remote_control),
                             ("--dangerously-skip-permissions", cfg.skip_permissions)) if on]
    log(f"listening on {cfg.socket_path} (mode {cfg.socket_mode:04o}); tmux -L "
        f"{cfg.tmux_socket_name}; sessions {cfg.prefix}* (max {cfg.max_sessions}); "
        f"claude flags: {' '.join(flags) or 'none'}")
    if cfg.skip_permissions:
        log("WARNING: every session the hub starts runs with --dangerously-skip-permissions")
    try:
        srv.serve_forever()
    finally:
        srv.remove_socket()
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
