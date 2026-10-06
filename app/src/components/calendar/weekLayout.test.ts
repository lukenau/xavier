import type { CalendarDay, CalendarEvent } from '../../chat/widget';
import { EMPTY_WEEK_HOURS, layoutWeek, nowOffset } from './weekLayout';

function event(id: string, startMin: number | null, endMin: number | null): CalendarEvent {
  return { id, title: id, startMin, endMin, location: null, tone: 'neutral' };
}

function day(date: string, events: CalendarEvent[]): CalendarDay {
  return { date, label: null, events };
}

const PX = 40;

test('every column shares one hour axis: working hours, stretched by what lies outside them', () => {
  const layout = layoutWeek(
    [day('2026-09-28', [event('early', 7 * 60 + 30, 9 * 60)]), day('2026-09-29', [event('late', 18 * 60, 19 * 60 + 15)])],
    PX,
  );
  expect([layout.startHour, layout.endHour]).toEqual([7, 20]);
  expect(layout.hours).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect(layout.height).toBe(13 * PX);
});

test('the tail of an event that ran past midnight does not drag the axis to 0:00', () => {
  const layout = layoutWeek([day('2026-09-29', [event('tail', 0, 60), event('a', 9 * 60, 10 * 60)])], PX);
  expect([layout.startHour, layout.endHour]).toEqual([8, 18]);
  // Off the axis entirely, so not drawn: it is the previous evening's block.
  expect(layout.columns[0].blocks.map((b) => b.event.id)).toEqual(['a']);
});

test('a block reaching past the axis is clipped to it', () => {
  const layout = layoutWeek([day('2026-09-29', [event('early', 5 * 60, 9 * 60)])], PX);
  expect(layout.columns[0].blocks[0]).toMatchObject({ top: 0, height: PX });
});

test('now sits on the axis at its minute, or nowhere when the axis does not reach it', () => {
  const layout = layoutWeek([day('2026-09-29', [])], PX);
  expect(nowOffset(layout, 9 * 60 + 30)).toBe(1.5 * PX);
  expect(nowOffset(layout, 23 * 60)).toBeNull();
});

test('a block sits at its time on that axis, whichever day it is on', () => {
  const layout = layoutWeek(
    [day('2026-09-28', [event('early', 8 * 60 + 30, 9 * 60)]), day('2026-09-29', [event('late', 16 * 60, 17 * 60)])],
    PX,
  );
  expect(layout.columns[0].blocks[0]).toMatchObject({ top: PX / 2, height: PX / 2 });
  expect(layout.columns[1].blocks[0]).toMatchObject({ top: 8 * PX, height: PX });
});

test('empty hours are kept: a gap in the grid is the free time', () => {
  const layout = layoutWeek([day('2026-09-28', [event('a', 9 * 60, 10 * 60), event('b', 15 * 60, 16 * 60)])], PX);
  // The axis starts at 8 AM, so 9:00 sits one hour down and 15:00 seven.
  expect(layout.columns[0].blocks.map((b) => b.top)).toEqual([PX, 7 * PX]);
});

test('a short event is still tall enough to tap', () => {
  const layout = layoutWeek([day('2026-09-28', [event('quick', 9 * 60, 9 * 60 + 5)])], PX, 18);
  expect(layout.columns[0].blocks[0].height).toBe((30 / 60) * PX);
  const tiny = layoutWeek([day('2026-09-28', [event('quick', 9 * 60, 9 * 60 + 5)])], 20, 18);
  expect(tiny.columns[0].blocks[0].height).toBe(18);
});

test('overlapping events share their column side by side', () => {
  const layout = layoutWeek([day('2026-09-28', [event('a', 9 * 60, 10 * 60), event('b', 9 * 60 + 30, 10 * 60 + 30)])], PX);
  expect(layout.columns[0].blocks.map((b) => [b.left, b.width])).toEqual([
    ['0%', '50%'],
    ['50%', '50%'],
  ]);
});

test('all-day events are kept apart from the grid', () => {
  const layout = layoutWeek([day('2026-09-28', [event('whole', null, null), event('a', 9 * 60, 10 * 60)])], PX);
  expect(layout.columns[0].allDay.map((e) => e.id)).toEqual(['whole']);
  expect(layout.columns[0].blocks.map((b) => b.event.id)).toEqual(['a']);
});

test('a week with nothing timed still draws working hours', () => {
  const layout = layoutWeek([day('2026-09-28', []), day('2026-09-29', [event('whole', null, null)])], PX);
  expect([layout.startHour, layout.endHour]).toEqual(EMPTY_WEEK_HOURS);
  expect(layout.columns.map((c) => c.date)).toEqual(['2026-09-28', '2026-09-29']);
});

test('an event running to midnight ends the axis at 24', () => {
  const layout = layoutWeek([day('2026-09-28', [event('night', 23 * 60, 1440)])], PX);
  expect([layout.startHour, layout.endHour]).toEqual([8, 24]);
});
