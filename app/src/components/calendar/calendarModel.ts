// Every date decision the calendar screen makes, kept out of the views.
//
// The wire carries instants with offsets and all-day date ranges with an
// exclusive end; the views want "what is on this local day, at which minute".
// That conversion happens once, here, in the phone's own zone.
//
// Layout (lanes, bands, the month grid) is not redone: days come out in the
// chat calendar widget's `CalendarDay` shape so its maths applies unchanged.
import type { CalendarDay, CalendarEvent, Tone } from '../../chat/widget';
import { ALL_DAY_LABEL, formatMinute, parseIsoDate } from '../../chat/calendarLayout';
import type { CalendarAccount, CalendarWeek, CalendarWindow, WireEvent } from '../../lib/calendarTypes';

export type CalendarView = 'agenda' | 'day' | 'week' | 'month';

export interface ScreenEvent extends CalendarEvent {
  wire: WireEvent;
  /** This day is not the event's first: it began earlier. */
  continues: boolean;
  /** The last day of a multi-day event; null when it fits in one. */
  through: string | null;
  unconfirmed: boolean;
}

/** How much of a day the snapshot can vouch for: both accounts synced its
 *  week, one did, or neither ever has. */
export type DayCoverage = 'full' | 'partial' | 'none';

/** A `CalendarDay` whose events still know the wire event they came from. */
export interface ScreenDay extends CalendarDay {
  events: ScreenEvent[];
  coverage: DayCoverage;
}

export interface NextUp {
  /** The local day this entry is on. */
  date: string;
  event: ScreenEvent;
}

export const AGENDA_DAYS = 14;
const WARN_AFTER_MS = 3 * 60 * 60 * 1000;

// The accent is chrome, under 5% of a screen (tokens.css). Work is most of any
// week, so it takes the quiet tone and the few personal events carry the colour.
const ACCOUNT_TONE: Record<CalendarAccount, Tone> = { work: 'neutral', personal: 'accent' };

