"""HUB_TZ never takes the server down.

The installer on macOS (and any host without /etc/timezone) used to seed HUB_TZ from
`date +%Z` — an abbreviation such as EDT — and the import-time ZoneInfo() raised, so
the container restart-looped. A bad value now logs a warning and the hub runs on UTC.

Run in its own process like every other test file (run_tests.sh).
"""
import logging
import os
import pathlib
import subprocess
import sys
from datetime import timezone
from zoneinfo import ZoneInfo

import pytest

SERVER = pathlib.Path(__file__).parent
sys.path.insert(0, str(SERVER))
from hub_tz import hub_tz  # noqa: E402


@pytest.mark.parametrize("bad", ["EDT", "PDT", "CEST", "Not/AZone", "../etc/localtime", "x" * 300])
def test_an_unusable_name_falls_back_to_utc_with_a_warning(bad, caplog):
    with caplog.at_level(logging.WARNING, logger="hub.tz"):
        assert hub_tz(bad) is timezone.utc
    assert "HUB_TZ" in caplog.text and "using UTC" in caplog.text


def test_a_blank_value_is_utc_without_a_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="hub.tz"):
        assert hub_tz("  ") is timezone.utc
    assert caplog.text == ""


def test_an_iana_name_is_used(monkeypatch):
    assert hub_tz("Europe/Berlin") == ZoneInfo("Europe/Berlin")
    monkeypatch.setenv("HUB_TZ", "Asia/Tokyo")
    assert hub_tz() == ZoneInfo("Asia/Tokyo")
    monkeypatch.delenv("HUB_TZ")
    assert hub_tz() is timezone.utc


def test_the_server_imports_with_an_abbreviation_in_hub_tz():
    """The exact crash: import the app in a fresh process with HUB_TZ=EDT."""
    env = {**os.environ, "HUB_TZ": "EDT"}
    r = subprocess.run(
        [sys.executable, "-c", "import app, hub_calendar; print(app.HUB_TZ, hub_calendar.TZ)"],
        cwd=SERVER, env=env, capture_output=True, text=True, timeout=120,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    assert r.stdout.split() == ["UTC", "UTC"]
    assert "HUB_TZ='EDT'" in r.stderr
