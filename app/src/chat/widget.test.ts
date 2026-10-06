import { asColor, asHttpsUrl, asMinuteOfDay, asTone, normaliseKind, parseWidget } from './widget';

describe('normaliseKind', () => {
  it('accepts the catalog names in any casing a model reaches for', () => {
    expect(normaliseKind('ButtonRow')).toBe('button_row');
    expect(normaliseKind('button-row')).toBe('button_row');
    expect(normaliseKind('BUTTON_ROW')).toBe('button_row');
    expect(normaliseKind('  Card ')).toBe('card');
  });
  it('maps the synonyms a model writes instead of the catalog name', () => {
    expect(normaliseKind('todos')).toBe('checklist');
    expect(normaliseKind('plan')).toBe('checklist');
    expect(normaliseKind('agenda')).toBe('calendar');
    expect(normaliseKind('bar_chart')).toBe('chart');
  });
  it('refuses a kind it cannot draw', () => {
    expect(normaliseKind('teapot')).toBeNull();
    expect(normaliseKind('')).toBeNull();
    expect(normaliseKind(undefined)).toBeNull();
  });
});

describe('asColor — the only gate between an agent and an unthemed hex', () => {
  it('passes a real token name', () => {
    expect(asColor('series-1')).toBe('series-1');
    expect(asColor('status-up')).toBe('status-up');
  });
  it('rejects anything that is not one', () => {
    expect(asColor('#ff00ff')).toBeNull(); // theme-exempt: the counter-example asColor must reject
    expect(asColor('rgb(1,2,3)')).toBeNull(); // theme-exempt: same
    expect(asColor('hotpink')).toBeNull();
    expect(asColor(42)).toBeNull();
  });
});

