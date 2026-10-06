"""Offline tests for widget_tool.py.
    python3 -m unittest test_widget_tool -v
"""

from __future__ import annotations

import importlib
import json
import pathlib
import re
import sys
import types
import unittest

# The gateway loads this directory as a package, so `widget_tool` imports its
# siblings relatively; the directory name has a hyphen and cannot be imported
# under it. Registering a synthetic package over the same path makes the
# relative imports resolve without a shim in the production module.
_HERE = pathlib.Path(__file__).resolve().parent
if "hub_platform" not in sys.modules:
    _pkg = types.ModuleType("hub_platform")
    _pkg.__path__ = [str(_HERE)]
    sys.modules["hub_platform"] = _pkg
wt = importlib.import_module("hub_platform.widget_tool")

# The app in this repo: <repo>/app/src/chat/widget.ts, two levels above this file.
APP_PARSER = _HERE.parents[1] / "app" / "src" / "chat" / "widget.ts"


class CatalogTests(unittest.TestCase):
    def _app_kinds(self):
        if not APP_PARSER.exists():  # plugin installed without the app checkout
            self.skipTest(f"{APP_PARSER} not present")
        source = APP_PARSER.read_text()
        union = re.search(r"export type WidgetKind =(.*?);", source, re.S)
        self.assertIsNotNone(union, "WidgetKind union not found in widget.ts")
        # The union's own comment names `clarify`; only the `| 'x'` members count.
        return set(re.findall(r"^\s*\|\s*'([a-z_]+)'", union.group(1), re.M))

    def test_the_catalog_matches_the_app_that_draws_it(self):
        """The app's parser is what actually renders these. A kind this tool
        accepts but the app cannot draw reaches the user as "could not draw
        this", so the two lists are one contract with two implementations."""
        self.assertEqual(self._app_kinds() - {"clarify"}, set(wt.KINDS))

    def test_clarify_is_drawn_by_the_app_and_never_offered_by_this_tool(self):
        """The one deliberate asymmetry. Asking the user to pick from a list is
        the native `clarify` tool's job and only its job; the plugin delivers it
        on the same `widget` part shape, so the app must draw it — but offering
        it here would be a second way to ask the same question."""
        self.assertIn("clarify", self._app_kinds())
        self.assertNotIn("clarify", wt.KINDS)

    def test_the_schema_enum_is_the_catalog(self):
        self.assertEqual(wt.SCHEMA["parameters"]["properties"]["kind"]["enum"], list(wt.KINDS))

    def test_no_select_or_confirm_shape_is_offered(self):
        """Asking the user to pick from a list is clarify's job and only
        clarify's. A second way to ask the same question is duplication."""
        for banned in ("single_select", "multi_select", "confirm", "question"):
            self.assertNotIn(banned, wt.KINDS)

    def test_kind_aliases_a_model_reaches_for(self):
        self.assertEqual(wt.normalise_kind("ButtonRow"), "button_row")
        self.assertEqual(wt.normalise_kind("button-row"), "button_row")
        self.assertEqual(wt.normalise_kind(" Agenda "), "calendar")
        self.assertEqual(wt.normalise_kind("todos"), "checklist")
        self.assertIsNone(wt.normalise_kind("teapot"))
        self.assertIsNone(wt.normalise_kind(""))
        self.assertIsNone(wt.normalise_kind(None))


