"""The /api/files browser never serves credential-shaped files.

Its reads are unauthenticated, so the denylist is the only thing standing between a
configured root and a leaked key. Offline: a tmpdir root, TestClient in-process.
Run in its own process like every other test file (run_tests.sh).
"""
import os
import pathlib
import sys
import tempfile

import pytest

TMP = pathlib.Path(tempfile.mkdtemp())
ROOT = TMP / "root"
AGENTS = TMP / "Library" / "LaunchAgents"
os.environ["HUB_FS_ROOTS"] = f"work:Work:{ROOT};launch_agents:LaunchAgents:{AGENTS}"

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402

client = TestClient(app)

DENIED = [
    "prod.env", "Server.PEM", "AuthKey_ABC123.p8", "tls.key", "bundle.p12", "id_ed25519",
    "aws_credentials.txt", "client_secret.json", "api_token.txt", "sessions.json",
    "passkeys.json",
]


@pytest.fixture(scope="module", autouse=True)
def tree():
    ROOT.mkdir(parents=True)
    (ROOT / "notes.md").write_text("hello\n")
    for name in DENIED:
        (ROOT / name).write_text("not for the browser\n")
    (ROOT / "secrets").mkdir()
    (ROOT / "secrets" / "compose-hmac").write_text("k\n")
    (ROOT / "docs").mkdir()
    (ROOT / "docs" / "readme.md").write_text("docs\n")
    (ROOT / "innocent.txt").symlink_to(ROOT / "tls.key")
    AGENTS.mkdir(parents=True)
    (AGENTS / "com.example.agent.plist").write_text("<plist/>\n")
    (AGENTS / "README.txt").write_text("launch agents live here\n")
    yield


def names(root: str, path: str = "") -> set[str]:
    r = client.get("/api/files/browse", params={"root": root, "path": path})
    assert r.status_code == 200, r.text
    return {e["name"] for e in r.json()["entries"]}


def test_a_listing_hides_every_credential_shaped_name():
    listed = names("work")
    assert {"notes.md", "docs", "innocent.txt"} <= listed
    assert not listed & set(DENIED)
    assert "secrets" not in listed


@pytest.mark.parametrize("name", DENIED)
def test_a_credential_shaped_file_is_never_read(name):
    r = client.get("/api/files/read", params={"root": "work", "path": name})
    assert r.status_code == 403, r.text
    assert "not for the browser" not in r.text


def test_an_ordinary_file_still_reads():
    r = client.get("/api/files/read", params={"root": "work", "path": "docs/readme.md"})
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "docs\n"


def test_a_symlink_cannot_launder_a_credential():
    r = client.get("/api/files/read", params={"root": "work", "path": "innocent.txt"})
    assert r.status_code == 403, r.text


def test_a_credential_shaped_directory_is_closed_too():
    assert client.get("/api/files/browse", params={"root": "work", "path": "secrets"}).status_code == 403
    r = client.get("/api/files/read", params={"root": "work", "path": "secrets/compose-hmac"})
    assert r.status_code == 403, r.text


def test_launch_agent_plists_are_never_served():
    assert names("launch_agents") == {"README.txt"}
    r = client.get("/api/files/read", params={"root": "launch_agents", "path": "com.example.agent.plist"})
    assert r.status_code == 403, r.text
