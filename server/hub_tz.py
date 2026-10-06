"""The hub's display timezone, read from HUB_TZ.

HUB_TZ must be an IANA name (Europe/Berlin, America/Chicago, UTC). An
abbreviation such as EDT or PDT is not one, and neither is an empty value. A bad
value used to raise at import, which restart-looped the container; now it logs a
warning and the hub runs on UTC until the value is fixed.
"""
from __future__ import annotations

import logging
import os
from datetime import timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger("hub.tz")


def hub_tz(name: str | None = None) -> tzinfo:
    """The named zone (default: $HUB_TZ), or UTC with a warning when it is unusable."""
    raw = os.environ.get("HUB_TZ", "") if name is None else name
    key = raw.strip()
    if not key:
        return timezone.utc
    try:
        return ZoneInfo(key)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        log.warning(
            "HUB_TZ=%r is not an IANA timezone name (for example Europe/Berlin); using UTC",
            key[:64],
        )
        return timezone.utc
