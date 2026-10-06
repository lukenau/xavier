// Render coverage for the three interactive widgets. The layout maths they
// lean on is unit-tested in chat/calendarLayout.test.ts; what is proved here
// is what the transcript actually shows — a poll that flips from choices to
// results, four visually distinct checklist states, and a calendar that spans
// the right hours and names the right day.
import type { ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import { PollWidget } from './PollWidget';
import { ChecklistWidget } from './ChecklistWidget';
import { CalendarWidget } from './CalendarWidget';
import { parseWidget } from '../../../chat/widget';
import { formatHour, formatMinute } from '../../../chat/calendarLayout';
import type {
  CalendarEvent,
  CalendarWidget as CalendarWidgetT,
  ChecklistItem,
  ChecklistState,
  PollWidget as PollWidgetT,
} from '../../../chat/widget';

function render(node: ReactElement) {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(node);
  });
  return r;
}

function byTestId(r: TestRenderer.ReactTestRenderer, id: string) {
  return r.root.findAll((n) => n.props.testID === id);
}

function styleOf(r: TestRenderer.ReactTestRenderer, id: string) {
  const node = byTestId(r, id).at(-1);
  if (!node) throw new Error(`no node with testID ${id}`);
  return StyleSheet.flatten(node.props.style);
}

function textOf(r: TestRenderer.ReactTestRenderer, id: string): string {
  const node = byTestId(r, id).at(-1);
  if (!node) throw new Error(`no node with testID ${id}`);
  return flatten(node.props.children);
}

function flatten(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flatten).join('');
  return '';
}

function allText(r: TestRenderer.ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((n) => flatten(n.props.children))
    .join(' | ');
}

// --- poll -------------------------------------------------------------------

function poll(over: Partial<PollWidgetT> = {}): PollWidgetT {
  return {
    kind: 'poll',
    question: 'Ship the chat surface today?',
    options: [
      { id: 'yes', label: 'Ship it', votes: 3 },
      { id: 'no', label: 'Wait for the Mac', votes: 1 },
    ],
    selectedId: null,
    closed: false,
    ...over,
  };
}

test('an unvoted open poll shows tappable choices and no results', () => {
  const onVote = jest.fn();
  const r = render(<PollWidget widget={poll()} onVote={onVote} />);

  expect(byTestId(r, 'poll-option-yes')).not.toHaveLength(0);
  expect(byTestId(r, 'poll-result-yes')).toHaveLength(0);
  expect(allText(r)).not.toContain('75%');

  act(() => byTestId(r, 'poll-option-yes')[0].props.onPress());
  expect(onVote).toHaveBeenCalledWith('yes');
});

test('once voted the choices become bars proportional to their share', () => {
  const r = render(<PollWidget widget={poll({ selectedId: 'yes' })} />);

  expect(byTestId(r, 'poll-option-yes')).toHaveLength(0);
  expect(styleOf(r, 'poll-bar-yes').flex).toBe(0.75);
  expect(styleOf(r, 'poll-bar-no').flex).toBe(0.25);
  expect(allText(r)).toContain('75% · 3');
  expect(allText(r)).toContain('25% · 1');
  expect(textOf(r, 'poll-footer')).toBe('4 votes');
});

test('the chosen option is marked', () => {
  const r = render(<PollWidget widget={poll({ selectedId: 'no' })} />);
  expect(allText(r)).toContain('✓ Wait for the Mac');
  expect(allText(r)).not.toContain('✓ Ship it');
});

test('a zero-total poll renders empty bars, not NaN', () => {
  const r = render(
    <PollWidget
      widget={poll({
        selectedId: 'yes',
        options: [
          { id: 'yes', label: 'Ship it', votes: 0 },
          { id: 'no', label: 'Wait for the Mac', votes: 0 },
        ],
      })}
    />,
  );

  expect(styleOf(r, 'poll-bar-yes').flex).toBe(0);
  expect(styleOf(r, 'poll-bar-no').flex).toBe(0);
  expect(textOf(r, 'poll-footer')).toBe('0 votes');
  expect(allText(r)).not.toContain('NaN');
});

test('a closed poll shows results without a vote ever being cast, and says it is closed', () => {
  const r = render(<PollWidget widget={poll({ closed: true })} />);
  expect(byTestId(r, 'poll-option-yes')).toHaveLength(0);
  expect(byTestId(r, 'poll-result-yes')).not.toHaveLength(0);
  expect(textOf(r, 'poll-footer')).toBe('4 votes · closed');
});

