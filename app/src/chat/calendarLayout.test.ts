import {
  GAP_PX,
  monthGrid,
  MIN_BLOCK_PX,
  DEFAULT_EVENT_MIN,
  PX_PER_HOUR,
  dayHeading,
  dayNumber,
  eventTimeLabel,
  formatHour,
  formatMinute,
  layoutDay,
  parseIsoDate,
  weekdayLabel,
} from './calendarLayout';
import type { CalendarEvent } from './widget';

function event(partial: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return { title: partial.id, startMin: null, endMin: null, location: null, tone: 'neutral', ...partial };
}

describe('ISO dates are calendar dates, not UTC instants', () => {
  test('parseIsoDate lands on the named day in local time', () => {
    const d = parseIsoDate('2026-09-22');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 8, 22]);
  });

  test('the trap it exists to avoid: new Date(iso) is UTC midnight', () => {
    // Only meaningful west of Greenwich; where it is not, both agree and the
    // assertion below still holds.
    expect(parseIsoDate('2026-09-22').getDate()).toBe(22);
    expect(dayNumber('2026-09-22')).toBe('22');
  });

  test('weekday and heading come off the local date', () => {
    expect(weekdayLabel('2026-09-22')).toBe(new Date(2026, 8, 22).toLocaleDateString([], { weekday: 'short' }));
    expect(dayHeading('2026-09-22')).toContain('22');
  });
});

