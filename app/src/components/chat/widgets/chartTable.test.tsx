// Skia has no native module under jest (TurboModuleRegistry.getEnforcing
// throws at import time), so the canvas is replaced by Views that record what
// each node was handed — FlowSankey.test.tsx's idiom. StackedBars itself is
// swapped for a prop recorder, the way cost.test.tsx does it: this file owns
// the MAPPING from a widget payload onto the chart's props, and charts.test.ts
// already owns the bar maths.
jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const { View } = require('react-native');
  const node =
    (name: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) =>
      React.createElement(View, { testID: name, ...props }, props.children);
  return {
    Canvas: node('sk-canvas'),
    Group: node('sk-group'),
    Line: node('sk-line'),
    Path: node('sk-path'),
    Rect: node('sk-rect'),
    RoundedRect: node('sk-rrect'),
    Circle: node('sk-circle'),
    Text: node('sk-text'),
    vec: (x: number, y: number) => ({ x, y }),
    useFont: () => ({
      measureText: (text: string) => ({ x: 0, y: 0, width: text.length * 6, height: 10 }),
    }),
  };
});

jest.mock('../../charts/StackedBars', () => {
  const React = require('react');
  const { View } = require('react-native');
  const actual = jest.requireActual('../../charts/StackedBars') as Record<string, unknown>;
  return {
    ...actual,
    StackedBars: (props: Record<string, unknown>) =>
      React.createElement(View, { testID: 'stacked-bars', ...props }),
  };
});

import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import type { ChartWidget as ChartWidgetT, TableWidget as TableWidgetT } from '../../../chat/widget';
import { ChartWidget, abbreviateKey, chartAriaTitle, compactNumber, formatValue } from './ChartWidget';
import { TableWidget, columnWidths } from './TableWidget';

const mounted: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => mounted.splice(0).forEach((r) => r.unmount()));
});

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  mounted.push(tree);
  return tree;
}

const flat = (v: unknown): string =>
  Array.isArray(v) ? v.map(flat).join('') : v == null || typeof v === 'boolean' ? '' : String(v);

const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType(Text).map((n) => flat(n.props.children));

const hosts = (r: TestRenderer.ReactTestRenderer, testID: string) =>
  r.root.findAll((n) => typeof n.type === 'string' && n.props.testID === testID);

function measure(instance: ReactTestInstance, width: number, height: number) {
  act(() => instance.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));
}

const chart = (over: Partial<ChartWidgetT> = {}): ChartWidgetT => ({
  kind: 'chart',
  variant: 'bars',
  title: 'Daily spend',
  caption: 'last three days',
  unit: '$',
  series: [
    { id: 'spend', label: 'Spend', color: 'series-1' },
    { id: 'credits', label: 'Credits', color: 'series-2' },
  ],
  buckets: [
    { key: '2026-09-20', values: { spend: 3, credits: 1 } },
    { key: '2026-09-21', values: { spend: 4 } },
    { key: '2026-09-22', values: { spend: 6, credits: 2 } },
  ],
  ...over,
});