class ValidateTests(unittest.TestCase):
    def test_a_drawable_payload_passes(self):
        self.assertIsNone(wt.validate("metric", {"label": "Spend", "value": 14}))
        self.assertIsNone(wt.validate("card", {"title": "Budget"}))
        self.assertIsNone(wt.validate("card", {"rows": [{"label": "a", "value": "b"}]}))
        self.assertIsNone(wt.validate("poll", {"question": "Which?", "options": ["a", "b"]}))
        self.assertIsNone(wt.validate("link", {"url": "https://x.test"}))
        self.assertIsNone(wt.validate("progress", {"value": 3, "total": 10}))

    def test_a_missing_field_names_itself(self):
        self.assertIn("value", wt.validate("metric", {"label": "Spend"}))
        self.assertIn("days", wt.validate("calendar", {}))

    def test_an_empty_collection_is_missing_not_present(self):
        self.assertIsNotNone(wt.validate("table", {"columns": [], "rows": [{"a": 1}]}))
        self.assertIsNotNone(wt.validate("checklist", {"items": []}))

    def test_a_card_with_only_a_subtitle_draws_nothing_and_is_refused(self):
        self.assertIsNotNone(wt.validate("card", {"subtitle": "only"}))

    def test_a_one_option_poll_is_refused(self):
        self.assertIsNotNone(wt.validate("poll", {"question": "Q", "options": ["only"]}))

    def test_a_non_https_link_is_refused(self):
        self.assertIsNotNone(wt.validate("link", {"url": "http://x.test"}))
        self.assertIsNotNone(wt.validate("link", {"url": "javascript:alert(1)"}))

    def test_a_zero_total_progress_is_refused(self):
        self.assertIsNotNone(wt.validate("progress", {"value": 1, "total": 0}))
        self.assertIsNotNone(wt.validate("progress", {"value": 1, "total": "soon"}))


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.posted = []
        self.reply = (200, {"ok": True})
        self._thread = wt.runtime.hub_thread_for_session
        self._queue = wt.runtime.queue
        self._post = wt.runtime.client.post
        wt.runtime.hub_thread_for_session = lambda sid: "thr_1" if sid == "hub-session" else None
        wt.runtime.queue = types.SimpleNamespace(
            post_in_order=lambda path, body, timeout=10.0: (self.posted.append((path, body)), self.reply)[1],
        )
        wt.runtime.client.post = lambda path, body: self.fail("hub_widget must post through the queue, not client.post")

    def tearDown(self):
        wt.runtime.hub_thread_for_session = self._thread
        wt.runtime.queue = self._queue
        wt.runtime.client.post = self._post

    def test_it_draws_into_the_session_s_own_thread(self):
        out = json.loads(wt.hub_widget({"kind": "metric", "props": {"label": "Spend", "value": 14}}, session_id="hub-session"))
        self.assertEqual(out, {"drawn": "metric", "thread_id": "thr_1"})
        path, body = self.posted[0]
        self.assertEqual(path, wt.DELIVER_PATH)
        self.assertEqual(body["thread_id"], "thr_1")
        self.assertEqual(body["parts"][0]["type"], "widget")
        self.assertEqual(body["parts"][0]["kind"], "metric")

    def test_a_turn_that_is_not_a_hub_thread_is_told_so_and_posts_nothing(self):
        out = json.loads(wt.hub_widget({"kind": "metric", "props": {"label": "a", "value": 1}}, session_id="discord"))
        self.assertIn("error", out)
        self.assertEqual(self.posted, [])

    def test_an_invalid_payload_is_an_error_the_model_can_retry_against(self):
        """v1 had to downgrade a bad widget to an unreadable code block with no
        signal to the model. A real error is a strict improvement."""
        out = json.loads(wt.hub_widget({"kind": "metric", "props": {"label": "a"}}, session_id="hub-session"))
        self.assertIn("value", out["error"])
        self.assertEqual(self.posted, [])

    def test_an_unknown_kind_lists_the_ones_that_exist(self):
        out = json.loads(wt.hub_widget({"kind": "teapot", "props": {}}, session_id="hub-session"))
        self.assertIn("calendar", out["error"])
        self.assertEqual(self.posted, [])

    def test_props_must_be_an_object(self):
        out = json.loads(wt.hub_widget({"kind": "card", "props": "a string"}, session_id="hub-session"))
        self.assertIn("error", out)
        self.assertEqual(self.posted, [])

    def test_a_failed_post_is_reported_not_swallowed(self):
        self.reply = (0, {"error": "unreachable"})
        out = json.loads(wt.hub_widget({"kind": "card", "props": {"title": "x"}}, session_id="hub-session"))
        self.assertEqual(out, {"error": "could not draw it (hub-api said unreachable)"})

    def test_a_widget_still_queued_is_not_a_failure(self):
        """Behind a long stream tail the in-order post can outlast its wait;
        the widget is still queued and will draw. Calling that a failure made
        the model send it again — two cards."""
        self.reply = (0, {"error": "queue_timeout"})
        out = json.loads(wt.hub_widget({"kind": "card", "props": {"title": "x"}}, session_id="hub-session"))
        self.assertEqual(out, {"drawn": "card", "thread_id": "thr_1", "queued": True})

    def test_it_waits_its_turn_in_the_delivery_queue(self):
        """Posted straight through the client, a widget overtook the deltas of
        the text that introduced it. Through
        the queue's in-order post it keeps its place behind them."""
        direct = []
        wt.runtime.client.post = lambda path, body: (direct.append(path), (200, {"ok": True}))[1]
        out = json.loads(wt.hub_widget({"kind": "card", "props": {"title": "x"}}, session_id="hub-session"))
        self.assertEqual(out["drawn"], "card")
        self.assertEqual(([p for p, _ in self.posted], direct), ([wt.DELIVER_PATH], []))

    def test_it_never_blocks_waiting_for_an_answer(self):
        """Display-only kinds return at once. Pinning a turn and its context
        budget on a human looking at a chart would be absurd."""
        for kind, props in (
            ("chart", {"series": [{"id": "a", "label": "A"}], "buckets": [{"key": "Mon", "value": 1}]}),
            ("calendar", {"days": [{"date": "2026-09-22", "events": []}]}),
            ("poll", {"question": "Q", "options": ["a", "b"]}),
        ):
            out = json.loads(wt.hub_widget({"kind": kind, "props": props}, session_id="hub-session"))
            self.assertEqual(out["drawn"], kind)


