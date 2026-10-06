# SPDX-License-Identifier: MIT
"""``hub_widget`` — the tool the agent draws with in a Hub thread.

Two design decisions this file implements literally:

* **A real registered tool, not a fenced-block convention.** A fenced-block
  design has to regex assistant text for a ``hubui`` fence and, on a bad
  payload, silently downgrade to an unreadable code block with no signal to the
  model. ``ctx.register_tool`` removes that constraint: an invalid ``props`` is
  a real error string the model sees and can retry against.
* **No select/confirm shapes.** Asking the user to pick from a list is
  `clarify`'s job and only `clarify`'s — it is a blocking call that returns
  their answer into the model's context. A second way to ask the same question
  would be duplication. The catalog here is scoped to what clarify
  structurally cannot do.

Display-only kinds never block: the handler posts the widget and returns an ack
immediately. Pinning a turn (and its context budget) on a human looking at a
chart would be absurd, and a poll may sit open for days.

The catalog below must stay in step with the app's own parser,
``app/src/chat/widget.ts`` in this repo — that file is what actually draws
these, and a kind this tool accepts but the app cannot draw renders as a "could
not draw" line. ``test_widget_tool.py`` reads the TypeScript union and fails if
the two lists drift.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from . import runtime
from .hub_client import DELIVER_PATH

logger = logging.getLogger(__name__)

# One entry per kind: the props that must be present and usable for the app's
# parser to return a widget rather than null.
_REQUIRED: Dict[str, Tuple[str, ...]] = {
    "card": (),  # needs a title, body or rows — checked below
    "metric": ("label", "value"),
    "chart": ("series", "buckets"),
    "table": ("columns", "rows"),
    "progress": ("value",),
    "link": ("url",),
    "button_row": ("buttons",),
    "poll": ("question", "options"),
    "checklist": ("items",),
    "timeline": ("items",),
    "calendar": ("days",),
    "weather": (),  # needs hours, days or a temperature — checked below
    "form": ("fields",),
    "product": (),  # needs a title or a name — checked below
    "cart": (),  # needs items — checked below
    "order": (),  # needs order_id, items and a total — checked below
}

KINDS: Tuple[str, ...] = tuple(sorted(_REQUIRED))

_ALIASES = {
    "buttons": "button_row",
    "buttonrow": "button_row",
    "actions": "button_row",
    "todo": "checklist",
    "todos": "checklist",
    "plan": "checklist",
    "tasks": "checklist",
    "log": "timeline",
    "history": "timeline",
    "activity": "timeline",
    "schedule": "calendar",
    "forecast": "weather",
    "agenda": "calendar",
    "bar_chart": "chart",
    "line_chart": "chart",
    "stat": "metric",
    "product_card": "product",
    "basket": "cart",
    "receipt": "order",
    "confirmation": "order",
}


def normalise_kind(raw: Any) -> Optional[str]:
    if not isinstance(raw, str) or not raw.strip():
        return None
    k = raw.strip().replace("-", "_").replace(" ", "_").lower()
    if k in _REQUIRED:
        return k
    return _ALIASES.get(k.replace("_", ""), _ALIASES.get(k))


def _nonempty(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, tuple, dict)):
        return len(value) > 0
    return True


# What a correct payload looks like, per kind. These ride back on every
# rejection: a bare "chart needs buckets" does not say where buckets go, so the
# model has no way to correct itself.
_SHAPES = {
    "chart": '{"kind":"chart","props":{"variant":"bars","title":"Weekly spend",'
             '"series":[{"id":"spend","label":"Spend ($)"}],'
             '"buckets":[{"key":"Mon","values":{"spend":42}},{"key":"Tue","values":{"spend":118}}]}}',
    "calendar": '{"kind":"calendar","props":{"view":"day","days":[{"date":"2026-09-22",'
                '"events":[{"title":"Standup","start":"09:30","end":"09:45"}]}]}}',
    "table": '{"kind":"table","props":{"columns":[{"key":"day","label":"Day"}],'
             '"rows":[{"day":"Mon"}]}}',
    "metric": '{"kind":"metric","props":{"label":"Spend today","value":"4.82","unit":"USD"}}',
    "checklist": '{"kind":"checklist","props":{"items":[{"label":"Draft","state":"done"}]}}',
    "timeline": '{"kind":"timeline","props":{"title":"Package","items":[{"time":"Mon 9:04 AM",'
                '"label":"Ordered","detail":"Confirmation emailed"},{"time":"Tue 3:12 PM","label":"Shipped",'
                '"tone":"up"},{"time":"Thu","label":"Out for delivery"}]}}',
    "poll": '{"kind":"poll","props":{"question":"Which?","options":["A","B"]}}',
    "progress": '{"kind":"progress","props":{"label":"Backfill","value":49,"total":54}}',
    "card": '{"kind":"card","props":{"title":"Daily brief","rows":[{"label":"Email","value":"ok"}]}}',
    "link": '{"kind":"link","props":{"url":"https://example.com","title":"The report"}}',
    "button_row": '{"kind":"button_row","props":{"buttons":[{"id":"go","label":"Go"}]}}',
    "form": '{"kind":"form","props":{"fields":[{"id":"name","label":"Name"}]}}',
    "weather": '{"kind":"weather","props":{"place":"Springfield","temp":58,"feels_like":53,'
               '"hours":[{"label":"Now","temp":58,"condition":"partly_cloudy"},'
               '{"label":"7PM","temp":57,"condition":"clear","night":true}],'
               '"days":[{"label":"Today","low":54,"high":63,"condition":"cloudy","precip":0},'
               '{"label":"Sat","low":56,"high":60,"condition":"rain","precip":85}],'
               '"sections":[{"type":"days","title":"Week ahead","days":5},'
               '{"type":"hourly","title":"Sat rain","day":1,"metric":"precip","hours":12}]}}',
    "product": '{"kind":"product","props":{"title":"Insulated water bottle, 750 ml",'
               '"image":"https://images.example.com/bottle.jpg","merchant":"Example Store",'
               '"price":"$24.00","was":"$30.00","rating":"4.6","eta":"Arrives Thu",'
               '"url":"https://shop.example.com/p/123","badge":"Price drop","badge_tone":"warn"}}',
    "cart": '{"kind":"cart","props":{"items":['
            '{"image":"https://images.example.com/bottle.jpg","name":"Water bottle","qty":1,"price":"$24.00"}],'
            '"subtotal":"$24.00","shipping":"$0.00","tax":"$1.50","total":"$25.50"}}',
    "order": '{"kind":"order","props":{"order_id":"A-10293","placed":"Sat 12:31 AM",'
             '"items":[{"name":"Water bottle","qty":1,"price":"$24.00"}],'
             '"subtotal":"$24.00","total":"$25.50","payment":"Visa ••••4242",'
             '"address":"Home, Springfield","eta":"Thu"}}',
}


def _refuse(kind: str, why: str) -> str:
    shape = _SHAPES.get(kind)
    return f"{why}. Correct shape: {shape}" if shape else why


def normalise_props(kind: str, props: Dict[str, Any]) -> Dict[str, Any]:
    """Straighten the shapes a model reaches for that mean the right thing.

    The one seen in practice: a chart with its buckets nested inside `series`,
    and `series` an object rather than a list —
    `{"series": {"label": "Spend ($)", "buckets": [{"label": "Mon", "value": 42}]}}`.
    That is a coherent way to describe one series; it just is not the shape the
    catalog takes. Lifting it is better than refusing it."""
    if kind != "chart":
        return props
    series = props.get("series")
    if not isinstance(series, dict):
        return props
    out = dict(props)
    buckets = series.get("buckets")
    if isinstance(buckets, list) and not _nonempty(props.get("buckets")):
        out["buckets"] = buckets
    label = series.get("label") or series.get("name") or "Series"
    out["series"] = [{"id": series.get("id") or "series", "label": str(label), "color": series.get("color")}]
    # Single-series buckets come through as {label, value}; the parser reads that.
    return out


def _chart_problem(props: Dict[str, Any]) -> Optional[str]:
    """Mirror the app parser's own preconditions for a chart.

    `_nonempty` is true of any non-empty dict, so a chart whose `series` was an
    object would sail through this tool and then draw as "Could not draw this
    chart" in the app, which reads `series` as a list. A payload this tool
    accepts has to be one the app can actually draw.
    """
    series = [s for s in props.get("series") or [] if isinstance(s, dict)]
    if not isinstance(props.get("series"), list) or not series:
        return "chart series must be a list of {id,label} objects"
    if not any(_nonempty(s.get("id")) and _nonempty(s.get("label") or s.get("id")) for s in series):
        return "each chart series needs an id and a label"
    buckets = [b for b in props.get("buckets") or [] if isinstance(b, dict)]
    if not isinstance(props.get("buckets"), list) or not buckets:
        return "chart buckets must be a list of {key,values} objects"
    ids = {str(s.get("id")) for s in series}
    drawable = [
        b for b in buckets
        if _nonempty(b.get("key") or b.get("label") or b.get("x"))
        and (
            any(isinstance((b.get("values") or {}).get(i), (int, float)) for i in ids)
            or isinstance(b.get("value", b.get("y")), (int, float))
        )
    ]
    if not drawable:
        return "no chart bucket carries a number for any series"
    return None


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _timeline_problem(props: Dict[str, Any]) -> Optional[str]:
    """Mirror the app parser's preconditions for timeline (widget.ts `parseTimeline`).

    The app drops an item with nothing to say and refuses the widget once
    nothing is left, so a timeline whose items carried only a `time` would draw
    as "Could not draw this timeline" while this tool had said `drawn`. The two
    have to agree, and the model has to hear why here, not from the screen.
    """
    items = props.get("items")
    if not isinstance(items, list):
        return "timeline items must be a list of {time,label,detail}"
    drawable = [
        it for it in items
        if isinstance(it, dict)
        and _nonempty(it.get("label") or it.get("text") or it.get("title") or it.get("what"))
    ]
    if not drawable and any(not isinstance(it, str) or not it.strip() for it in items):
        return "each timeline item needs a label"
    return None


def _weather_problem(props: Dict[str, Any]) -> Optional[str]:
    """Mirror the app parser's preconditions for weather (widget.ts `parseWeather`).

    The app drops an hour without a temperature and a day that says nothing —
    no range and nothing about rain — and refuses the widget once nothing is
    left. A `precip` view whose days carried only rain must draw, and a day
    with neither must be refused here rather than by the screen.
    """
    hours = props.get("hours") or []
    days = props.get("days") or []
    if not isinstance(hours, list) or not isinstance(days, list):
        return "hours and days must be lists"
    for i, hour in enumerate(hours):
        if not isinstance(hour, dict) or _num(hour.get("temp", hour.get("temperature"))) is None:
            return f"hours[{i}] needs a numeric temp"
    for i, day in enumerate(days):
        if not isinstance(day, dict):
            return f"days[{i}] must be an object"
        has_range = (
            _num(day.get("low", day.get("min"))) is not None and _num(day.get("high", day.get("max"))) is not None
        )
        has_rain = any(day.get(k) is not None for k in ("precip", "precip_hours", "precip_in"))
        if not has_range and not has_rain:
            return f"days[{i}] needs low and high, or precip"
        hourly = day.get("precip_hours")
        if hourly is not None and (not isinstance(hourly, list) or len(hourly) > 24):
            return f"days[{i}].precip_hours is one chance per hour of that day, at most 24 values"
    sections = props.get("sections")
    if sections is not None:
        if not isinstance(sections, list):
            return "sections must be a list of section objects, each with a type of days, precip, hourly or composite"
        for i, section in enumerate(sections):
            if not isinstance(section, dict):
                return f"sections[{i}] must be an object"
            kind = str(section.get("type") or section.get("kind") or "").strip().lower()
            if kind not in ("days", "precip", "hourly", "composite"):
                return f"sections[{i}].type must be days, precip, hourly or composite"
    if not hours and not days and _num(props.get("temp")) is None:
        return "weather needs hours, days or at least a temperature"
    return None


def _shopping_urls(props: Dict[str, Any]) -> List[str]:
    """Every URL a shopping kind carries, at any depth the app reads."""
    urls: List[str] = []
    for key in ("image", "image_url", "thumbnail", "url", "link"):
        v = props.get(key)
        if isinstance(v, str) and v.strip():
            urls.append(v.strip())
    items = props.get("items") or []
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict):
                for key in ("image", "image_url", "thumbnail"):
                    v = it.get(key)
                    if isinstance(v, str) and v.strip():
                        urls.append(v.strip())
    return urls


def _items_problem(props: Dict[str, Any], label: str) -> Optional[str]:
    """Mirror the app's `parseShopItems`: a row without a name is dropped, and
    the widget is refused once nothing is left."""
    items = props.get("items") or []
    if not isinstance(items, list) or not items:
        return f"{label} items must be a list of {{name,price}} objects"
    drawable = [
        it for it in items
        if isinstance(it, dict) and _nonempty(it.get("name") or it.get("title"))
        and _nonempty(it.get("price") or it.get("amount"))
    ]
    if not drawable:
        return f"each {label} item needs a name and a price"
    return None


def validate(kind: str, props: Dict[str, Any]) -> Optional[str]:
    """None when the payload will draw; otherwise the reason, for the model."""
    missing = [f for f in _REQUIRED[kind] if not _nonempty(props.get(f))]
    if missing:
        return _refuse(kind, f"{kind} needs {', '.join(missing)}")
    if kind == "timeline":
        problem = _timeline_problem(props)
        if problem:
            return _refuse(kind, problem)
    if kind == "chart":
        problem = _chart_problem(props)
        if problem:
            return _refuse(kind, problem)
    if kind == "weather":
        problem = _weather_problem(props)
        if problem:
            return _refuse(kind, problem)
    if kind == "card" and not any(_nonempty(props.get(f)) for f in ("title", "body", "text", "rows")):
        return _refuse(kind, "card needs a title, a body or rows")
    if kind == "product" and not any(_nonempty(props.get(f)) for f in ("title", "name")):
        return _refuse(kind, "product needs a title")
    if kind in ("product", "cart", "order"):
        bad = [u for u in _shopping_urls(props) if not u.lower().startswith("https://")]
        if bad:
            return _refuse(kind, f"shopping image and url props must be https (got {bad[0]})")
    if kind == "cart":
        problem = _items_problem(props, "cart")
        if problem:
            return _refuse(kind, problem)
    if kind == "order":
        if not any(_nonempty(props.get(f)) for f in ("order_id", "orderId", "id")):
            return _refuse(kind, "order needs an order_id")
        if not _nonempty(props.get("total")):
            return _refuse(kind, "order needs a total")
        problem = _items_problem(props, "order")
        if problem:
            return _refuse(kind, problem)
    if kind == "poll" and len(props.get("options") or []) < 2:
        return _refuse(kind, "poll needs at least two options")
    if kind == "link" and not str(props.get("url") or "").lower().startswith("https://"):
        return _refuse(kind, "link url must be https")
    if kind == "progress":
        total = props.get("total", props.get("max", 100))
        try:
            if float(total) <= 0:
                return _refuse(kind, "progress total must be greater than zero")
        except (TypeError, ValueError):
            return _refuse(kind, "progress total must be a number")
    return None


SCHEMA: Dict[str, Any] = {
    "name": "hub_widget",
    "description": (
        "Draw a rich component in the Hub chat thread you are talking to the user in: a card, "
        "metric, chart, table, progress bar, link, button row, poll, checklist, timeline, calendar, "
        "weather, form, product, cart or order. Use it when a shape carries the answer "
        "better than prose — a week's schedule, a spend breakdown, a plan you are working through, "
        "a comparison table, a product with its photo and price, a basket, an order "
        "confirmation. Returns as soon as it is drawn; it does not wait for the user. To ASK "
        "them something, use `clarify` instead — this tool never collects an answer."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": list(KINDS), "description": "Which component to draw."},
            "props": {
                "type": "object",
                "description": (
                    "The component's content. card: title, subtitle, body, rows[{label,value,tone}]. "
                    "metric: label, value, unit, delta, delta_tone. chart: variant(bars|line), title, "
                    "series[{id,label,color}], buckets[{key,values{series_id:number}}]. table: columns[{key,label,align}], "
                    "rows[{...}]. progress: label, value, total. link: url(https), title. "
                    "button_row: prompt, buttons[{id,label}]. poll: question, options[{id,label}]. "
                    "checklist: title, items[{label,state:todo|doing|done|blocked,note}]. "
                    "timeline: title, caption, items[{time,label,detail,tone}] — a timestamped event log, "
                    "newest or oldest first as written; use it for packages, orders, deploys, anything that "
                    "reads as a history rather than as a to-do list. "
                    "calendar: view(day|week|month), days[{date:YYYY-MM-DD,events[{title,start:HH:MM,end,location}]}] — day draws an hour grid, week a row per day, month a real grid of weeks for a long range. "
                    "weather: view(conditions|precip|hourly|composite), metric(temp|feels|precip|wind|humidity|uv|cloud), "
                    "place, temp, feels_like, summary, "
                    "hours[{label,temp,condition,night,precip,feels_like,wind,humidity,uv,cloud}], "
                    "days[{label,low,high,condition,precip,precip_in,precip_hours[]}]. `conditions` = the hour strip "
                    "plus a temperature bar per day inside the whole range; `precip` = rain by the hour plus inches and "
                    "chance per day; `hourly` = one measure across one day (pick it with `metric`); `composite` = a card "
                    "per measure, stacked. Condition is one of clear|partly_cloudy|cloudy|rain|snow|storm|wind|fog. "
                    "sections[{type(days|precip|hourly|composite),title,days,hours,from,day,metric,metrics}] composes "
                    "the card from blocks instead of one view — a day count, an hour count, a label and a per-day "
                    "hourly chart are each the section's own; an hour may carry a `day` index and a section may name "
                    "`metric` (one measure) or `metrics` (a stack). "
                    "form: title, fields[{id,label,type:text|number|textarea}]. "
                    "product: title, image(https), merchant, price, was, rating, reviews, eta, url(https), badge, badge_tone — the whole card taps to url. "
                    "cart: items[{name,price,qty,image(https)}], subtotal, shipping, tax, promo, total. "
                    "order: order_id, placed, items[{name,price,qty,image(https)}], subtotal, shipping, tax, promo, total, payment, address, eta, url(https). "
                    "tone is one of neutral|up|down|warn|accent; colors are theme token names "
                    "(series-1..series-7, accent, petrol, status-up, status-down, status-warn)."
                ),
            },
        },
        "required": ["kind", "props"],
    },
}


def _error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def hub_widget(args: Dict[str, Any], **kwargs: Any) -> str:
    session_id = kwargs.get("session_id") or ""
    thread_id = runtime.hub_thread_for_session(session_id)
    if not thread_id:
        return _error("hub_widget only draws in a Hub chat thread; this turn is not one")

    kind = normalise_kind(args.get("kind"))
    if kind is None:
        return _error(f"unknown kind {args.get('kind')!r}; one of: {', '.join(KINDS)}")

    props = args.get("props")
    if not isinstance(props, dict):
        return _error("props must be an object")

    props = normalise_props(kind, props)
    problem = validate(kind, props)
    if problem:
        return _error(problem)

    part: Dict[str, Any] = {"type": "widget", "kind": kind, "props": props}
    body = {"thread_id": thread_id, "parts": [part]}
    status, data = runtime.queue.post_in_order(DELIVER_PATH, body)
    if status == 0 and data.get("error") == "queue_timeout":
        # Still queued behind the turn's own deltas; it will draw when they
        # have. Calling that a failure made the model send it again.
        return json.dumps({"drawn": kind, "thread_id": thread_id, "queued": True}, ensure_ascii=False)
    if not 200 <= status < 300:
        return _error(f"could not draw it (hub-api said {status or 'unreachable'})")
    return json.dumps({"drawn": kind, "thread_id": thread_id}, ensure_ascii=False)


def register_widget_tool(ctx: Any) -> None:
    schema = dict(SCHEMA)
    ctx.register_tool(
        name="hub_widget",
        toolset="hub",
        schema=schema,
        handler=hub_widget,
        description=schema["description"],
        emoji="\U0001f4ca",
    )


__all__ = ["KINDS", "SCHEMA", "hub_widget", "normalise_kind", "normalise_props", "register_widget_tool", "validate"]