const table: TableWidgetT = {
  kind: 'table',
  title: 'Recent charges',
  caption: 'three of 41',
  columns: [
    { key: 'date', label: 'Date', align: 'left' },
    { key: 'merchant', label: 'Merchant', align: 'left' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ],
  rows: [
    { date: 'Sep 20', merchant: 'Whole Foods', amount: '$84.12' },
    { date: 'Sep 21', merchant: 'OpenRouter', amount: '$14.20' },
    { date: 'Sep 22', merchant: 'Tailscale', amount: '$6.00' },
  ],
};

describe('ChartWidget — bars', () => {
  test('buckets and series land on StackedBars, totalled per bucket', () => {
    const bars = hosts(render(<ChartWidget widget={chart()} />), 'stacked-bars')[0];
    expect(bars.props.buckets).toEqual([
      { key: '2026-09-20', values: { spend: 3, credits: 1 }, total: 4 },
      { key: '2026-09-21', values: { spend: 4 }, total: 4 },
      { key: '2026-09-22', values: { spend: 6, credits: 2 }, total: 8 },
    ]);
    expect(bars.props.series).toEqual(chart().series);
  });

  test('the tick format abbreviates a long bucket key and the value format carries the unit', () => {
    const bars = hosts(render(<ChartWidget widget={chart()} />), 'stacked-bars')[0];
    expect(bars.props.tickFormat('2026-09-20', 0)).toBe('2026-0…');
    expect(bars.props.tickFormat('Mon', 0)).toBe('Mon');
    expect(bars.props.valueFormat(1500)).toBe('$1.5k');
  });

  test('the canvas is described by the title', () => {
    const bars = hosts(render(<ChartWidget widget={chart()} />), 'stacked-bars')[0];
    expect(bars.props.ariaTitle).toBe(
      'Daily spend, bar chart, 3 points from 2026-09-20 to 2026-09-22',
    );
  });

  test('title above, caption below, legend for every series', () => {
    const shown = texts(render(<ChartWidget widget={chart()} />));
    expect(shown).toContain('Daily spend');
    expect(shown).toContain('last three days');
    expect(shown).toContain('Spend');
    expect(shown).toContain('Credits');
    expect(shown.indexOf('Daily spend')).toBeLessThan(shown.indexOf('last three days'));
  });

  test('one series needs no legend', () => {
    const single = chart({
      series: [{ id: 'spend', label: 'Spend', color: 'series-1' }],
      caption: null,
    });
    expect(texts(render(<ChartWidget widget={single} />))).not.toContain('Spend');
  });
});

describe('ChartWidget — line', () => {
  const line = () => chart({ variant: 'line' });

  test('no bar chart is mounted', () => {
    expect(hosts(render(<ChartWidget widget={line()} />), 'stacked-bars')).toHaveLength(0);
  });

  test('once measured it strokes a path per series and labels the canvas', () => {
    const tree = render(<ChartWidget widget={line()} />);
    expect(hosts(tree, 'sk-canvas')).toHaveLength(0);

    measure(hosts(tree, 'line-chart')[0], 320, 140);

    expect(hosts(tree, 'sk-path')).toHaveLength(2);
    expect(hosts(tree, 'sk-canvas')[0].props.accessibilityLabel).toBe(
      'Daily spend, line chart, 3 points from 2026-09-20 to 2026-09-22',
    );
  });

  test('the axis row carries the first and last bucket, abbreviated', () => {
    const shown = texts(render(<ChartWidget widget={line()} />));
    expect(shown).toContain('2026-0…');
  });

  test('a single flat point still renders without dividing by zero', () => {
    const tree = render(
      <ChartWidget
        widget={chart({
          variant: 'line',
          series: [{ id: 'spend', label: 'Spend', color: 'series-1' }],
          buckets: [{ key: 'today', values: { spend: 0 } }],
        })}
      />,
    );
    measure(hosts(tree, 'line-chart')[0], 320, 140);
    expect(hosts(tree, 'sk-path')).toHaveLength(0);
    expect(hosts(tree, 'sk-circle').length).toBeGreaterThan(0);
  });
});

describe('ChartWidget formatting helpers', () => {
  test('abbreviateKey keeps short keys whole', () => {
    expect(abbreviateKey('Mon')).toBe('Mon');
    expect(abbreviateKey('Groceri')).toBe('Groceri');
    expect(abbreviateKey('Groceries')).toBe('Grocer…');
  });

  test('compactNumber thins the big numbers out', () => {
    expect(compactNumber(42)).toBe('42');
    expect(compactNumber(42.125)).toBe('42.13');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(-2_400_000)).toBe('-2.4M');
  });

  test('formatValue prefixes currency and suffixes everything else', () => {
    expect(formatValue(12, null)).toBe('12');
    expect(formatValue(12, '$')).toBe('$12');
    expect(formatValue(12, '%')).toBe('12%');
    expect(formatValue(12, 'ms')).toBe('12 ms');
  });

  test('an untitled chart is described by its series', () => {
    expect(chartAriaTitle(chart({ title: null }))).toBe(
      'Spend, Credits, bar chart, 3 points from 2026-09-20 to 2026-09-22',
    );
  });
});