if __name__ == "__main__":
    unittest.main()


class NestedChartTests(unittest.TestCase):
    """Verbatim from a failing turn, 2026-09-22: the model described one series
    as an object and hung the buckets inside it. Coherent, just not the catalog's
    shape — and the bare error "chart needs buckets" never said where they go."""

    LIVE = {
        "series": {
            "buckets": [
                {"label": "Mon", "value": 42},
                {"label": "Tue", "value": 118},
                {"label": "Wed", "value": 65},
            ],
            "label": "Spend ($)",
        },
        "title": "Example — weekly spend",
        "variant": "bars",
    }

    def test_the_nested_shape_is_lifted_rather_than_refused(self):
        props = wt.normalise_props("chart", self.LIVE)
        self.assertIsNone(wt.validate("chart", props))
        self.assertEqual(len(props["buckets"]), 3)
        self.assertEqual(props["series"][0]["label"], "Spend ($)")
        self.assertEqual(props["title"], "Example — weekly spend")

    def test_a_correct_chart_is_left_alone(self):
        good = {"series": [{"id": "a", "label": "A"}], "buckets": [{"key": "Mon", "values": {"a": 1}}]}
        self.assertEqual(wt.normalise_props("chart", good), good)

    def test_other_kinds_are_untouched(self):
        props = {"days": [{"date": "2026-09-22", "events": []}]}
        self.assertIs(wt.normalise_props("calendar", props), props)

    def test_every_refusal_shows_the_shape_to_use(self):
        for kind, props in (("chart", {}), ("table", {}), ("calendar", {}), ("metric", {"label": "x"})):
            why = wt.validate(kind, props)
            self.assertIsNotNone(why)
            self.assertIn("Correct shape:", why)
            json.loads(why.split("Correct shape: ", 1)[1])  # the example must be valid JSON

    def test_the_shape_examples_are_themselves_valid_payloads(self):
        for kind, example in wt._SHAPES.items():
            call = json.loads(example)
            self.assertEqual(wt.normalise_kind(call["kind"]), kind)
            self.assertIsNone(wt.validate(kind, wt.normalise_props(kind, call["props"])), kind)


class ChartDrawabilityTests(unittest.TestCase):
    """The tool must not accept a chart the app then refuses to draw: a
    thread once showed "Could not draw this chart" twice for payloads
    hub_widget had already accepted.
    """

    def _validate(self, props):
        return wt.validate("chart", wt.normalise_props("chart", props))

    def test_an_object_series_is_lifted_and_accepted(self):
        # The exact live payload.
        props = {
            "title": "Example — weekly spend",
            "variant": "bars",
            "series": {"label": "Spend ($)", "buckets": [{"label": "Mon", "value": 42}]},
        }
        self.assertIsNone(self._validate(props))

    def test_an_object_series_with_no_buckets_anywhere_is_refused_with_the_shape(self):
        problem = self._validate({"series": {"label": "Spend ($)"}})
        self.assertIsNotNone(problem)
        self.assertIn("Correct shape", problem)

    def test_buckets_carrying_no_number_are_refused(self):
        props = {
            "series": [{"id": "spend", "label": "Spend"}],
            "buckets": [{"key": "Mon", "values": {"other": 4}}],
        }
        self.assertIn("number", self._validate(props))

    def test_single_series_shorthand_buckets_draw(self):
        props = {
            "series": [{"id": "spend", "label": "Spend"}],
            "buckets": [{"key": "Mon", "value": 42}],
        }
        self.assertIsNone(self._validate(props))


