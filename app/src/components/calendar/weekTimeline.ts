// A day in the week view as a vertical timeline (the user, 2026-09-30, option 2d):
// its meetings in order, the free stretches between them said in words, clashes
// marked, and a line for now. Pure, so the ordering rules are tested alone.
import type { ScreenEvent } from './calendarModel';

/** Shorter gaps are just the walk between rooms. */
export const MIN_FREE_MIN = 45;

export type DayRow =
  | { kind: 'event'; event: ScreenEvent; overlaps: boolean; past: boolean }
  | { kind: 'gap'; from: number; minutes: number }
  | { kind: 'now' };

export function dayRows(events: ScreenEvent[], nowMin: number | null): DayRow[] {
  const timed = events
    .filter((e) => e.startMin !== null)
    .sort((a, b) => (a.startMin as number) - (b.startMin as number) || (a.endMin ?? 0) - (b.endMin ?? 0));
  const span = (e: ScreenEvent) => [e.startMin as number, Math.max(e.endMin ?? 0, e.startMin as number)] as const;

  const rows: DayRow[] = [];
  let latestEnd: number | null = null;
  for (const e of timed) {
    const [start, end] = span(e);
    if (latestEnd !== null && start - latestEnd >= MIN_FREE_MIN) {
      rows.push({ kind: 'gap', from: latestEnd, minutes: start - latestEnd });
    }
    const overlaps = timed.some((o) => o !== e && span(o)[0] < end && span(o)[1] > start);
    rows.push({ kind: 'event', event: e, overlaps, past: nowMin !== null && end <= nowMin });
    latestEnd = latestEnd === null ? end : Math.max(latestEnd, end);
  }

  if (nowMin !== null) {
    // Inside a free stretch, now splits it and only what is left is said.
    const inside = rows.findIndex((r) => r.kind === 'gap' && r.from <= nowMin && r.from + r.minutes > nowMin);
    if (inside !== -1) {
      const gap = rows[inside] as Extract<DayRow, { kind: 'gap' }>;
      const left = gap.from + gap.minutes - nowMin;
      const rest: DayRow[] = left >= MIN_FREE_MIN ? [{ kind: 'gap', from: nowMin, minutes: left }] : [];
      rows.splice(inside, 1, { kind: 'now' }, ...rest);
    } else {
      // Otherwise before the first row, meeting or free stretch, not yet begun.
      const next = rows.findIndex((r) => (r.kind === 'event' ? (r.event.startMin as number) : r.kind === 'gap' ? r.from : 0) > nowMin);
      rows.splice(next === -1 ? rows.length : next, 0, { kind: 'now' });
    }
  }
  return rows;
}

export function freeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m free`;
  return m ? `${h}h ${m}m free` : `${h}h free`;
}
