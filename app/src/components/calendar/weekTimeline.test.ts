import type { ScreenEvent } from './calendarModel';
import { dayRows, freeLabel } from './weekTimeline';

function ev(id: string, startMin: number | null, endMin: number | null): ScreenEvent {
  return {
    id,
    title: id,
    startMin,
    endMin,
    location: null,
    tone: 'neutral',
    continues: false,
    through: null,
    unconfirmed: false,
    wire: {} as ScreenEvent['wire'],
  };
}

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

function shape(rows: ReturnType<typeof dayRows>) {
  return rows.map((r) =>
    r.kind === 'event'
      ? `${r.event.id}${r.overlaps ? '!' : ''}${r.past ? '~' : ''}`
      : r.kind === 'gap'
        ? `gap ${r.minutes}`
        : 'now',
  );
}

test('events in order, a gap of 45 minutes or more between them said as free', () => {
  const rows = dayRows([ev('b', h(13), h(14)), ev('a', h(10), h(10, 30)), ev('c', h(14, 30), h(15))], null);
  expect(shape(rows)).toEqual(['a', 'gap 150', 'b', 'c']);
});

test('a gap is measured from the latest end so far, not the last event listed', () => {
  const rows = dayRows([ev('long', h(9), h(12)), ev('inside', h(10), h(10, 30)), ev('after', h(13), h(14))], null);
  expect(shape(rows)).toEqual(['long!', 'inside!', 'gap 60', 'after']);
});

test('events that overlap are both marked', () => {
  const rows = dayRows([ev('x', h(14), h(15)), ev('y', h(14, 30), h(14, 55)), ev('z', h(15), h(16))], null);
  expect(shape(rows)).toEqual(['x!', 'y!', 'z']);
});

test('touching end to start is not an overlap', () => {
  expect(shape(dayRows([ev('a', h(9), h(10)), ev('b', h(10), h(11))], null))).toEqual(['a', 'b']);
});

test('now sits before the first event still to start, and what has ended is past', () => {
  const rows = dayRows([ev('a', h(10), h(10, 30)), ev('b', h(16), h(17)), ev('c', h(18), h(19))], h(16, 40));
  // b is running at 4:40, so now comes before the free hour after it.
  expect(shape(rows)).toEqual(['a~', 'gap 330', 'b', 'now', 'gap 60', 'c']);
});

test('inside a free stretch, now splits it and only what is left is said', () => {
  const rows = dayRows([ev('a', h(9), h(10)), ev('b', h(14), h(15))], h(12));
  expect(shape(rows)).toEqual(['a~', 'now', 'gap 120', 'b']);
});

test('when little of a free stretch is left, it is not said at all', () => {
  const rows = dayRows([ev('a', h(9), h(10)), ev('b', h(14), h(15))], h(13, 30));
  expect(shape(rows)).toEqual(['a~', 'now', 'b']);
});

test('once everything has ended, now is last', () => {
  expect(shape(dayRows([ev('a', h(9), h(10))], h(12)))).toEqual(['a~', 'now']);
});

test('before anything starts, now is first', () => {
  expect(shape(dayRows([ev('a', h(9), h(10))], h(8)))).toEqual(['now', 'a']);
});

test('all-day entries are not rows on the rail', () => {
  expect(shape(dayRows([ev('whole', null, null), ev('a', h(9), h(10))], null))).toEqual(['a']);
});

test('free time reads in hours and minutes', () => {
  expect(freeLabel(45)).toBe('45m free');
  expect(freeLabel(60)).toBe('1h free');
  expect(freeLabel(150)).toBe('2h 30m free');
});
