# SPDX-License-Identifier: MIT
"""Process-wide singletons and the few gateway lookups both halves of the plugin
share. Gateway imports stay INSIDE functions so this module (and
hooks.py, which imports it) loads without the gateway on the host, and so a
renamed gateway symbol degrades one call to "not a Hub session" instead of
failing the plugin at load time.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from . import hub_wire as wire
from .hub_client import DeliveryQueue, HubApiClient
from .turns import TurnTracker

logger = logging.getLogger(__name__)

client = HubApiClient()
queue = DeliveryQueue(client)
turns = TurnTracker()


def redact(text: str) -> str:
    """The gateway's own secret scrubber, forced on. Raises when it cannot be
    imported so ``hub_wire.bounded`` withholds the content — fail closed, never
    forward raw tool output because a helper moved."""
    from agent.redact import redact_sensitive_text

    return redact_sensitive_text(text, force=True)


def runner() -> Optional[Any]:
    """The live GatewayRunner, or None outside the gateway process. Imported at
    call time on purpose: ``gateway.run`` rebinds this module-level weakref when
    the runner starts, so a cached import would hold the pre-start lambda."""
    try:
        from gateway.run import _gateway_runner_ref

        return _gateway_runner_ref()
    except Exception:
        return None


def session_store() -> Optional[Any]:
    r = runner()
    return getattr(r, "session_store", None) if r is not None else None


def session_id_for_key(session_key: str) -> Optional[str]:
    store = session_store()
    if store is None or not session_key:
        return None
    try:
        return store.peek_session_id(session_key)
    except Exception:
        return None


def hub_thread_for_session(session_id: Optional[str]) -> Optional[str]:
    """session_id -> Hub thread id, or None for every session that is not a Hub
    DM thread. The answer is cached per session id (bounded, LRU) because this
    sits on the post_tool_call hot path for every platform's turns and the
    store lookup is a linear scan under the store lock."""
    if not session_id:
        return None
    cached, thread_id = turns.cached_thread(session_id)
    if cached:
        return thread_id
    thread_id = None
    store = session_store()
    if store is not None:
        try:
            entry = store.lookup_by_session_id(session_id)
            if entry is not None:
                thread_id = wire.thread_id_from_session_key(getattr(entry, "session_key", None))
        except Exception:
            thread_id = None
            store = None  # do not cache a failed lookup as "not Hub"
    if store is not None:
        turns.cache_thread(session_id, thread_id)
    return thread_id