// --- checklist --------------------------------------------------------------

const STATES: ChecklistState[] = ['todo', 'doing', 'done', 'blocked'];

function item(state: ChecklistState, note: string | null = null): ChecklistItem {
  return { id: state, label: `${state} item`, state, note };
}

test('every checklist state gets its own marker', () => {
  const r = render(
    <ChecklistWidget widget={{ kind: 'checklist', title: 'Plan', items: STATES.map((s) => item(s)) }} />,
  );

  const markers = STATES.map((s) => textOf(r, `checklist-marker-${s}`));
  expect(new Set(markers).size).toBe(4);
  expect(textOf(r, 'checklist-marker-done')).toBe('✓');
  expect(allText(r)).toContain('Plan');
});

test('doing and blocked are set off from the quiet states', () => {
  const r = render(
    <ChecklistWidget widget={{ kind: 'checklist', title: null, items: STATES.map((s) => item(s)) }} />,
  );

  expect(styleOf(r, 'checklist-item-doing').backgroundColor).toBeTruthy();
  expect(styleOf(r, 'checklist-item-blocked').backgroundColor).toBeTruthy();
  expect(styleOf(r, 'checklist-item-todo').backgroundColor).toBeUndefined();
  expect(styleOf(r, 'checklist-item-done').backgroundColor).toBeUndefined();

  const colors = STATES.map((s) => styleOf(r, `checklist-marker-${s}`).color);
  expect(new Set(colors).size).toBe(4);
});

test('a note renders beneath its item', () => {
  const r = render(
    <ChecklistWidget
      widget={{ kind: 'checklist', title: null, items: [item('blocked', 'waiting on the Mac to wake')] }}
    />,
  );
  expect(allText(r)).toContain('waiting on the Mac to wake');
});

test('the progress line counts only the done items', () => {
  const items: ChecklistItem[] = [
    item('done'),
    { ...item('done'), id: 'd2' },
    { ...item('done'), id: 'd3' },
    { ...item('todo'), id: 't1' },
    { ...item('todo'), id: 't2' },
    { ...item('todo'), id: 't3' },
    { ...item('doing'), id: 'p1' },
  ];
  const r = render(<ChecklistWidget widget={{ kind: 'checklist', title: null, items }} />);
  expect(textOf(r, 'checklist-progress')).toBe('3 of 7 done');
});

test('blocked items are called out alongside the progress count', () => {
  const r = render(
    <ChecklistWidget widget={{ kind: 'checklist', title: null, items: STATES.map((s) => item(s)) }} />,
  );
  expect(textOf(r, 'checklist-progress')).toBe('1 of 4 done · 1 blocked');
});

// --- calendar ---------------------------------------------------------------

function event(id: string, startMin: number | null, endMin: number | null = null): CalendarEvent {
  return { id, title: `${id} meeting`, startMin, endMin, location: null, tone: 'neutral' };
}

test('the day view stacks events in time order and only draws the hours in use', () => {
  const widget: CalendarWidgetT = {
    kind: 'calendar',
    view: 'day',
    title: 'Monday',
    days: [
      {
        date: '2026-09-21',
        label: null,
        events: [event('standup', 9 * 60, 9 * 60 + 15), event('review', 14 * 60, 15 * 60)],
      },
    ],
  };
  const r = render(<CalendarWidget widget={widget} />);

  const standup = styleOf(r, 'cal-event-standup');
  const review = styleOf(r, 'cal-event-review');
  expect(standup.top).toBe(0);
  expect(Number(review.top)).toBeGreaterThan(Number(standup.top));
  expect(Number(review.height)).toBeGreaterThan(Number(standup.height));

  const text = allText(r);
  expect(text).toContain(formatHour(9));
  expect(text).toContain(formatHour(14));
  expect(text).not.toContain(formatHour(0));
});

