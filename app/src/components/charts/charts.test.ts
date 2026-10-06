// Every expected value here was computed from the PWA's own arithmetic
// (apps/hub/src/components/charts/StackedBars.tsx), transcribed into a scratch
// script and run once — not read back out of the implementation under test.
import type { BarSeries } from '../../shared/chartTypes';
import { dark } from '../../theme/tokens.gen';
import {
  axisTicks,
  barX,
  barY,
  barsLayout,
  bucketLabel,
  bucketSegments,
  fmtGrid,
  niceCeil,
  niceTicks,
  niceValue,
  roundedTopRect,
  seriesPaint,
  toggleSelection,
  type StackedBarBucket,
} from './geometry';

const t = ((name: string) => `resolved:${name}`) as unknown as (name: keyof typeof dark) => string;

const SERIES: BarSeries[] = [
  { id: 'x', label: 'x', color: 'series-1' },
  { id: 'y', label: 'y', color: 'series-2' },
];

const BUCKETS: StackedBarBucket[] = [
  { key: 'a', total: 6, values: { x: 4, y: 2 } },
  { key: 'b', total: 0, values: {} },
  { key: 'c', total: 10, values: { x: 10 }, partial: true },
];

describe('niceValue — the gridline ceiling', () => {
  test.each([
    [137, 100],
    [520, 500],
    [0.4, 0.25],
    [12.5, 10],
    [1000, 1000],
    [3, 2.5],
  ])('niceValue(%p) = %p', (input, expected) => {
    expect(niceValue(input)).toBe(expected);
  });

  test('a non-positive maximum has no ceiling at all', () => {
    expect(niceValue(0)).toBe(0);
    expect(niceValue(-4)).toBe(0);
  });
});

describe('fmtGrid — dollars on the gridline', () => {
  test.each([
    [137.4, '$137'],
    [100, '$100'],
    [12, '$12'],
    [12.5, '$12.50'],
    [0.25, '$0.25'],
    [0.4, '$0.40'],
  ])('fmtGrid(%p) = %p', (input, expected) => {
    expect(fmtGrid(input)).toBe(expected);
  });
});

describe('roundedTopRect — rounded data-end, square baseline', () => {
  test('emits the PWA path string verbatim', () => {
    expect(roundedTopRect(10, 20, 24, 50, 3)).toBe(
      'M10,70 L10,23 Q10,20 13,20 L31,20 Q34,20 34,23 L34,70 Z',
    );
  });

  test('the radius shrinks to fit a sliver of a segment', () => {
    expect(roundedTopRect(0, 0, 4, 1, 3)).toBe('M0,1 L0,1 Q0,0 1,0 L3,0 Q4,0 4,1 L4,1 Z');
  });
});

describe('barsLayout', () => {
  const layout = barsLayout(BUCKETS, 300, 130, true);

  test('slot, bar width and plot box', () => {
    expect(layout).toMatchObject({ n: 3, slot: 100, barW: 24, domain: 10, plotTop: 4, plotH: 126 });
  });

  test('gridlines sit at half and full of the nice ceiling', () => {
    expect(layout.gridLines).toEqual([5, 10]);
    expect(barY(10, layout)).toBe(4);
    expect(barY(5, layout)).toBe(67);
    expect(barY(0, layout)).toBe(130);
  });

  test('showGrid=false draws none', () => {
    expect(barsLayout(BUCKETS, 300, 130, false).gridLines).toEqual([]);
  });

  test('bars cap at 24px wide and floor at 2px', () => {
    expect(barsLayout(BUCKETS, 45, 44, false).barW).toBe(12);
    expect(barsLayout(BUCKETS, 12, 44, false).barW).toBe(2);
  });

  test('bars are centred in their slot', () => {
    expect([0, 1, 2].map((i) => barX(i, layout))).toEqual([38, 138, 238]);
  });

  test('an all-zero window still has a domain, so nothing divides by zero', () => {
    const zero = barsLayout(
      [{ key: 'a', total: 0, values: {} }],
      300,
      130,
      true,
    );
    expect(zero.domain).toBe(0.000001);
    expect(barY(0, zero)).toBe(130);
  });
});

describe('bucketSegments', () => {
  const layout = barsLayout(BUCKETS, 300, 130, true);

  test('stacks upward in series order with the 2px gap carved out', () => {
    expect(bucketSegments(BUCKETS[0], SERIES, layout)).toEqual([
      { color: 'series-1', y: 79.6, h: 48.400000000000006 },
      { color: 'series-2', y: 54.39999999999999, h: 23.200000000000003 },
    ]);
  });

  test('a segment never collapses below half a pixel', () => {
    const [seg] = bucketSegments({ key: 'z', total: 0.01, values: { x: 0.01 } }, SERIES, layout);
    expect(seg.h).toBe(0.5);
  });

  test('zero and missing values are skipped, not drawn', () => {
    expect(bucketSegments(BUCKETS[1], SERIES, layout)).toEqual([]);
    expect(bucketSegments(BUCKETS[2], SERIES, layout)).toHaveLength(1);
  });

  test('a stale payload with no values degrades to an empty stack', () => {
    const stale = { key: 'a', total: 4 } as unknown as StackedBarBucket;
    expect(bucketSegments(stale, SERIES, layout)).toEqual([]);
  });
});