class WeatherTests(unittest.TestCase):
    """Weather views, hourly and daily."""

    def test_a_forecast_with_days_draws(self):
        props = {"place": "Springfield", "days": [{"label": "Today", "low": 54, "high": 63, "condition": "cloudy"}]}
        self.assertIsNone(wt.validate("weather", props))

    def test_hours_alone_draw_too(self):
        self.assertIsNone(wt.validate("weather", {"hours": [{"label": "Now", "temp": 58}]}))

    def test_a_place_with_no_weather_in_it_is_refused_with_the_shape(self):
        problem = wt.validate("weather", {"place": "Springfield"})
        self.assertIsNotNone(problem)
        self.assertIn("Correct shape", problem)

    def test_forecast_is_the_same_kind(self):
        self.assertEqual(wt.normalise_kind("forecast"), "weather")

    def test_a_precipitation_day_needs_no_temperatures(self):
        """The app draws a `precip` view from rain alone. This tool once said
        `drawn` while the app said "Could not draw this weather": the two have
        to agree."""
        props = {"view": "precip", "place": "Springfield",
                 "days": [{"label": "Today", "precip": 99, "precip_in": 0.92, "precip_hours": [35, 60, 52]}]}
        self.assertIsNone(wt.validate("weather", props))

    def test_a_day_that_says_nothing_is_refused_by_name(self):
        problem = wt.validate("weather", {"days": [{"label": "Today", "condition": "cloudy"}]})
        self.assertIn("days[0] needs low and high, or precip", problem)

    def test_an_hour_without_a_temperature_is_refused_by_name(self):
        problem = wt.validate("weather", {"hours": [{"label": "Now", "precip": 20}]})
        self.assertIn("hours[0] needs a numeric temp", problem)

    def test_more_than_a_days_worth_of_hourly_chances_is_refused(self):
        props = {"days": [{"label": "Sun", "precip": 77, "precip_hours": [10] * 31}]}
        self.assertIn("at most 24", wt.validate("weather", props))

    def test_sections_compose_the_card_and_a_bad_section_type_is_named(self):
        hours = [{"label": "Now", "temp": 58}]
        self.assertIsNone(wt.validate("weather", {"hours": hours, "sections": [{"type": "hourly", "metric": "precip"}]}))
        self.assertIn("sections[0].type", wt.validate("weather", {"hours": hours, "sections": [{"type": "radar"}]}))
        self.assertIn("sections must be a list", wt.validate("weather", {"hours": hours, "sections": "days"}))


class TimelineTests(unittest.TestCase):
    def test_labelled_items_draw_and_string_items_draw(self):
        self.assertIsNone(wt.validate("timeline", {"items": [{"time": "Mon", "label": "Shipped"}]}))
        self.assertIsNone(wt.validate("timeline", {"items": ["Ordered", "Shipped"]}))

    def test_items_with_only_a_time_are_refused(self):
        self.assertIn("needs a label", wt.validate("timeline", {"items": [{"time": "Mon"}]}))

    def test_history_is_the_same_kind(self):
        self.assertEqual(wt.normalise_kind("history"), "timeline")


class ShoppingTests(unittest.TestCase):
    ITEM = {"name": "Water bottle", "price": "$24.00", "qty": 1, "image": "https://images.example.com/b.jpg"}

    def test_a_product_needs_a_title(self):
        self.assertIsNone(wt.validate("product", {"title": "Water bottle", "price": "$24.00"}))
        self.assertIn("needs a title", wt.validate("product", {"price": "$24.00"}))

    def test_every_shopping_url_must_be_https(self):
        self.assertIn("must be https", wt.validate("product", {"title": "x", "url": "http://shop.example.com"}))
        cart = {"items": [{**self.ITEM, "image": "http://images.example.com/b.jpg"}], "total": "$24.00"}
        self.assertIn("must be https", wt.validate("cart", cart))

    def test_a_cart_needs_an_item_with_a_name_and_a_price(self):
        self.assertIsNone(wt.validate("cart", {"items": [self.ITEM], "total": "$24.00"}))
        self.assertIn("name and a price", wt.validate("cart", {"items": [{"name": "Water bottle"}]}))
        self.assertIn("items must be a list", wt.validate("cart", {"items": []}))

    def test_an_order_needs_an_id_a_total_and_items(self):
        order = {"order_id": "A-1", "total": "$24.00", "items": [self.ITEM]}
        self.assertIsNone(wt.validate("order", order))
        self.assertIn("order_id", wt.validate("order", {**order, "order_id": ""}))
        self.assertIn("total", wt.validate("order", {**order, "total": None}))
        self.assertIn("items must be a list", wt.validate("order", {**order, "items": []}))

    def test_receipt_and_basket_are_aliases(self):
        self.assertEqual(wt.normalise_kind("receipt"), "order")
        self.assertEqual(wt.normalise_kind("basket"), "cart")