describe('time labels', () => {
  test('minutes from midnight render as a clock time', () => {
    expect(formatMinute(0)).toBe(new Date(2000, 0, 1, 0, 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(formatMinute(9 * 60 + 5)).toBe(new Date(2000, 0, 1, 9, 5).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });

  test('hour labels carry no minutes', () => {
    expect(formatHour(9)).toBe(new Date(2000, 0, 1, 9, 0).toLocaleTimeString([], { hour: 'numeric' }));
  });

  test('an all-day event says so; an open-ended one shows only its start', () => {
    expect(eventTimeLabel(event({ id: 'a' }))).toBe('All day');
    expect(eventTimeLabel(event({ id: 'b', startMin: 540 }))).toBe(formatMinute(540));
    expect(eventTimeLabel(event({ id: 'c', startMin: 540, endMin: 630 }))).toBe(
      `${formatMinute(540)} – ${formatMinute(630)}`,
    );
  });
});

describe('layoutDay', () => {
  test('spans only the hours the day uses, and collapses the empty ones', () => {
    const layout = layoutDay([
      event({ id: 'a', startMin: 9 * 60, endMin: 10 * 60 }),
      event({ id: 'b', startMin: 14 * 60, endMin: 15 * 60 + 30 }),
    ]);
    expect(layout.startHour).toBe(9);
    expect(layout.endHour).toBe(16);
    expect(layout.bands.map((b) => (b.kind === 'hour' ? b.hour : `gap${b.hours}`))).toEqual([
      9,
      'gap4',
      14,
      15,
    ]);
    // Four dead hours cost one short row rather than four full bands.
    expect(layout.height).toBe(3 * PX_PER_HOUR + GAP_PX);
  });

  test('an event that ends on the hour stops at the bottom of its own band', () => {
    // 11:00-12:00 with nothing at noon: the 12 band does not exist, and reading
    // the end time off it once stretched the block to the foot of the day.
    const [block] = layoutDay([event({ id: 'a', startMin: 11 * 60, endMin: 12 * 60 })]).blocks;
    expect(block.height).toBe(PX_PER_HOUR);
  });

  test('blocks are positioned and sized off the range start', () => {
    const [a, b] = layoutDay([
      event({ id: 'a', startMin: 9 * 60, endMin: 10 * 60 }),
      event({ id: 'b', startMin: 11 * 60, endMin: 11 * 60 + 30 }),
    ]).blocks;
    expect(a.top).toBe(0);
    expect(a.height).toBe(PX_PER_HOUR);
    // 9 (busy), 10 (empty -> gap), 11 (busy).
    expect(b.top).toBe(PX_PER_HOUR + GAP_PX);
    // 30 minutes is 23px of track, which cannot hold a line of title, so it
    // floors at MIN_BLOCK_PX and renders its time beside the title instead.
    expect(b.height).toBe(MIN_BLOCK_PX);
  });

  test('an event with no end gets a default duration rather than zero height', () => {
    const [block] = layoutDay([event({ id: 'a', startMin: 600 })]).blocks;
    expect(block.endMin).toBe(600 + DEFAULT_EVENT_MIN);
    expect(block.height).toBeGreaterThan(0);
  });

  test('overlapping events split the width into lanes; separate ones take it all', () => {
    const layout = layoutDay([
      event({ id: 'a', startMin: 9 * 60, endMin: 10 * 60 }),
      event({ id: 'b', startMin: 9 * 60 + 30, endMin: 10 * 60 + 30 }),
      event({ id: 'c', startMin: 12 * 60, endMin: 13 * 60 }),
    ]);
    expect(layout.blocks.map((b) => [b.left, b.width, b.lanes])).toEqual([
      ['0%', '50%', 2],
      ['50%', '50%', 2],
      ['0%', '100%', 1],
    ]);
  });

  test('events are ordered by start time regardless of input order', () => {
    const layout = layoutDay([
      event({ id: 'late', startMin: 15 * 60 }),
      event({ id: 'early', startMin: 8 * 60 }),
    ]);
    expect(layout.blocks.map((b) => b.event.id)).toEqual(['early', 'late']);
    expect(layout.blocks[0].top).toBeLessThan(layout.blocks[1].top);
  });

  test('all-day events are split out and never enter the grid', () => {
    const layout = layoutDay([event({ id: 'holiday' }), event({ id: 'standup', startMin: 570, endMin: 585 })]);
    expect(layout.allDay.map((e) => e.id)).toEqual(['holiday']);
    expect(layout.blocks.map((b) => b.event.id)).toEqual(['standup']);
  });

  test('a day with nothing timed produces no grid at all', () => {
    const layout = layoutDay([]);
    expect(layout.blocks).toEqual([]);
    expect(layout.bands).toEqual([]);
    expect(layout.height).toBe(0);
  });
});

describe('monthGrid', () => {
  const day = (date: string, events: number) => ({
    date,
    label: null,
    events: Array.from({ length: events }, (_, i) => ({
      id: `${date}-${i}`, title: 'x', startMin: 9 * 60, endMin: 10 * 60, location: null, tone: 'neutral' as const,
    })),
  });

  test('pads to whole weeks so every column is one weekday', () => {
    // 2026-09-01 is a Tuesday: the first row carries a blank Sunday and Monday.
    const rows = monthGrid([day('2026-09-01', 1), day('2026-09-30', 2)]);
    expect(rows.every((r) => r.length === 7)).toBe(true);
    expect(rows[0][0].inRange).toBe(false);
    expect(rows[0][2].date).toBe('2026-09-01');
    expect(rows[0][2].inRange).toBe(true);
  });

  test('a day with nothing on it still gets its cell', () => {
    const rows = monthGrid([day('2026-09-01', 1), day('2026-09-30', 0)]);
    const cells = rows.flat().filter((c) => c.inRange);
    expect(cells).toHaveLength(30);
    expect(cells.filter((c) => c.events.length > 0)).toHaveLength(1);
  });

  test('an ISO date lands on its own weekday, not the one before', () => {
    // The UTC-midnight trap, in the grid this time.
    const rows = monthGrid([day('2026-09-06', 1)]);
    const cell = rows.flat().find((c) => c.date === '2026-09-06')!;
    expect(rows[0].indexOf(cell)).toBe(0); // 2026-09-06 is a Sunday
  });

  test('a range that crosses a month boundary stays one grid', () => {
    const rows = monthGrid([day('2026-09-28', 1), day('2026-10-03', 1)]);
    expect(rows.flat().filter((c) => c.inRange).map((c) => c.date)).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
    ]);
  });
});