describe('asHttpsUrl', () => {
  it('passes https', () => {
    expect(asHttpsUrl('https://example.com/x')).toBe('https://example.com/x');
  });
  it('rejects every other scheme', () => {
    expect(asHttpsUrl('http://example.com')).toBeNull();
    expect(asHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(asHttpsUrl('file:///etc/passwd')).toBeNull();
    expect(asHttpsUrl('/relative')).toBeNull();
  });
});

describe('asTone', () => {
  it('passes the union through', () => {
    expect(asTone('up')).toBe('up');
    expect(asTone('warn')).toBe('warn');
  });
  it('maps the words that mean the same thing', () => {
    expect(asTone('success')).toBe('up');
    expect(asTone('danger')).toBe('down');
    expect(asTone('warning')).toBe('warn');
  });
  it('falls back to neutral rather than failing the widget', () => {
    expect(asTone('chartreuse')).toBe('neutral');
    expect(asTone(undefined)).toBe('neutral');
  });
});

describe('asMinuteOfDay', () => {
  it('reads a clock time', () => {
    expect(asMinuteOfDay('14:30')).toBe(870);
    expect(asMinuteOfDay('09:05')).toBe(545);
  });
  it('reads the time out of an ISO timestamp', () => {
    expect(asMinuteOfDay('2026-09-22T14:30:00Z')).toBe(870);
  });
  it('takes a raw minute count', () => {
    expect(asMinuteOfDay(870)).toBe(870);
  });
  it('rejects nonsense rather than placing an event at a made-up hour', () => {
    expect(asMinuteOfDay('99:99')).toBeNull();
    expect(asMinuteOfDay('soon')).toBeNull();
    expect(asMinuteOfDay(null)).toBeNull();
  });
});

describe('parseWidget — envelope', () => {
  it('reads the documented props envelope', () => {
    const w = parseWidget({ kind: 'metric', props: { label: 'Spend', value: 14.2 } });
    expect(w).toEqual({
      kind: 'metric',
      label: 'Spend',
      value: '14.2',
      unit: null,
      delta: null,
      deltaTone: 'neutral',
      caption: null,
    });
  });
  it('accepts the flattened shape a model writes when it forgets props', () => {
    const w = parseWidget({ kind: 'metric', label: 'Spend', value: '14.20' });
    expect(w?.kind).toBe('metric');
  });
  it('returns null — never throws — on a payload it cannot draw', () => {
    expect(parseWidget({ kind: 'card' })).toBeNull();
    expect(parseWidget({ kind: 'teapot', props: {} })).toBeNull();
    expect(parseWidget({})).toBeNull();
  });
});

describe('card', () => {
  it('keeps rows with a label and drops the rest', () => {
    const w = parseWidget({
      kind: 'card',
      props: { title: 'Budget', rows: [{ label: 'Spent', value: '$14', tone: 'up' }, { value: 'orphan' }, 'nope'] },
    });
    expect(w).toMatchObject({ kind: 'card', title: 'Budget', rows: [{ label: 'Spent', value: '$14', tone: 'up' }] });
  });
  it('needs at least a title, a body or a row', () => {
    expect(parseWidget({ kind: 'card', props: { subtitle: 'only' } })).toBeNull();
  });
});

describe('chart', () => {
  const series = [{ id: 'a', label: 'A', color: 'series-1' }];

  it('reads the full bucket shape', () => {
    const w = parseWidget({ kind: 'chart', props: { series, buckets: [{ key: 'Mon', values: { a: 3 } }] } });
    expect(w).toMatchObject({ kind: 'chart', variant: 'bars', buckets: [{ key: 'Mon', values: { a: 3 } }] });
  });
  it('accepts the single-series shorthand', () => {
    const w = parseWidget({ kind: 'chart', props: { series, buckets: [{ key: 'Mon', value: 3 }] } });
    expect(w).toMatchObject({ buckets: [{ key: 'Mon', values: { a: 3 } }] });
  });
  it('substitutes the series ramp for an unthemed colour instead of dropping the chart', () => {
    const w = parseWidget({
      kind: 'chart',
      // theme-exempt: the literal is the rejected input, never a rendered colour.
      props: { series: [{ id: 'a', label: 'A', color: '#ff00ff' }], buckets: [{ key: 'Mon', value: 1 }] },
    });
    expect(w).toMatchObject({ series: [{ id: 'a', label: 'A', color: 'series-1' }] });
  });
  it('honours an explicit line variant', () => {
    const w = parseWidget({ kind: 'chart', props: { variant: 'line', series, buckets: [{ key: 'Mon', value: 1 }] } });
    expect(w).toMatchObject({ variant: 'line' });
  });
  it('refuses a chart with no series or no buckets', () => {
    expect(parseWidget({ kind: 'chart', props: { series: [], buckets: [{ key: 'Mon', value: 1 }] } })).toBeNull();
    expect(parseWidget({ kind: 'chart', props: { series, buckets: [] } })).toBeNull();
  });
});

describe('table', () => {
  it('reads the object-column shape', () => {
    const w = parseWidget({
      kind: 'table',
      props: { columns: [{ key: 'd', label: 'Day' }, { key: 'n', label: 'N', align: 'right' }], rows: [{ d: 'Mon', n: 4 }] },
    });
    expect(w).toMatchObject({
      columns: [{ key: 'd', label: 'Day', align: 'left' }, { key: 'n', label: 'N', align: 'right' }],
      rows: [{ d: 'Mon', n: '4' }],
    });
  });
  it('accepts string columns and positional rows', () => {
    const w = parseWidget({ kind: 'table', props: { columns: ['Day', 'N'], rows: [['Mon', 4]] } });
    expect(w).toMatchObject({ columns: [{ key: 'Day' }, { key: 'N' }], rows: [{ Day: 'Mon', N: '4' }] });
  });
  it('drops an entirely empty row', () => {
    const w = parseWidget({ kind: 'table', props: { columns: ['A'], rows: [{ A: 'x' }, { B: 'y' }] } });
    expect(w).toMatchObject({ rows: [{ A: 'x' }] });
  });
});

describe('progress', () => {
  it('clamps a value past its total', () => {
    expect(parseWidget({ kind: 'progress', props: { value: 12, total: 10 } })).toMatchObject({ value: 10, total: 10 });
  });
  it('defaults the total to 100', () => {
    expect(parseWidget({ kind: 'progress', props: { value: 40 } })).toMatchObject({ total: 100 });
  });
  it('refuses a zero total rather than dividing by it downstream', () => {
    expect(parseWidget({ kind: 'progress', props: { value: 1, total: 0 } })).toBeNull();
  });
});

describe('poll', () => {
  it('needs a question and two options', () => {
    expect(parseWidget({ kind: 'poll', props: { question: 'Which?', options: ['a'] } })).toBeNull();
    expect(parseWidget({ kind: 'poll', props: { options: ['a', 'b'] } })).toBeNull();
  });
  it('reads string options and gives them ids', () => {
    expect(parseWidget({ kind: 'poll', props: { question: 'Which?', options: ['a', 'b'] } })).toMatchObject({
      options: [{ id: 'o0', label: 'a', votes: 0 }, { id: 'o1', label: 'b', votes: 0 }],
    });
  });
  it('ignores a selected_id that names no option', () => {
    const w = parseWidget({ kind: 'poll', props: { question: 'Q', options: ['a', 'b'], selected_id: 'ghost' } });
    expect(w).toMatchObject({ selectedId: null });
  });
});

describe('checklist', () => {
  it('maps the state synonyms', () => {
    const w = parseWidget({
      kind: 'checklist',
      props: { items: [{ label: 'a', state: 'in_progress' }, { label: 'b', state: 'completed' }, { label: 'c', state: 'failed' }] },
    });
    expect(w).toMatchObject({ items: [{ state: 'doing' }, { state: 'done' }, { state: 'blocked' }] });
  });
  it('reads {done: true} when state is absent', () => {
    const w = parseWidget({ kind: 'checklist', props: { items: [{ label: 'a', done: true }, { label: 'b' }] } });
    expect(w).toMatchObject({ items: [{ state: 'done' }, { state: 'todo' }] });
  });
  it('accepts a plain list of strings', () => {
    expect(parseWidget({ kind: 'plan', props: { items: ['one', 'two'] } })).toMatchObject({
      kind: 'checklist',
      items: [{ label: 'one', state: 'todo' }, { label: 'two', state: 'todo' }],
    });
  });
});

describe('timeline', () => {
  it('reads time, label, detail and tone, keeping the order it was written in', () => {
    const w = parseWidget({
      kind: 'timeline',
      props: {
        title: 'Order 114-77',
        items: [
          { time: 'Mon 9:04 AM', label: 'Placed', detail: 'Card ··0000' },
          { time: 'Tue 3:12 PM', label: 'Shipped', tone: 'up' },
        ],
      },
    });
    expect(w).toMatchObject({
      kind: 'timeline',
      title: 'Order 114-77',
      items: [
        { time: 'Mon 9:04 AM', label: 'Placed', detail: 'Card ··0000', tone: 'neutral' },
        { time: 'Tue 3:12 PM', label: 'Shipped', detail: null, tone: 'up' },
      ],
    });
  });
  it('accepts a plain list of strings as the log', () => {
    expect(parseWidget({ kind: 'log', props: { items: ['Placed', 'Shipped'] } })).toMatchObject({
      kind: 'timeline',
      items: [{ label: 'Placed', time: null }, { label: 'Shipped', time: null }],
    });
  });
  it('drops an entry with nothing to say and refuses the widget once none are left', () => {
    expect(parseWidget({ kind: 'timeline', props: { items: [{ time: 'Mon' }] } })).toBeNull();
    const w = parseWidget({ kind: 'timeline', props: { items: [{ time: 'Mon' }, { label: 'Shipped' }] } });
    expect(w).toMatchObject({ items: [{ label: 'Shipped' }] });
  });
});

describe('calendar', () => {
  const day = { date: '2026-09-22', events: [{ title: 'Standup', start: '09:30', end: '09:45' }] };

  it('sorts a day’s events by start time', () => {
    const w = parseWidget({
      kind: 'calendar',
      props: { view: 'day', days: [{ date: '2026-09-22', events: [{ title: 'Late', start: '16:00' }, { title: 'Early', start: '08:00' }] }] },
    });
    expect((w as { days: { events: { title: string }[] }[] }).days[0].events.map((e) => e.title)).toEqual(['Early', 'Late']);
  });
  it('keeps an all-day event with a null start', () => {
    const w = parseWidget({ kind: 'calendar', props: { days: [{ date: '2026-09-22', events: [{ title: 'PTO' }] }] } });
    expect(w).toMatchObject({ days: [{ events: [{ title: 'PTO', startMin: null }] }] });
  });
  it('is a day view when there is one day and a week view when there are several', () => {
    expect(parseWidget({ kind: 'calendar', props: { days: [day] } })).toMatchObject({ view: 'day' });
    expect(parseWidget({ kind: 'calendar', props: { days: [day, { date: '2026-09-23', events: [] }] } })).toMatchObject({
      view: 'week',
    });
  });
  it('drops a day whose date is not an ISO calendar date', () => {
    expect(parseWidget({ kind: 'calendar', props: { days: [{ date: 'tomorrow', events: [] }] } })).toBeNull();
  });
});

describe('form', () => {
  it('normalises field types and defaults the submit label', () => {
    const w = parseWidget({
      kind: 'form',
      props: { fields: [{ id: 'a', label: 'A', type: 'multiline' }, { label: 'B', type: 'number' }, { label: 'C' }] },
    });
    expect(w).toMatchObject({
      submitLabel: 'Submit',
      fields: [{ type: 'textarea' }, { type: 'number', id: 'f1' }, { type: 'text' }],
    });
  });
  it('refuses a form with no fields', () => {
    expect(parseWidget({ kind: 'form', props: { title: 'Empty' } })).toBeNull();
  });
});

describe('link and button_row', () => {
  it('drops a link that is not https', () => {
    expect(parseWidget({ kind: 'link', props: { url: 'http://x.test' } })).toBeNull();
  });
  it('titles a link with its url when nothing else is given', () => {
    expect(parseWidget({ kind: 'link', props: { url: 'https://x.test' } })).toMatchObject({ title: 'https://x.test' });
  });
  it('reads buttons as objects or strings', () => {
    expect(parseWidget({ kind: 'button_row', props: { buttons: [{ id: 'go', label: 'Go' }, 'Stop'] } })).toMatchObject({
      buttons: [{ id: 'go', label: 'Go' }, { id: 'b1', label: 'Stop' }],
    });
  });
});

describe('clarify — the one way the agent asks a question', () => {
  const flat = { type: 'widget', kind: 'clarify', widget_id: 'clr_1', question: 'Which env?', choices: ['staging', 'prod'] };

  it('reads the flat shape the plugin actually sends', () => {
    expect(parseWidget(flat)).toEqual({
      kind: 'clarify',
      clarifyId: 'clr_1',
      question: 'Which env?',
      choices: ['staging', 'prod'],
      multiSelect: false,
    });
  });

  it('carries multi_select through', () => {
    expect(parseWidget({ ...flat, multi_select: true })).toMatchObject({ multiSelect: true });
  });

  it('is not multi-select with nothing to select from', () => {
    expect(parseWidget({ type: 'widget', kind: 'clarify', widget_id: 'c', question: 'Why?', multi_select: true }))
      .toMatchObject({ choices: [], multiSelect: false });
  });

  it('is a free-text question when it carries no choices', () => {
    expect(parseWidget({ type: 'widget', kind: 'clarify', widget_id: 'c', question: 'Why?' }))
      .toMatchObject({ kind: 'clarify', choices: [] });
  });


  it('parses the exact part the plugin builds', () => {
    // Copied verbatim from `hub_wire.clarify_message(...)` run against the live
    // plugin source. This is the contract between the gateway and this parser;
    // the other cases above test the parser, this one pins the wire.
    const fromPlugin = {
      type: 'widget',
      kind: 'clarify',
      widget_id: 'clr_x',
      question: 'Which env?',
      choices: ['staging', 'prod'],
      multi_select: true,
    };
    expect(parseWidget(fromPlugin)).toEqual({
      kind: 'clarify',
      clarifyId: 'clr_x',
      question: 'Which env?',
      choices: ['staging', 'prod'],
      multiSelect: true,
    });
  });

  it('refuses a clarify with no id to answer against', () => {
    expect(parseWidget({ type: 'widget', kind: 'clarify', question: 'Which?' })).toBeNull();
  });
});
