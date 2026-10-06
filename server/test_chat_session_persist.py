"""Chat sessions outlive the process.

    python3 -m pytest test_chat_session_persist.py -q
"""
import importlib
import os
import sys
import tempfile
import time
from pathlib import Path

FILE = Path(tempfile.mkdtemp()) / "sessions.json"
os.environ["HUB_CHAT_SESSIONS_FILE"] = str(FILE)
sys.path.insert(0, str(Path(__file__).parent))

import chat.session as session  # noqa: E402


def test_a_session_survives_a_restart():
    token = session._chat_session_new()
    assert session.chat_session_valid(token)
    assert oct(FILE.stat().st_mode & 0o777) == "0o600"

    # A new process: the dict is empty until the file is read.
    session._CHAT_SESSIONS.clear()
    assert not session.chat_session_valid(token)
    session._sessions_load()
    assert session.chat_session_valid(token)


def test_an_expired_session_is_not_resurrected():
    token = session._chat_session_new()
    with session._CHAT_LOCK:
        session._CHAT_SESSIONS[token] = time.time() - 1
        session._sessions_save_locked()
    session._CHAT_SESSIONS.clear()
    session._sessions_load()
    assert not session.chat_session_valid(token)


def test_logout_is_durable_too():
    token = session._chat_session_new()
    session._chat_session_drop(token)
    session._CHAT_SESSIONS.clear()
    session._sessions_load()
    assert not session.chat_session_valid(token)


def test_an_unreadable_file_is_an_empty_start_not_a_crash():
    FILE.write_text("{not json")
    session._CHAT_SESSIONS.clear()
    session._sessions_load()
    assert session._CHAT_SESSIONS == {}
