import {
  LINE_M,
  lineAxisTicks,
  lineDomain,
  lineLayout,
  linePath,
  lineX,
  lineY,
  type LineBucket,
} from './lineGeometry';

const W = 300;
const H = 120;
const LEFT = LINE_M.l;
const RIGHT = W - LINE_M.r;
const TOP = LINE_M.t;
const BOTTOM = H - LINE_M.b;

const BUCKETS: LineBucket[] = [
  { key: 'mon', values: { a: 10, b: 1 } },
  { key: 'tue', values: { a: 20 } },
  { key: 'wed', values: { a: 30, b: 3 } },
];

describe('lineDomain — never a zero-width range', () => {
  test('a normal spread pads by a tenth of the span', () => {
    expect(lineDomain(BUCKETS, ['a'])).toEqual({ dMin: 8, dMax: 32 });
  });

  test('a flat series still has a domain to divide by', () => {
    const flat = [{ key: 'a', values: { s: 5 } }, { key: 'b', values: { s: 5 } }];
    const { dMin, dMax } = lineDomain(flat, ['s']);
    expect(dMax - dMin).toBeCloseTo(0.02, 10);
    expect(dMin).toBeLessThan(dMax);
  });

  test('a flat series at zero falls back to a unit pad', () => {
    const zero = [{ key: 'a', values: { s: 0 } }, { key: 'b', values: { s: 0 } }];
    expect(lineDomain(zero, ['s'])).toEqual({ dMin: -0.1, dMax: 0.1 });
  });

  test('negative values pad outward, not inward', () => {
    const { dMin, dMax } = lineDomain([{ key: 'a', values: { s: -4 } }], ['s']);
    expect(dMin).toBeLessThan(-4);
    expect(dMax).toBeGreaterThan(-4);
  });

  test('no values at all is still a drawable range', () => {
    expect(lineDomain([], ['s'])).toEqual({ dMin: 0, dMax: 1 });
    expect(lineDomain([{ key: 'a', values: {} }], ['s'])).toEqual({ dMin: 0, dMax: 1 });
  });
});

describe('lineX / lineY — points on the plot', () => {
  test('the first and last bucket sit on the plot edges', () => {
    expect(lineX(0, 3, W)).toBe(LEFT);
    expect(lineX(2, 3, W)).toBe(RIGHT);
    expect(lineX(1, 3, W)).toBe((LEFT + RIGHT) / 2);
  });

  test('a lone point is centred rather than pinned to the axis', () => {
    expect(lineX(0, 1, W)).toBe((LEFT + RIGHT) / 2);
  });

  test('the domain maps top to bottom', () => {
    expect(lineY(32, 8, 32, H)).toBe(TOP);
    expect(lineY(8, 8, 32, H)).toBe(BOTTOM);
    expect(lineY(20, 8, 32, H)).toBe((TOP + BOTTOM) / 2);
  });

  test('a collapsed domain does not divide by zero', () => {
    expect(Number.isFinite(lineY(5, 5, 5, H))).toBe(true);
  });
});

describe('linePath', () => {
  test('two points become a move plus a line, rounded to a tenth', () => {
    expect(linePath([{ x: 42, y: 112.25 }, { x: 292, y: 10 }])).toBe('M42.0,112.3 L292.0,10.0');
  });

  test('fewer than two points has nothing to stroke', () => {
    expect(linePath([])).toBeNull();
    expect(linePath([{ x: 1, y: 2 }])).toBeNull();
  });
});

describe('lineLayout', () => {
  const layout = lineLayout(BUCKETS, ['a', 'b'], W, H);

  test('the first and last point of a series land on the plot edges', () => {
    const a = layout.series[0];
    expect(a.points).toHaveLength(3);
    const y = (v: number) => lineY(v, layout.dMin, layout.dMax, H);
    expect(a.points[0]).toEqual({ index: 0, value: 10, x: LEFT, y: y(10) });
    expect(a.points[2]).toEqual({ index: 2, value: 30, x: RIGHT, y: y(30) });
    expect(a.points[0].y).toBeGreaterThan(a.points[2].y);
  });

  test('a bucket a series has no value for is skipped, keeping the x of the rest', () => {
    const b = layout.series[1];
    expect(b.points.map((p) => p.index)).toEqual([0, 2]);
    expect(b.points[1].x).toBe(RIGHT);
  });

  test('the path walks every point of its own series', () => {
    expect(layout.series[0].path?.split(' ')).toHaveLength(3);
    expect(layout.series[0].path?.startsWith('M42.0,')).toBe(true);
  });

  test('y ticks stay inside the domain', () => {
    expect(layout.ticks.length).toBeGreaterThan(0);
    for (const tick of layout.ticks) {
      expect(tick).toBeGreaterThanOrEqual(layout.dMin);
      expect(tick).toBeLessThanOrEqual(layout.dMax);
    }
  });

  test('a single point draws a dot, not a line', () => {
    const one = lineLayout([{ key: 'only', values: { a: 7 } }], ['a'], W, H);
    expect(one.series[0].points).toHaveLength(1);
    expect(one.series[0].points[0].x).toBe((LEFT + RIGHT) / 2);
    expect(Number.isFinite(one.series[0].points[0].y)).toBe(true);
    expect(one.series[0].path).toBeNull();
  });

  test('a flat series stays on one horizontal row of finite numbers', () => {
    const flat = lineLayout(
      [{ key: 'a', values: { s: 5 } }, { key: 'b', values: { s: 5 } }],
      ['s'],
      W,
      H,
    );
    const ys = flat.series[0].points.map((p) => p.y);
    expect(ys.every(Number.isFinite)).toBe(true);
    expect(ys[0]).toBe(ys[1]);
  });
});

describe('lineAxisTicks', () => {
  const key = (k: string) => k.toUpperCase();

  test('first and last, and a middle only once the row is crowded', () => {
    expect(lineAxisTicks(BUCKETS, key)).toEqual({ left: 'MON', mid: null, right: 'WED' });
  });

  test('past four buckets the middle label appears', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k, values: {} }));
    expect(lineAxisTicks(five, key)).toEqual({ left: 'A', mid: 'C', right: 'E' });
  });

  test('a single bucket has no right-hand label', () => {
    expect(lineAxisTicks([{ key: 'only', values: {} }], key)).toEqual({
      left: 'ONLY',
      mid: null,
      right: '',
    });
  });
});
