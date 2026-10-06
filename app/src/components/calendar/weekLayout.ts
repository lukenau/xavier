// The grid's geometry, for the week and for the full-screen day. Empty hours
// are kept: in a grid the gap IS the free time, and it has to line up across
// columns. Lanes still come from the chat widget's layoutDay, so overlap is
// decided in one place.
import type { CalendarDay, CalendarEvent } from '../../chat/widget';
import { layoutDay } from '../../chat/calendarLayout';

export const WEEK_PX_PER_HOUR = 40;
export const WEEK_MIN_BLOCK_PX = 18;
/** Always drawn, whatever the week holds; events outside stretch the axis. */
export const WORKING_HOURS: [number, number] = [8, 18];
export const EMPTY_WEEK_HOURS = WORKING_HOURS;
/** An event that starts before this is the tail of one that ran past
 *  midnight; it is clipped to the axis rather than dragging it to 0:00. */
const EARLIEST_AXIS_HOUR = 6;

export interface WeekBlock {
  event: CalendarEvent;
  top: number;
  height: number;
  left: `${number}%`;
  width: `${number}%`;
}

export interface WeekColumn {
  date: string;
  allDay: CalendarEvent[];
  blocks: WeekBlock[];
}

export interface WeekLayout {
  startHour: number;
  endHour: number;
  hours: number[];
  height: number;
  pxPerHour: number;
  columns: WeekColumn[];
}

export function layoutWeek(
  days: CalendarDay[],
  pxPerHour = WEEK_PX_PER_HOUR,
  minBlockPx = WEEK_MIN_BLOCK_PX,
): WeekLayout {
  const laid = days.map((day) => ({ date: day.date, layout: layoutDay(day.events) }));
  const spans = laid.flatMap(({ layout }) => layout.blocks);
  const starts = spans.map((b) => b.startMin).filter((m) => m >= EARLIEST_AXIS_HOUR * 60);
  const startHour = Math.min(WORKING_HOURS[0], ...starts.map((m) => Math.floor(m / 60)));
  const endHour = Math.max(WORKING_HOURS[1], ...spans.map((b) => Math.ceil(b.endMin / 60)));
  const height = (endHour - startHour) * pxPerHour;

  return {
    startHour,
    endHour,
    hours: Array.from({ length: endHour - startHour }, (_, i) => startHour + i),
    height,
    pxPerHour,
    columns: laid.map(({ date, layout }) => ({
      date,
      allDay: layout.allDay,
      blocks: layout.blocks.flatMap((b) => {
        const top = Math.max(0, ((b.startMin - startHour * 60) / 60) * pxPerHour);
        const bottom = Math.min(height, ((b.endMin - startHour * 60) / 60) * pxPerHour);
        if (bottom <= 0) return [];
        return [{ event: b.event, top, height: Math.max(minBlockPx, bottom - top), left: b.left, width: b.width }];
      }),
    })),
  };
}

/** Where "now" falls on the axis, or null when it is off it. */
export function nowOffset(layout: WeekLayout, nowMin: number): number | null {
  const top = ((nowMin - layout.startHour * 60) / 60) * layout.pxPerHour;
  return top >= 0 && top <= layout.height ? top : null;
}