export function isoDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function addDays(iso: string, n: number): string {
  const d = parseIsoDate(iso);
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function instant(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

interface Placement {
  date: string;
  startMin: number | null;
  endMin: number | null;
}

interface Extent {
  firstDay: string;
  lastDay: string;
  /** Minutes on the first and last day; null for an all-day event. */
  startMin: number | null;
  endMin: number | null;
}

/** The local days an event runs over, without visiting them: a model's "no end
 *  date" is the year 9999, and walking there froze Home. */
function extent(wire: WireEvent): Extent | null {
  if (wire.all_day) {
    const from = wire.start_date;
    const until = wire.end_date;
    if (!from || !until || !ISO_DATE.test(from) || !ISO_DATE.test(until)) return null;
    // The end is exclusive; an end not after the start still gets its day.
    const lastDay = until > from ? addDays(until, -1) : from;
    return { firstDay: from, lastDay, startMin: null, endMin: null };
  }
  const start = instant(wire.start);
  if (!start) return null;
  const end = instant(wire.end) ?? start;
  const firstDay = isoDate(start);
  // An end at exactly midnight belongs to the day that just finished.
  const endsAtMidnight = end > start && minuteOfDay(end) === 0 && end.getSeconds() === 0;
  const lastDay = endsAtMidnight ? addDays(isoDate(end), -1) : isoDate(end);
  if (lastDay <= firstDay) {
    return { firstDay, lastDay: firstDay, startMin: minuteOfDay(start), endMin: endsAtMidnight ? 1440 : minuteOfDay(end) };
  }
  return { firstDay, lastDay, startMin: minuteOfDay(start), endMin: endsAtMidnight ? 1440 : minuteOfDay(end) };
}

/** Where the event sits on one day, or null when it is not on that day. A
 *  whole middle day of a long timed event is drawn as all-day: a 24-hour block
 *  is not a time to be free around. */
function placeOn(x: Extent, date: string): Placement | null {
  if (date < x.firstDay || date > x.lastDay) return null;
  if (x.startMin === null) return { date, startMin: null, endMin: null };
  const startMin = date === x.firstDay ? x.startMin : 0;
  const endMin = date === x.lastDay ? (x.endMin ?? x.startMin) : 1440;
  if (startMin === 0 && endMin === 1440) return { date, startMin: null, endMin: null };
  return { date, startMin, endMin };
}

function screenEvent(wire: WireEvent, x: Extent, p: Placement): ScreenEvent {
  return {
    id: wire.id,
    title: wire.title,
    startMin: p.startMin,
    endMin: p.endMin,
    location: wire.location,
    tone: ACCOUNT_TONE[wire.account] ?? 'neutral',
    wire,
    continues: p.date > x.firstDay,
    through: x.lastDay > x.firstDay ? x.lastDay : null,
    unconfirmed: wire.unconfirmed === true,
  };
}

function mondayOf(iso: string): string {
  return addDays(iso, -((parseIsoDate(iso).getDay() + 6) % 7));
}

export function coverageFor(date: string, weeks: CalendarWeek[]): DayCoverage {
  const week = weeks.find((w) => w.monday === mondayOf(date));
  if (!week) return 'none';
  const synced = [week.work, week.personal].filter(Boolean).length;
  return synced === 2 ? 'full' : synced === 1 ? 'partial' : 'none';
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return (a.startMin ?? -1) - (b.startMin ?? -1) || (a.endMin ?? 0) - (b.endMin ?? 0);
}

/** One entry per date from `from` to `to` inclusive, empty days included.
 *  Without `weeks` every day counts as known — the caller has no snapshot
 *  metadata to say otherwise. */
export function toDays(events: WireEvent[], from: string, to: string, weeks?: CalendarWeek[]): ScreenDay[] {
  const extents = events.flatMap((wire) => {
    const x = extent(wire);
    return x && x.lastDay >= from && x.firstDay <= to ? [{ wire, x }] : [];
  });
  const days: ScreenDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const list: ScreenEvent[] = [];
    for (const { wire, x } of extents) {
      const p = placeOn(x, date);
      if (p) list.push(screenEvent(wire, x, p));
    }
    days.push({
      date,
      label: null,
      events: list.sort(byStart),
      coverage: weeks ? coverageFor(date, weeks) : 'full',
    });
  }
  return days;
}

export function rangeFor(view: CalendarView, anchor: string): CalendarWindow {
  const d = parseIsoDate(anchor);
  if (view === 'day') return { from: anchor, to: anchor };
  if (view === 'agenda') return { from: anchor, to: addDays(anchor, AGENDA_DAYS - 1) };
  if (view === 'week') {
    const sunday = addDays(anchor, -d.getDay());
    return { from: sunday, to: addDays(sunday, 6) };
  }
  return {
    from: isoDate(new Date(d.getFullYear(), d.getMonth(), 1)),
    to: isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

export function step(view: CalendarView, anchor: string, dir: 1 | -1): string {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'agenda') return addDays(anchor, AGENDA_DAYS * dir);
  const d = parseIsoDate(anchor);
  return isoDate(new Date(d.getFullYear(), d.getMonth() + dir, 1));
}

export function inSyncedWindow(iso: string, window: CalendarWindow | null): boolean {
  return window !== null && iso >= window.from && iso <= window.to;
}

/** Days with something on them. An event that began earlier is listed on the
 *  first day it shows and not again: an eleven-day leave is one line, not
 *  eleven sections that bury the meetings. */
export function agendaSections(days: ScreenDay[]): ScreenDay[] {
  const first = days[0]?.date;
  return days
    .map((d) => ({ ...d, events: d.events.filter((e) => !e.continues || d.date === first) }))
    .filter((d) => d.events.length > 0);
}

function upcoming(events: WireEvent[], now: Date, from: string, to: string): NextUp[] {
  const today = isoDate(now);
  const nowMin = minuteOfDay(now);
  return toDays(events, from, to).flatMap((day) =>
    day.events
      .filter((e) => e.startMin !== null)
      .filter((e) => day.date > today || (e.endMin ?? e.startMin ?? 0) > nowMin)
      .map((event) => ({ date: day.date, event })),
  );
}

/** Timed events from now through the end of tomorrow, one still running included. */
export function nextUp(events: WireEvent[], now: Date, limit = 3): NextUp[] {
  const today = isoDate(now);
  return upcoming(events, now, today, addDays(today, 1)).slice(0, limit);
}

const LOOKAHEAD_DAYS = 62;

/** The first day from now on with a timed event still to come, if any. */
export function nextBusyDay(events: WireEvent[], now: Date): string | null {
  const today = isoDate(now);
  return upcoming(events, now, today, addDays(today, LOOKAHEAD_DAYS))[0]?.date ?? null;
}

export interface Freshness {
  label: string;
  tone: 'neutral' | 'warn';
}

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

const NEAR_LATE_MS = 2 * 60 * 60 * 1000;
const FAR_LATE_MS = 24 * 60 * 60 * 1000;

/** How fresh the dates ON SCREEN are: the oldest account sync among the weeks
 *  the range touches. A week one account never synced is said, by name. */
export function freshnessFor(range: CalendarWindow, weeks: CalendarWeek[], now: Date): Freshness {
  // Days already over do not need a fresh sync: without this a Sunday-first
  // week reports last week's twelve-hourly slice for the Sunday just gone.
  const today = isoDate(now);
  const from = range.to >= today && range.from < today ? today : range.from;
  const inView = weeks.filter((w) => w.monday <= range.to && addDays(w.monday, 6) >= from);
  if (inView.length === 0 || inView.every((w) => !w.work && !w.personal)) {
    return { label: 'not synced for these dates', tone: 'warn' };
  }
  for (const account of ['work', 'personal'] as const) {
    if (inView.some((w) => !w[account])) {
      return { label: `${account} calendar not synced for these dates`, tone: 'warn' };
    }
  }
  const thisMonday = mondayOf(isoDate(now));
  const nextMonday = addDays(thisMonday, 7);
  let oldest = 0;
  let late = false;
  for (const w of inView) {
    const limit = w.monday === thisMonday || w.monday === nextMonday ? NEAR_LATE_MS : FAR_LATE_MS;
    for (const at of [w.work, w.personal]) {
      const ms = Math.max(0, now.getTime() - (instant(at)?.getTime() ?? now.getTime()));
      oldest = Math.max(oldest, ms);
      if (ms > limit) late = true;
    }
  }
  return { label: `synced ${age(oldest)}`, tone: late ? 'warn' : 'neutral' };
}

export function freshness(syncedAt: string | null, staleSlices: number, now: Date): Freshness {
  const at = instant(syncedAt);
  if (!at) return { label: 'not synced yet', tone: 'warn' };
  const ms = Math.max(0, now.getTime() - at.getTime());
  if (staleSlices > 0) return { label: `synced ${age(ms)} · partly out of date`, tone: 'warn' };
  return { label: `synced ${age(ms)}`, tone: ms > WARN_AFTER_MS ? 'warn' : 'neutral' };
}

function shortDay(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The event's own "when", for the detail sheet. */
export function whenLabel(wire: WireEvent): string {
  const x = extent(wire);
  if (!x) return '';
  if (x.startMin === null) {
    return x.firstDay === x.lastDay
      ? `${ALL_DAY_LABEL} · ${shortDay(x.firstDay)}`
      : `${ALL_DAY_LABEL} · ${shortDay(x.firstDay)} – ${shortDay(x.lastDay)}`;
  }
  const from = formatMinute(x.startMin);
  const to = formatMinute((x.endMin ?? x.startMin) % 1440);
  if (x.firstDay === x.lastDay) {
    return x.startMin === x.endMin ? `${shortDay(x.firstDay)} · ${from}` : `${shortDay(x.firstDay)} · ${from} – ${to}`;
  }
  return `${shortDay(x.firstDay)} ${from} – ${shortDay(x.lastDay)} ${to}`;
}

// calendar-sync keeps Monday-aligned weeks from two back to six ahead, and the
// endpoint serves at most 62 days on from the first: one request is the lot.
const WEEKS_BACK = 2;
const FETCH_DAYS = 62;

export function fetchRange(now: Date): CalendarWindow {
  const today = isoDate(now);
  const monday = addDays(today, -((now.getDay() + 6) % 7));
  const from = addDays(monday, -7 * WEEKS_BACK);
  return { from, to: addDays(from, FETCH_DAYS) };
}

export type Coverage = 'in' | 'partial' | 'out';

export function coverage(range: CalendarWindow, window: CalendarWindow | null): Coverage {
  if (!window || range.to < window.from || range.from > window.to) return 'out';
  return range.from >= window.from && range.to <= window.to ? 'in' : 'partial';
}

function monthDay(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function rangeTitle(view: CalendarView, anchor: string): string {
  const d = parseIsoDate(anchor);
  if (view === 'day') return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (view === 'month') return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const { from, to } = rangeFor(view, anchor);
  return `${monthDay(from)} – ${monthDay(to)}`;
}

export function windowLabel(window: CalendarWindow): string {
  return `${monthDay(window.from)} – ${monthDay(window.to)}`;
}

const SHARED_CALENDAR = /@group(\.v)?\.calendar\.google\.com$/i;
const OPTIONAL = /\[optional\]|\(optional\)/i;
/** His own country's holidays are his days off; other countries' are noise. */
const HOME_HOLIDAY = /\(US\)\s*$/;

/** Hidden by default (the user, 2026-09-30): other people's out-of-office, other
 *  countries' holidays and company events all come from shared team and
 *  company calendars he is not invited from; optional meetings say so in the
 *  title. Neither is time he has committed. */
export function isHidden(wire: WireEvent): boolean {
  if (OPTIONAL.test(wire.title)) return true;
  if (!wire.organizer || !SHARED_CALENDAR.test(wire.organizer)) return false;
  return !(wire.all_day && HOME_HOLIDAY.test(wire.title));
}

export function visibleEvents(events: WireEvent[], showHidden: boolean): WireEvent[] {
  return showHidden ? events : events.filter((e) => !isHidden(e));
}

export function hiddenCount(events: WireEvent[]): number {
  return events.filter(isHidden).length;
}