describe('columnWidths', () => {
  const cols = table.columns;

  test('a table that fits stretches to fill, in proportion', () => {
    const widths = columnWidths(cols, table.rows, 1000);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 6);
    const natural = columnWidths(cols, table.rows, 0);
    expect(widths[1] / widths[0]).toBeCloseTo(natural[1] / natural[0], 6);
    expect(widths[1]).toBeGreaterThan(widths[0]);
  });

  test('a table wider than the card keeps its natural width, so it can scroll', () => {
    const widths = columnWidths(cols, table.rows, 120);
    expect(widths.reduce((a, b) => a + b, 0)).toBeGreaterThan(120);
  });

  test('a column is never narrower than a thumb or wider than the card', () => {
    const widths = columnWidths(
      [
        { key: 'x', label: 'x', align: 'left' },
        { key: 'y', label: 'y', align: 'left' },
      ],
      [{ x: '1', y: 'a very long cell that would otherwise run off the right edge entirely' }],
      0,
    );
    expect(widths[0]).toBe(56);
    expect(widths[1]).toBe(220);
  });
});

describe('TableWidget', () => {
  const style = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style) as TextStyle;

  test('every header and every cell is rendered', () => {
    const shown = texts(render(<TableWidget widget={table} />));
    for (const column of table.columns) expect(shown).toContain(column.label);
    for (const row of table.rows) {
      for (const column of table.columns) expect(shown).toContain(row[column.key]);
    }
    expect(shown).toContain('Recent charges');
    expect(shown).toContain('three of 41');
  });

  test('each column aligns the way it asked to, header included', () => {
    const tree = render(<TableWidget widget={table} />);
    const cell = (value: string) =>
      tree.root.findAllByType(Text).filter((n) => flat(n.props.children) === value)[0];
    expect(style(cell('$14.20')).textAlign).toBe('right');
    expect(style(cell('Amount')).textAlign).toBe('right');
    expect(style(cell('OpenRouter')).textAlign).toBe('left');
    expect(style(cell('Date')).textAlign).toBe('left');
  });

  test('cells in one column share a width', () => {
    const tree = render(<TableWidget widget={table} />);
    const cell = (value: string) =>
      tree.root.findAllByType(Text).filter((n) => flat(n.props.children) === value)[0];
    expect(style(cell('Sep 20')).width).toBe(style(cell('Sep 22')).width);
    expect(style(cell('Sep 20')).width).not.toBe(style(cell('Whole Foods')).width);
  });

  test('the table scrolls inside its own frame rather than the transcript', () => {
    const tree = render(<TableWidget widget={table} />);
    const scrollers = tree.root.findAll(
      (n) => typeof n.type === 'function' && n.props.horizontal === true,
    );
    expect(scrollers.length).toBeGreaterThan(0);
    measure(hosts(tree, 'table-frame')[0], 300, 120);
    expect(hosts(tree, 'table-frame')).toHaveLength(1);
  });
});


test('a long cell wraps instead of showing its first few words', () => {
  // the user, 2026-09-22: "make text wrap for longer sentences in the table widget".
  const widget: TableWidgetT = {
    kind: 'table',
    title: null,
    caption: null,
    columns: [{ key: 'note', label: 'Note', align: 'left' }],
    rows: [{ note: 'The 3pm sync overlaps sprint estimation, so one of them has to move.' }],
  };
  const cell = render(<TableWidget widget={widget} />)
    .root.findAllByType(Text)
    .find((n) => String(n.props.children).startsWith('The 3pm'));
  expect(cell).toBeDefined();
  expect(cell!.props.numberOfLines).toBeUndefined();
});