test('every event shows its time, however short, and dead hours collapse', () => {
  // the user's 2026-09-22 schedule: two 30-minute meetings drew no time at all
  // (the meta line only appeared above 34px) and the empty noon hour cost a
  // full band.
  const widget: CalendarWidgetT = {
    kind: 'calendar',
    view: 'day',
    title: null,
    days: [
      {
        date: '2026-09-22',
        label: null,
        events: [
          event('standup', 10 * 60, 10 * 60 + 30),
          event('mixer', 13 * 60, 14 * 60),
        ],
      },
    ],
  };
  const r = render(<CalendarWidget widget={widget} />);
  const text = allText(r);

  expect(text).toContain(`${formatMinute(10 * 60)} – ${formatMinute(10 * 60 + 30)}`);
  expect(text).toContain(`${formatMinute(13 * 60)} – ${formatMinute(14 * 60)}`);
  // 11 and 12 hold nothing: one "2h free" row instead of two empty bands.
  expect(text).toContain('2h free');
  expect(text).not.toContain(formatHour(11));
  expect(Number(styleOf(r, 'cal-event-mixer').top)).toBeLessThan(3 * 46);
});

test('an all-day event sits in its own strip, not in the grid', () => {
  const widget: CalendarWidgetT = {
    kind: 'calendar',
    view: 'day',
    title: null,
    days: [{ date: '2026-09-21', label: null, events: [event('offsite', null), event('standup', 9 * 60)] }],
  };
  const r = render(<CalendarWidget widget={widget} />);

  expect(styleOf(r, 'cal-event-offsite').position).toBeUndefined();
  expect(styleOf(r, 'cal-event-standup').position).toBe('absolute');
  expect(allText(r)).toContain('All day');
});

test('a day with nothing on it says so', () => {
  const widget: CalendarWidgetT = {
    kind: 'calendar',
    view: 'day',
    title: null,
    days: [{ date: '2026-09-21', label: null, events: [] }],
  };
  expect(allText(render(<CalendarWidget widget={widget} />))).toContain('Nothing scheduled');
});

test('the week view renders every day, including the empty one', () => {
  const dates = [
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-09-24',
    '2026-09-25',
    '2026-09-26',
    '2026-09-27',
  ];
  const widget: CalendarWidgetT = {
    kind: 'calendar',
    view: 'week',
    title: 'This week',
    days: dates.map((date, i) => ({
      date,
      label: null,
      events: i === 3 ? [] : [event(`e${i}`, 10 * 60, 11 * 60)],
    })),
  };
  const r = render(<CalendarWidget widget={widget} />);

  for (const date of dates) expect(byTestId(r, `cal-day-${date}`)).not.toHaveLength(0);
  expect(allText(r).match(/Nothing scheduled/g)).toHaveLength(1);
  expect(allText(r)).toContain(formatMinute(10 * 60));
});

test('an ISO date renders as its own day, not the one before it', () => {
  const widget: CalendarWidgetT = {
    kind: 'calendar',
    view: 'week',
    title: null,
    days: [{ date: '2026-09-22', label: null, events: [] }],
  };
  const r = render(<CalendarWidget widget={widget} />);

  const text = allText(r);
  expect(text).toContain('22');
  expect(text).not.toContain('21');
  expect(text).toContain(new Date(2026, 8, 22).toLocaleDateString([], { weekday: 'short' }));
});

test('a month renders as a grid of weeks, marked by how busy each day is', () => {
  // the user, 2026-09-22: "add a week and month view to calendar widgets so it can
  // visualize over longer periods more easily".
  const days = ['2026-09-01', '2026-09-02', '2026-09-15', '2026-09-30'].map((date, i) => ({
    date,
    label: null,
    events: Array.from({ length: i }, (_, n) => event(`${date}-${n}`, 9 * 60, 10 * 60)),
  }));
  const widget: CalendarWidgetT = { kind: 'calendar', view: 'month', title: 'September', days };
  const r = render(<CalendarWidget widget={widget} />);

  // Every day in the range has a cell, padding days have none.
  const cells = r.root.findAll(
    (n) => typeof n.type === 'string' && typeof n.props.testID === 'string' && n.props.testID.startsWith('cal-month-'),
  );
  expect(cells).toHaveLength(30);
  const text = allText(r);
  expect(text).toContain('September');
  expect(text).toContain('30');
  // No per-event prose at this range — the day view is where titles live.
  expect(text).not.toContain('meeting');
});

test('a long stretch of days is a month even when nobody said so', () => {
  const days = Array.from({ length: 21 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    label: null,
    events: [],
  }));
  const parsed = parseWidget({ kind: 'calendar', props: { days } });
  expect(parsed && parsed.kind === 'calendar' && parsed.view).toBe('month');
});
