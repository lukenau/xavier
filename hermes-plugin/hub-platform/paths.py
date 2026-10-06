# SPDX-License-Identifier: MIT
"""Where the gateway keeps its state: ``HERMES_HOME``, resolved the way Hermes resolves it.

Every default path this plugin uses (the platform key file, the observer log,
``cron/``, ``state.db``) sits under the gateway's home, so nothing here names a
directory of its own. Each one is still overridable by its own env var.
"""

from __future__ import annotations

import os


def hermes_home() -> str:
    """The gateway's own answer when it is importable (it knows profiles and the
    per-OS default), else ``$HERMES_HOME``, else ``~/.hermes``."""
    try:
        from hermes_constants import get_hermes_home

        return str(get_hermes_home())
    except Exception:
        return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def under_home(*parts: str) -> str:
    return os.path.join(hermes_home(), *parts)