describe('per-bucket accessibility sentence', () => {
  const tick = (key: string, i: number) => `${key}#${i}`;

  test('tick, then the formatted total', () => {
    expect(bucketLabel(BUCKETS[0], 0, tick, fmtGrid)).toBe('a#0: $6');
  });

  test('an in-progress bucket says so', () => {
    expect(bucketLabel(BUCKETS[2], 2, tick, fmtGrid)).toBe('c#2: $10 (in progress)');
  });
});

describe('selection', () => {
  test('tapping the selected bucket clears it, another moves it', () => {
    expect(toggleSelection(2, 2)).toBeNull();
    expect(toggleSelection(2, 1)).toBe(1);
    expect(toggleSelection(null, 0)).toBe(0);
  });
});

describe('axisTicks', () => {
  const tick = (key: string, i: number) => `${key}#${i}`;
  const of = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `k${i}`, total: 1, values: {} }));

  test('no buckets: no labels', () => {
    expect(axisTicks([], tick)).toEqual({ left: '', mid: null, right: '' });
  });

  test('a single bucket labels only the left end', () => {
    expect(axisTicks(of(1), tick)).toEqual({ left: 'k0#0', mid: null, right: '' });
  });

  test('the middle label appears only past four buckets', () => {
    expect(axisTicks(of(4), tick).mid).toBeNull();
    expect(axisTicks(of(5), tick)).toEqual({ left: 'k0#0', mid: 'k2#2', right: 'k4#4' });
  });
});

describe('seriesPaint — the token-name shim', () => {
  test('a token name from seriesColors is resolved for the active scheme', () => {
    expect(seriesPaint('series-1', t)).toBe('resolved:series-1');
    expect(seriesPaint('provider-anthropic', t)).toBe('resolved:provider-anthropic');
  });

  test('anything that is not a token passes through untouched', () => {
    expect(seriesPaint('rebeccapurple', t)).toBe('rebeccapurple');
  });
});

describe('niceTicks — clean dollar gridlines', () => {
  test('a 100-wide span steps by 50', () => {
    expect(niceTicks(100, 200)).toEqual([100, 150, 200]);
  });

  test('a narrow span steps by 10', () => {
    expect(niceTicks(990, 1010)).toEqual([990, 1000, 1010]);
  });

  test('a flat span still produces ticks rather than looping', () => {
    expect(niceTicks(5, 5).length).toBeGreaterThan(0);
  });
});

describe('niceTicks terminates on agent-written numbers', () => {
  it('does not hang when the span is smaller than a double can step', () => {
    // Above ~9e15 the gap between representable doubles exceeds 1, so `v += 1`
    // is a no-op. This pair froze the thread and grew the array until the VM died.
    const ticks = niceTicks(1e16, 1e16 + 2);
    expect(ticks.length).toBeLessThanOrEqual(64);
  });

  it('survives wei-scale and other huge narrow spans', () => {
    for (const [lo, hi] of [[1e18, 1e18 + 100], [1e20, 1e20 + 1e4], [1e300, 1e300 + 1]]) {
      expect(niceTicks(lo, hi).length).toBeLessThanOrEqual(64);
    }
  });

  it('never returns an unbounded list', () => {
    expect(niceTicks(0, Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(64);
  });

  it('still produces ordinary ticks for ordinary ranges', () => {
    expect(niceTicks(0, 10)).toEqual([0, 5, 10]);
  });
});

describe('the top gridline clears the tallest bar', () => {
  // the user's live payload was counts 5/8/3/9: `niceValue` rounds down, so the
  // domain equalled the max, the tallest bar sat flush against the ceiling and
  // the only labelled line was at 45% of the plot.
  test.each([
    [9, 10],
    [42, 50],
    [118, 200],
    [0.4, 0.5],
    [1, 1],
  ])('niceCeil(%p) = %p', (input, expected) => {
    expect(niceCeil(input)).toBe(expected);
  });

  test('the domain is the ceiling, so the bar stops short of the top', () => {
    const layout = barsLayout([{ key: 'mon', total: 9, values: { calls: 9 } }], 100, 100);
    expect(layout.domain).toBe(10);
    expect(layout.gridLines).toEqual([5, 10]);
    expect(barY(9, layout)).toBeGreaterThan(layout.plotTop);
  });
});
