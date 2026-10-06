// Layout maths for the calendar widget, kept out of the view so the two
// things most likely to be wrong — the timezone trap and the hour range —
// are testable without rendering anything.
import type { CalendarDay, CalendarEvent } from './widget';

/** `new Date('2026-09-22')` is UTC midnight, which renders as the 21st west of
 *  Greenwich. The schema's dates are calendar dates, so build a local one. */
export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function weekdayLabel(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString([], { weekday: 'short' });
}

export function dayNumber(iso: string): string {
  return String(parseIsoDate(iso).getDate());
}

export function dayHeading(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function clockDate(minuteOfDay: number): Date {
  return new Date(2000, 0, 1, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
}

export function formatMinute(minuteOfDay: number): string {
  return clockDate(minuteOfDay).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatHour(hour: number): string {
  return clockDate(hour * 60).toLocaleTimeString([], { hour: 'numeric' });
}

export const ALL_DAY_LABEL = 'All day';

export function eventTimeLabel(event: CalendarEvent): string {
  if (event.startMin === null) return ALL_DAY_LABEL;
  if (event.endMin === null || event.endMin <= event.startMin) return formatMinute(event.startMin);
  return `${formatMinute(event.startMin)} – ${formatMinute(event.endMin)}`;
}

export const DEFAULT_EVENT_MIN = 30;
export const PX_PER_HOUR = 46;
export const MIN_BLOCK_PX = 28;
/** An hour with nothing in it costs this instead of a full band. A real day has
 *  a dead hour at lunch and three after the last meeting; at full height they
 *  push the afternoon off the screen for no information (the user, 2026-09-22:
 *  "schedule view could be cleaned up"). */
export const GAP_PX = 22;

export interface DayBlock {
  event: CalendarEvent;
  startMin: number;
  endMin: number;
  top: number;
  height: number;
  left: `${number}%`;
  width: `${number}%`;
  lanes: number;
}

/** A run of empty hours, drawn as one short row, or a single hour that holds
 *  something. Both carry their own offset so the view never re-derives it. */
export type Band =
  | { kind: 'hour'; hour: number; top: number; height: number }
  | { kind: 'gap'; hours: number; top: number; height: number };

export interface DayLayout {
  startHour: number;
  endHour: number;
  bands: Band[];
  height: number;
  blocks: DayBlock[];
  allDay: CalendarEvent[];
}

function pct(fraction: number): `${number}%` {
  return `${Math.round(fraction * 1000) / 10}%`;
}

interface Span {
  event: CalendarEvent;
  startMin: number;
  endMin: number;
  lane: number;
}

/** Greedy lane assignment over transitively-overlapping runs, so two events at
 *  the same hour sit side by side instead of on top of each other. */
function assignLanes(spans: Span[]): number[] {
  const laneCounts: number[] = new Array(spans.length).fill(1);
  let runStart = 0;
  let runEnd = -Infinity;
  let laneFreeAt: number[] = [];

  const closeRun = (endIndex: number) => {
    for (let i = runStart; i < endIndex; i += 1) laneCounts[i] = laneFreeAt.length;
  };

  spans.forEach((span, i) => {
    if (span.startMin >= runEnd) {
      closeRun(i);
      runStart = i;
      runEnd = -Infinity;
      laneFreeAt = [];
    }
    let lane = laneFreeAt.findIndex((freeAt) => freeAt <= span.startMin);
    if (lane === -1) {
      lane = laneFreeAt.length;
      laneFreeAt.push(span.endMin);
    } else {
      laneFreeAt[lane] = span.endMin;
    }
    span.lane = lane;
    runEnd = Math.max(runEnd, span.endMin);
  });
  closeRun(spans.length);
  return laneCounts;
}

export function layoutDay(
  events: CalendarEvent[],
  pxPerHour = PX_PER_HOUR,
  minBlockPx = MIN_BLOCK_PX,
): DayLayout {
  const allDay = events.filter((e) => e.startMin === null);
  const spans: Span[] = events
    .filter((e) => e.startMin !== null)
    .map((event) => {
      const startMin = Math.min(event.startMin as number, 1440);
      const raw = event.endMin ?? startMin + DEFAULT_EVENT_MIN;
      return {
        event,
        startMin,
        endMin: Math.min(Math.max(raw, startMin + DEFAULT_EVENT_MIN), 1440),
        lane: 0,
      };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  if (spans.length === 0) {
    return { startHour: 0, endHour: 0, bands: [], height: 0, blocks: [], allDay };
  }

  const startHour = Math.floor(spans[0].startMin / 60);
  const lastEnd = spans.reduce((max, s) => Math.max(max, s.endMin), 0);
  const endHour = Math.max(startHour + 1, Math.ceil(lastEnd / 60));
  const laneCounts = assignLanes(spans);
  const bands = buildBands(spans, startHour, endHour, pxPerHour);
  // Every hour a span touches is busy by construction, so the band is always
  // there. An end time sits on the hour it *finishes* in, not the next one:
  // 11:00-12:00 ends at the bottom of the 11 band, which may be followed by a
  // collapsed gap.
  const bandFor = (hour: number) =>
    bands.find((b): b is Extract<Band, { kind: 'hour' }> => b.kind === 'hour' && b.hour === hour)!;
  const offsetOf = (minute: number, isEnd = false) => {
    const hour = Math.floor((isEnd ? minute - 1 : minute) / 60);
    const band = bandFor(hour);
    return band.top + ((minute - hour * 60) / 60) * band.height;
  };

  const blocks = spans.map((span, i) => {
    const lanes = Math.max(1, laneCounts[i]);
    const top = offsetOf(span.startMin);
    return {
      event: span.event,
      startMin: span.startMin,
      endMin: span.endMin,
      top,
      height: Math.max(minBlockPx, offsetOf(span.endMin, true) - top),
      left: pct(span.lane / lanes),
      width: pct(1 / lanes),
      lanes,
    };
  });

  const last = bands[bands.length - 1];
  return { startHour, endHour, bands, height: last.top + last.height, blocks, allDay };
}

function buildBands(spans: Span[], startHour: number, endHour: number, pxPerHour: number): Band[] {
  const bands: Band[] = [];
  let top = 0;
  let gap = 0;
  const flushGap = () => {
    if (gap === 0) return;
    bands.push({ kind: 'gap', hours: gap, top, height: GAP_PX });
    top += GAP_PX;
    gap = 0;
  };
  for (let hour = startHour; hour < endHour; hour += 1) {
    const from = hour * 60;
    const busy = spans.some((s) => s.startMin < from + 60 && s.endMin > from);
    if (!busy) {
      gap += 1;
      continue;
    }
    flushGap();
    bands.push({ kind: 'hour', hour, top, height: pxPerHour });
    top += pxPerHour;
  }
  flushGap();
  return bands;
}

export function gapLabel(hours: number): string {
  return `${hours}h free`;
}

/** A month laid out as calendar weeks: whole rows of seven, Sunday first, with
 * the days either side of the range left blank so every column is one weekday.
 * The days given are indexed by date, so a month with gaps (only the days that
 * have something on them) still lands in the right cells. */
export interface MonthCell {
  date: string | null;
  day: number | null;
  events: CalendarEvent[];
  inRange: boolean;
}

export function monthGrid(days: CalendarDay[]): MonthCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dates = days.map((d) => parseIsoDate(d.date)).sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0];
  const last = dates[dates.length - 1];
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + (6 - last.getDay()));

  const rows: MonthCell[][] = [];
  let row: MonthCell[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const known = byDate.get(iso);
    row.push({
      date: iso,
      day: d.getDate(),
      events: known?.events ?? [],
      inRange: d >= first && d <= last,
    });
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
