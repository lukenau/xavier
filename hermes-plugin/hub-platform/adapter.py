# SPDX-License-Identifier: MIT
"""Hub platform adapter for Hermes Agent.

Installed as a Hermes user plugin (``$HERMES_HOME/plugins/hub-platform/``);
``README.md`` is the install and config guide.

Wire: one shared secret, ``HUB_PLATFORM_KEY``, in both directions. Outbound the
adapter POSTs ``/api/platform/hub/{deliver,media,commands,...}`` on the hub
server (``hub_client.py``); inbound the hub POSTs the gateway API server's
``/api/platforms/hub/events``, and this class's
``verify_http_event_request``/``dispatch_http_event`` pair (the shape the
gateway's own HTTP-event platforms use) turns each event into a normal
``handle_message`` turn, an approval resolution, a clarify answer, a stop, or a
read-only subagent transcript.

Threads: one Hub thread == one Hermes session keyed
``agent:main:hub:dm:<thread_id>`` — ``chat_type`` and ``thread_id`` are fixed
in ``_dispatch_message`` below, never derived from anything but the validated
``thread_id``. Sessions are created lazily on the normal adapter path.

Approvals: the gateway calls ``send_exec_approval`` from its own per-session
notify callback but does not pass the ``request_id`` it just minted;
``_newest_pending_request_id`` reads it back from
``tools.approval.list_gateway_approvals`` (the entry is enqueued before the
callback fires). The phone's answer comes back as an ``approval_decision``
event and resolves by that id — never "the oldest". ``choices`` on the card is
the server-side contract the hub re-derives the allowed answers from.

Streaming: config sets ``streaming: false``, ``interim_assistant_messages:
false`` and ``tool_progress: "off"`` for ``hub`` so the ONLY text ``send()``
receives is the final reply (plus system notices). Tool cards, stream deltas
and thinking come from ``hooks.py`` under the same ``run_id`` (``turns.py``),
so the app groups them into one turn.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult
from gateway.session import SessionSource

from . import cron_feed
from . import curator
from . import hub_wire as wire
from .hub_client import DELIVER_PATH
from .platform_hint import PLATFORM_HINT
from . import runtime
from . import subagent_transcript
from .skill_expand import expand_midsentence_skills

logger = logging.getLogger(__name__)

# Who every Hub message is from. The hub authenticates its user itself; the
# gateway sees this one fixed principal, authorised like any platform user
# (HUB_ALLOWED_USERS, registered below).
HUB_USER_ID = os.environ.get("HUB_USER_ID", "hub-user")
HUB_USER_NAME = os.environ.get("HUB_USER_NAME", "User")
CATALOG_PUSH_DELAY_S = float(os.environ.get("HUB_CATALOG_PUSH_DELAY_S", "20"))
# The scheduler sends a run's attachments right behind its text, and only the
# text carries the job id. An attachment to the same target this soon after is
# that run's.
JOB_MEDIA_WINDOW_S = 20.0


def _ok(status: int) -> bool:
    return 200 <= status < 300


def _result(status: int, data: Dict[str, Any]) -> SendResult:
    if _ok(status):
        return SendResult(success=True, message_id=str(data.get("message_id") or "") or None, raw_response=data)
    error = data.get("error") or data.get("detail") or f"hub-api returned {status}"
    if isinstance(error, dict):
        error = error.get("code") or error.get("detail") or str(error)
    return SendResult(success=False, error=str(error)[:200], retryable=status in (0, 502, 503, 504))


class HubAdapter(BasePlatformAdapter):
    """The ``hub`` platform: hub-api is the transport, the phone is the surface."""

    # Hub renders real markdown fences; and it takes a whole reply in one row,
    # so the base must not chunk at the 4096 default (max_message_length_for_chat
    # reads MAX_MESSAGE_LENGTH off the class).
    supports_code_blocks = True
    MAX_MESSAGE_LENGTH = wire.MAX_TEXT_CHARS

    @classmethod
    def supports_exec_approval_buttons(cls) -> bool:
        # v0.21 decides "does this adapter draw approval cards" from whether it
        # overrides the new `_send_exec_approval_prompt` hook. This adapter
        # overrides `send_exec_approval` itself (it needs the request_id the
        # hook's prompt object does not carry), so without saying so here every
        # Hub approval falls back to a "/approve" text message.
        return True

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("hub"))
        self._catalog_task: Optional[asyncio.Task] = None
        self._feed_task: Optional[asyncio.Task] = None
        self._delivered_request_ids: set = set()
        self._recent_jobs: Dict[str, Tuple[str, Optional[str], float]] = {}

    # -- lifecycle ---------------------------------------------------------------
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        # No handshake: hub-api reachability is a send-time concern. The catalog
        # push is deferred so the skills registry has finished its startup scan.
        self._mark_connected()
        try:
            self._catalog_task = asyncio.get_running_loop().create_task(self._push_catalog_later())
            self._feed_task = asyncio.get_running_loop().create_task(self._feed_cron_runs())
        except RuntimeError:
            self._catalog_task = None
        return True

    async def disconnect(self) -> None:
        if self._catalog_task is not None:
            self._catalog_task.cancel()
            self._catalog_task = None
        if self._feed_task is not None:
            self._feed_task.cancel()
            self._feed_task = None
        self._mark_disconnected()

    async def _feed_cron_runs(self) -> None:
        """Jobs and run files to hub-api, for as long as the adapter is up. A
        pass that fails is logged and the next one tries again: this loop must
        outlive a hub-api restart."""
        feed = cron_feed.CronFeed(runtime.client)
        await asyncio.sleep(cron_feed.START_DELAY_S)
        while True:
            try:
                stats = await asyncio.to_thread(feed.tick)
                if stats["failed"]:
                    logger.warning("hub cron feed: hub-api did not take a batch (%s)", stats)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("hub cron feed pass failed", exc_info=True)
            await asyncio.sleep(cron_feed.POLL_S)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm"}

    # -- helpers -----------------------------------------------------------------
    @staticmethod
    def _thread_for(chat_id: str, metadata: Optional[Dict[str, Any]]) -> str:
        candidate = (metadata or {}).get("thread_id") or chat_id
        candidate = str(candidate or "")
        if not wire.THREAD_ID_RE.match(candidate):
            raise ValueError("hub thread id malformed")
        return candidate

    @staticmethod
    def _run_context(thread_id: str) -> Tuple[str, Optional[str], Optional[str]]:
        session_key = wire.session_key_for_thread(thread_id)
        session_id = runtime.session_id_for_key(session_key)
        run_id = runtime.turns.turn(session_id) if session_id else None
        return session_key, session_id, run_id

    def _job_for(
        self, chat_id: str, metadata: Optional[Dict[str, Any]], *, attachment: bool = False
    ) -> Tuple[Optional[str], Optional[str]]:
        """(job_id, run_id) when this send is a scheduled job's delivery."""
        job_id = str((metadata or {}).get("job_id") or "")
        now = time.monotonic()
        if job_id and cron_feed.JOB_ID_RE.match(job_id):
            run_id = cron_feed.run_id_for(job_id)
            self._recent_jobs[str(chat_id)] = (job_id, run_id, now)
            return job_id, run_id
        recent = self._recent_jobs.get(str(chat_id)) if attachment else None
        if recent is not None and now - recent[2] <= JOB_MEDIA_WINDOW_S:
            # A turn running in this thread owns what it sends: an image a live
            # chat turn posts right after a job's text is the chat's, not the job's.
            _, _, turn = self._run_context(str(chat_id)) if wire.THREAD_ID_RE.match(str(chat_id)) else (None, None, None)
            if turn is None:
                return recent[0], recent[1]
        return None, None

    async def _deliver(self, body: Dict[str, Any]) -> SendResult:
        # Through the FIFO, behind the turn's own deltas. Posted straight
        # through the client, a final landed ahead of its stream's queued tail
        # and the tail came back as a second bubble; the queue also stamps the
        # delivery_id a retry needs.
        status, data = await asyncio.to_thread(runtime.queue.post_in_order, DELIVER_PATH, body)
        return _result(status, data)

    # -- outbound ----------------------------------------------------------------
    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        try:
            thread_id = self._thread_for(chat_id, metadata)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc))
        job_id, job_run_id = self._job_for(chat_id, metadata)
        if not job_id and curator.is_summary(content):
            _, review_session, _ = self._run_context(thread_id)
            content = curator.card_text(review_session, content)
            job_id, job_run_id = curator.JOB_ID, f"{curator.JOB_ID}:d{int(time.time())}"
        if job_id:
            # Not a turn in this thread: its run, its reasoning and the end of
            # its turn all belong to whatever conversation is open there.
            return await self._deliver(wire.with_job(wire.text_message(thread_id, content), job_id, job_run_id))
        _, session_id, run_id = self._run_context(thread_id)
        reasoning = runtime.turns.take_reasoning(session_id) if session_id else None
        body = wire.text_message(
            thread_id, content, run_id=run_id, session_id=session_id, reasoning=reasoning,
            cron_run_id=(metadata or {}).get("cron_run_id"),
        )
        # The turn ends here and nowhere else. A stream ends once per tool
        # round, so hub-api cannot read the end off the rows; this says it.
        body["final"] = True
        result = await self._deliver(body)
        if session_id:
            # The reply is the end of the run: the next turn's first card must not
            # inherit this run_id.
            runtime.turns.end_turn(session_id)
        return result

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        try:
            thread_id = self._thread_for(chat_id, metadata)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc))
        _, session_id, run_id = self._run_context(thread_id)
        return await self._deliver(wire.with_job(wire.image_message(
            thread_id, url=image_url, caption=caption, run_id=run_id, session_id=session_id,
            cron_run_id=(metadata or {}).get("cron_run_id"),
        ), *self._job_for(chat_id, metadata, attachment=True)))

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        """Local image (image_gen output, a screenshot, a MEDIA: tag): bytes go up
        ``/api/platform/hub/media`` as base64, the row references the media id.
        Anything the media route will not take (unknown type, over its 7 MB cap)
        is delivered as a file chip instead of being dropped."""
        try:
            thread_id = self._thread_for(chat_id, metadata)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc))
        _, session_id, run_id = self._run_context(thread_id)
        cron_run_id = (metadata or {}).get("cron_run_id")
        job = self._job_for(chat_id, metadata, attachment=True)
        mime = wire.ext_mime(image_path)
        try:
            raw = await asyncio.to_thread(_read_bytes, image_path)
        except OSError as exc:
            return SendResult(success=False, error=f"cannot read image: {type(exc).__name__}")
        if mime is None or len(raw) > wire.MAX_MEDIA_DECODED_BYTES:
            return await self._deliver(wire.with_job(wire.file_message(
                thread_id, name=os.path.basename(image_path), path=image_path, mime=mime,
                caption=caption, run_id=run_id, session_id=session_id, cron_run_id=cron_run_id,
            ), *job))
        upload = {
            "thread_id": thread_id,
            "mime": mime,
            "data_b64": base64.b64encode(raw).decode("ascii"),
            "origin": "agent",
        }
        status, data = await asyncio.to_thread(runtime.client.media, upload)
        if not _ok(status) or not data.get("media_id"):
            return _result(status, data)
        return await self._deliver(wire.with_job(wire.image_message(
            thread_id, media_id=str(data["media_id"]), mime=mime, caption=caption,
            width=data.get("width"), height=data.get("height"),
            run_id=run_id, session_id=session_id, cron_run_id=cron_run_id,
        ), *job))

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        try:
            thread_id = self._thread_for(chat_id, metadata)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc))
        _, session_id, run_id = self._run_context(thread_id)
        name = wire.clean_name(file_name or os.path.basename(file_path))
        mime = wire.guess_mime(name)
        cron_run_id = (metadata or {}).get("cron_run_id")
        job = self._job_for(chat_id, metadata, attachment=True)
        # The bytes go up to hub-api so the app can open the file. Anything the media route
        # will not take (unreadable, empty, over its cap) still lands as the chip with the
        # path on the gateway, exactly as before — a file is never silently dropped.
        try:
            raw = await asyncio.to_thread(_read_bytes, file_path)
        except OSError:
            raw = b""
        if 0 < len(raw) <= wire.MAX_MEDIA_DECODED_BYTES:
            status, data = await asyncio.to_thread(runtime.client.media, {
                "thread_id": thread_id, "mime": mime, "name": name, "origin": "agent",
                "data_b64": base64.b64encode(raw).decode("ascii"),
            })
            if _ok(status) and data.get("media_id"):
                return await self._deliver(wire.with_job(wire.file_message(
                    thread_id, name=name, path=file_path, mime=mime, caption=caption,
                    media_id=str(data["media_id"]), size_bytes=data.get("size_bytes"),
                    run_id=run_id, session_id=session_id, cron_run_id=cron_run_id,
                ), *job))
        return await self._deliver(wire.with_job(wire.file_message(
            thread_id, name=name, path=file_path, mime=mime, caption=caption,
            run_id=run_id, session_id=session_id, cron_run_id=cron_run_id,
        ), *job))

    # -- approvals ---------------------------------------------------------------
    def _newest_pending_request_id(self, session_key: str) -> Optional[str]:
        try:
            from tools.approval import list_gateway_approvals

            pending = list_gateway_approvals(session_key)
        except Exception:
            return None
        for entry in reversed(pending):
            request_id = entry.get("request_id")
            if request_id and request_id not in self._delivered_request_ids:
                return str(request_id)
        return None

    async def send_exec_approval(
        self,
        chat_id: str,
        command: str,
        session_key: str,
        description: str = "dangerous command",
        metadata: Optional[Dict[str, Any]] = None,
        allow_permanent: bool = True,
        allow_session: bool = True,
        smart_denied: bool = False,
    ) -> SendResult:
        try:
            thread_id = self._thread_for(chat_id, metadata)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc))
        request_id = self._newest_pending_request_id(session_key)
        if not request_id:
            # Returning failure makes run.py fall back to its plain-text /approve
            # prompt through send(), so the approval is still answerable.
            return SendResult(success=False, error="no pending approval to reference")
        session_id = runtime.session_id_for_key(session_key)
        run_id = (runtime.turns.turn(session_id) if session_id else None) or request_id
        body = wire.approval_message(
            thread_id,
            request_id=request_id,
            run_id=run_id,
            command=command,
            description=description,
            choices=wire.approval_choices(allow_session=allow_session, allow_permanent=allow_permanent),
            session_id=session_id,
            smart_denied=smart_denied,
            redact=runtime.redact,
        )
        result = await self._deliver(body)
        if result.success:
            self._delivered_request_ids.add(request_id)
            if len(self._delivered_request_ids) > 256:
                self._delivered_request_ids = set(list(self._delivered_request_ids)[-128:])
            try:
                from tools.approval import ack_gateway_approval

                ack_gateway_approval(session_key, request_id)
            except Exception:
                pass
        return result

    def _resolve_approval(self, ev: Dict[str, Any]) -> Dict[str, Any]:
        from tools.approval import resolve_gateway_approval

        session_key = wire.session_key_for_thread(ev["thread_id"])
        resolved = resolve_gateway_approval(
            session_key, ev["choice"], reason=ev.get("reason"), request_id=ev["request_id"]
        )
        if resolved:
            self._delivered_request_ids.discard(ev["request_id"])
            resume = getattr(self, "resume_typing_for_chat", None)
            if callable(resume):
                try:
                    resume(ev["thread_id"])
                except Exception:
                    pass
        return {"ok": resolved > 0, "resolved": resolved}

    # -- clarify -----------------------------------------------------------------
    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: Optional[list],
        clarify_id: str,
        session_key: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        try:
            thread_id = self._thread_for(chat_id, metadata)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc))
        session_id = runtime.session_id_for_key(session_key)
        run_id = runtime.turns.turn(session_id) if session_id else None
        multi = False
        try:
            from tools import clarify_gateway as _cg

            with _cg._lock:
                entry = _cg._entries.get(clarify_id)
            multi = bool(entry and getattr(entry, "multi_select", False))
        except Exception:
            multi = False
        result = await self._deliver(wire.clarify_message(
            thread_id, clarify_id=clarify_id, question=question, choices=list(choices or []),
            multi_select=multi, run_id=run_id, session_id=session_id,
        ))
        if choices:
            # Same as base.py's own fallback: a typed reply ("2", the option text,
            # or anything else) resolves the clarify through the gateway's
            # text intercept, so the buttons are a convenience, not a requirement.
            try:
                from tools.clarify_gateway import mark_awaiting_text

                mark_awaiting_text(clarify_id)
            except Exception:
                pass
        return result

    # -- inbound: hub-api -> gateway ---------------------------------------------
    def verify_http_event_request(self, auth_header: str) -> Tuple[bool, str]:
        expected = runtime.client.key()
        if not expected:
            return False, "hub_platform_key_unprovisioned"
        if not auth_header or not auth_header.startswith("Bearer "):
            return False, "missing_hub_bearer"
        presented = auth_header[7:].strip()
        if not presented or not hmac.compare_digest(presented, expected):
            return False, "invalid_hub_bearer"
        return True, ""

    async def dispatch_http_event(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            ev = wire.parse_inbound_event(payload)
        except ValueError as exc:
            return {"ok": False, "error": "invalid_event", "detail": str(exc)}
        kind = ev["kind"]
        if kind == "ping":
            # `_running` is what the base class's `_mark_connected` actually
            # sets; `_connected` never existed, so this reported a connected
            # adapter as disconnected on every ping.
            return {"ok": True, "connected": bool(getattr(self, "_running", False)), "queue": runtime.queue.stats()}
        if kind == "catalog_request":
            pushed = await self.push_catalog()
            return {"ok": pushed is not None, "pushed": pushed}
        if kind == "approval_decision":
            return self._resolve_approval(ev)
        if kind == "clarify_response":
            from tools.clarify_gateway import resolve_gateway_clarify

            resolved = bool(resolve_gateway_clarify(ev["clarify_id"], ev["response"]))
            return {"ok": resolved, "resolved": resolved}
        if kind == "stop":
            return await self._stop_turn(ev["thread_id"])
        if kind == "subagent_transcript":
            return subagent_transcript.read(ev["child_session_id"], redact=runtime.redact)
        return await self._dispatch_message(ev)

    async def _stop_turn(self, thread_id: str) -> Dict[str, Any]:
        """Stop the turn in flight for this thread.

        `/stop` is the gateway's OWN command for this — a real COMMAND_REGISTRY
        entry carrying `busy_policy: interrupt_then_dispatch`, which means that
        when a turn is running it interrupts the turn and then runs. Dispatching
        it the way every other command on this surface is dispatched — a
        `MessageEvent` whose text is the command, through `handle_message` —
        keeps one path rather than a second private one that would drift from it.

        The text is this file's own literal, never anything the agent wrote, so
        there is no leading-slash injection to guard against here.

        Reports whether a turn was actually in flight so hub-api can say
        "nothing to stop" rather than claiming it stopped something.
        """
        session_key = wire.session_key_for_thread(thread_id)
        was_running = session_key in getattr(self, "_active_sessions", {})
        source = SessionSource(
            platform=Platform("hub"),
            chat_id=thread_id,
            chat_type="dm",
            user_id=HUB_USER_ID,
            user_name=HUB_USER_NAME,
            message_id=None,
        )
        event = MessageEvent(
            text="/stop",
            message_type=MessageType.TEXT,
            user_id=HUB_USER_ID,
            user_name=HUB_USER_NAME,
            source=source,
            message_id=None,
            metadata={"hub_stop": True},
        )
        try:
            await self.handle_message(event)
        except Exception as exc:
            return {"ok": False, "error": "stop_failed", "detail": type(exc).__name__}
        return {"ok": True, "stopped": was_running}

    async def _dispatch_message(self, ev: Dict[str, Any]) -> Dict[str, Any]:
        thread_id = ev["thread_id"]
        session_key = wire.session_key_for_thread(thread_id)
        media_urls: List[str] = []
        media_types: List[str] = []
        has_image = has_file = False
        if ev["media"]:
            from gateway.platforms.base import cache_document_from_bytes, cache_image_from_bytes

            for item in ev["media"]:
                try:
                    raw = base64.b64decode(item["data_b64"])
                    if item["mime"] in wire.IMAGE_MIMES:
                        path = await asyncio.to_thread(cache_image_from_bytes, raw, wire.mime_ext(item["mime"]) or ".jpg")
                        has_image = True
                    else:
                        # A file is cached as a document under its own (cleaned) name, so the
                        # agent reads "report.pdf" rather than a hash.
                        path = await asyncio.to_thread(cache_document_from_bytes, raw, wire.clean_name(item.get("name")))
                        has_file = True
                except Exception as exc:
                    return {"ok": False, "error": "media_rejected", "detail": type(exc).__name__}
                media_urls.append(path)
                media_types.append(item["mime"])

        text = ev["text"]
        expanded = expand_midsentence_skill_text(
            text, allow_gateway_control=True, task_id=runtime.session_id_for_key(session_key)
        )
        if expanded is not None:
            text = expanded

        # Things that happened in the thread while the agent was not being
        # spoken to (a checklist item ticked) are appended to what it reads,
        # not to what the user sees — the Hub bubble says what the user typed.
        if ev.get("context_note"):
            text = f"{text}\n\n[{ev['context_note']}]" if text.strip() else f"[{ev['context_note']}]"

        source = SessionSource(
            platform=Platform("hub"),
            chat_id=thread_id,
            chat_type="dm",
            user_id=HUB_USER_ID,
            user_name=HUB_USER_NAME,
            message_id=ev["message_id"],
        )
        event = MessageEvent(
            text=text,
            message_type=(MessageType.PHOTO if has_image else MessageType.DOCUMENT if has_file else MessageType.TEXT),
            user_id=HUB_USER_ID,
            user_name=HUB_USER_NAME,
            source=source,
            message_id=ev["message_id"],
            media_urls=media_urls,
            media_types=media_types,
            metadata={"hub_client_msg_id": ev["client_msg_id"], "hub_seq": ev["seq"]},
        )
        # The composer's Queue/Steer/Redirect chip. Stock Hermes (v0.21.5)
        # resolves the busy mode from `display.busy_input_mode` per routed
        # profile, never per message, and ignores this attribute, so on a stock
        # gateway the chip does whatever that setting says. A gateway patched to
        # read a per-message override off the message's source honours it.
        if ev.get("mode"):
            source.busy_mode_override = ev["mode"]
        await self.handle_message(event)
        return {"ok": True, "session_key": session_key, "expanded": expanded is not None,
                "media": len(media_urls), "mode": ev.get("mode")}

    # -- command catalog ---------------------------------------------------------
    async def _push_catalog_later(self) -> None:
        try:
            await asyncio.sleep(CATALOG_PUSH_DELAY_S)
            await self.push_catalog()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("hub-platform: startup catalog push failed: %s", type(exc).__name__)

    async def push_catalog(self) -> Optional[int]:
        try:
            rows = await asyncio.to_thread(enumerate_catalog)
        except Exception as exc:
            logger.warning("hub-platform: catalog enumeration failed: %s", type(exc).__name__)
            return None
        status, data = await asyncio.to_thread(
            runtime.client.commands, {"version": int(time.time()), "commands": rows}
        )
        if not _ok(status):
            logger.warning("hub-platform: catalog push rejected: status=%s error=%s", status, data.get("error") or data.get("detail"))
            return None
        logger.info("hub-platform: pushed %d commands to hub-api", len(rows))
        return len(rows)


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def enumerate_catalog() -> List[Dict[str, Any]]:
    """The gateway's four live registries (builtin commands, skills,
    ``quick_commands`` aliases, plugin commands), merged by
    ``hub_wire.build_catalog``. Runs inside the gateway process only."""
    from hermes_cli.commands import COMMAND_REGISTRY, _iter_plugin_command_entries
    from agent.skill_commands import get_skill_commands

    builtins = [
        {
            "name": c.name,
            "aliases": list(c.aliases or ()),
            "description": c.description or "",
            "arg_hint": getattr(c, "args_hint", "") or "",
            "busy_policy": getattr(c, "busy_policy", None) or "reject",
        }
        for c in COMMAND_REGISTRY
        if (not c.cli_only) or bool(getattr(c, "gateway_config_gate", None))
    ]
    skills = [{"name": key, "description": (info or {}).get("description") or ""} for key, info in get_skill_commands().items()]
    aliases: List[Dict[str, Any]] = []
    try:
        from hermes_cli.config import load_config_readonly

        for name, spec in ((load_config_readonly() or {}).get("quick_commands") or {}).items():
            if isinstance(spec, dict) and spec.get("type") == "alias":
                aliases.append({"name": name, "target": spec.get("target") or ""})
    except Exception:
        aliases = []
    plugins = [
        {"name": name, "description": description or "", "arg_hint": args_hint or ""}
        for name, description, args_hint in _iter_plugin_command_entries()
    ]
    return wire.build_catalog(builtins=builtins, skills=skills, aliases=aliases, plugins=plugins)


# ---------------------------------------------------------------------------
# Mid-sentence skill-token expansion. The gateway only treats a message as a
# command when the slash is the first character (`MessageEvent.is_command()`);
# a `/skill` typed anywhere else reaches the model as prose. `skill_expand.py`
# is the pure half; this is the only place that hands it the real gateway
# callables, and the only gate between it and agent-synthesized text
# (allow_gateway_control).
# ---------------------------------------------------------------------------


def expand_midsentence_skill_text(
    text: str,
    *,
    allow_gateway_control: bool,
    task_id: Optional[str] = None,
) -> Optional[str]:
    if not allow_gateway_control or not text:
        return None
    try:
        from agent.skill_commands import (
            build_skill_invocation_message,
            build_stacked_skill_invocation_message,
            resolve_skill_command_key,
        )
    except Exception:
        return None

    resolve_plugin = None
    try:
        from hermes_cli.plugins import get_plugin_command_handler

        def resolve_plugin(token: str) -> bool:
            return get_plugin_command_handler(token.replace("_", "-")) is not None

    except Exception:
        resolve_plugin = None

    def build_one(cmd_key: str, instruction: str) -> Optional[str]:
        return build_skill_invocation_message(cmd_key, instruction, task_id=task_id)

    def build_stacked(cmd_keys: list, instruction: str):
        return build_stacked_skill_invocation_message(cmd_keys, instruction, task_id=task_id)

    try:
        return expand_midsentence_skills(
            text,
            resolve=resolve_skill_command_key,
            build_one=build_one,
            build_stacked=build_stacked,
            resolve_plugin=resolve_plugin,
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[list] = None,
    force_document: bool = False,
    caption: Optional[str] = None,
) -> Dict[str, Any]:
    """Cron/`send_message` delivery when no live adapter is in this process
    (``gateway/platform_registry.py`` standalone_sender_fn contract). Same
    hub-api routes, no adapter state needed."""
    target = str(thread_id or chat_id or "")
    if not wire.THREAD_ID_RE.match(target):
        return {"error": "hub thread id malformed"}
    for path in media_files or []:
        path = str(path)
        mime = wire.ext_mime(path)
        try:
            raw = await asyncio.to_thread(_read_bytes, path)
        except OSError:
            return {"error": f"cannot read media file {os.path.basename(path)}"}
        if mime and not force_document and len(raw) <= wire.MAX_MEDIA_DECODED_BYTES:
            status, data = await asyncio.to_thread(runtime.client.media, {
                "thread_id": target, "mime": mime, "data_b64": base64.b64encode(raw).decode("ascii"), "origin": "agent",
            })
            if _ok(status) and data.get("media_id"):
                body = wire.image_message(target, media_id=str(data["media_id"]), mime=mime, caption=caption)
            else:
                return {"error": f"hub-api media upload failed ({status})"}
        else:
            body = wire.file_message(target, name=os.path.basename(path), path=path, mime=mime, caption=caption)
        status, data = await asyncio.to_thread(runtime.client.deliver, body)
        if not _ok(status):
            return {"error": f"hub-api returned {status}"}
    status, data = await asyncio.to_thread(runtime.client.deliver, wire.text_message(target, message))
    if _ok(status):
        return {"success": True, "message_id": data.get("message_id")}
    return {"error": f"hub-api returned {status}"}


def check_hub_requirements() -> bool:
    """Passive dependency probe — stdlib only, always importable."""
    return True


def register(ctx) -> None:
    ctx.register_platform(
        name="hub",
        label="Hub",
        adapter_factory=lambda cfg: HubAdapter(cfg),
        check_fn=check_hub_requirements,
        emoji="📱",
        # `deliver=hub:<thread>` cron targets need HUB_HOME_CHANNEL set; the
        # scheduler's preflight hard-blocks a job targeting a platform without it.
        cron_deliver_env_var="HUB_HOME_CHANNEL",
        # The gateway's per-platform allowlist, the same pair every built-in
        # platform has. Unset, authorisation falls through to the global
        # GATEWAY_ALLOWED_USERS / GATEWAY_ALLOW_ALL_USERS / pairing, as before.
        allowed_users_env="HUB_ALLOWED_USERS",
        allow_all_env="HUB_ALLOW_ALL_USERS",
        standalone_sender_fn=_standalone_send,
        platform_hint=PLATFORM_HINT,
    )
