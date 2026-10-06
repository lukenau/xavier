// The Sankey as it actually draws. Skia is replaced by plain Views that record
// the props each node was handed, so every assertion below is about the real
// component's output — the text a reader sees, where it sits, and the order the
// paints go down — not about a helper in isolation.
//
// The fake font advances 6px per glyph, so an anchored x is exactly
// `x − 6 × text.length` (end) or `x − 3 × text.length` (middle).
const GLYPH = 6;

jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const { View } = require('react-native');
  const node =
    (name: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) =>
      React.createElement(View, { testID: name, ...props }, props.children);
  const font = {
    getGlyphIDs: (text: string) => [...text].map((c) => c.charCodeAt(0)),
    getGlyphWidths: (glyphs: number[]) => glyphs.map(() => 6),
    measureText: (text: string) => ({ x: 0, y: 0, width: text.length * 6, height: 10 }),
  };
  return {
    Canvas: node('sk-canvas'),
    Group: node('sk-group'),
    Path: node('sk-path'),
    Rect: node('sk-rect'),
    RoundedRect: node('sk-rrect'),
    Image: node('sk-image'),
    Text: node('sk-text'),
    useFont: () => font,
    Skia: {
      Data: { fromBase64: (b64: string) => ({ b64 }) },
      Image: { MakeImageFromEncoded: (data: { b64: string }) => ({ decoded: data.b64 }) },
    },
  };
});

import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { AccountFlow, FlowGraph, MatchedEdge } from '../../shared/financeModel';
import { ribbonPath } from '../../shared/sankeyLayout';
import { dark, light } from '../../theme/tokens.gen';
import { useTheme, type Scheme } from '../../theme/useTheme';
import { buildSankey } from './FlowSankeyLayout';
import { FlowSankey } from './FlowSankey';

/** The scheme useTheme() resolves to here, so colour assertions do not
 * hard-code one half of the token table. */
let tokenTable: Record<string, string> | null = null;
function tk(): Record<string, string> {
  if (!tokenTable) {
    const captured: Scheme[] = [];
    function Probe() {
      captured.push(useTheme().scheme);
      return null;
    }
    let probe!: TestRenderer.ReactTestRenderer;
    act(() => {
      probe = TestRenderer.create(<Probe />);
    });
    act(() => probe.unmount());
    tokenTable = captured[0] === 'light' ? light : dark;
  }
  return tokenTable;
}

const acct = (over: Partial<AccountFlow> & { last4: string }): AccountFlow => ({
  label: `Account ${over.last4}`,
  institution: 'Bank',
  accountName: 'Checking',
  cls: 'cash',
  color: 'series-1',
  balance: null,
  inflow: 0,
  inflowByType: { income: 0, refund: 0, interest: 0 },
  spend: 0,
  transferOut: 0,
  transferIn: 0,
  paymentOut: 0,
  paymentIn: 0,
  total: 0,
  ...over,
});

const graph = (
  accounts: AccountFlow[],
  edges: MatchedEdge[] = [],
  institutions: Record<string, { logo: string | null; color: string | null }> = {},
): FlowGraph => ({
  accounts,
  byLast4: new Map(accounts.map((a) => [a.last4, a])),
  edges,
  inflowByType: [],
  out: { spent: 0, savings: 0, card: 0, invest: 0, moved: 0 },
  institutions,
  windowDays: 30,
});

const CHECKING = acct({
  last4: '1111',
  label: 'Example Bank Checking ••1111',
  institution: 'Example Bank',
  accountName: 'Example Bank Checking',
  balance: 3000,
  inflow: 5000,
  inflowByType: { income: 5000, refund: 0, interest: 0 },
  spend: 1200,
  transferOut: 2000,
  paymentOut: 1800,
  total: 8000,
});
const CARD = acct({
  last4: '2222',
  label: 'Example Bank Miles ••2222',
  institution: 'Example Bank',
  accountName: 'CREDIT CARD',
  nickname: 'Example Bank Miles',
  cls: 'credit',
  color: 'series-2',
  balance: -200,
  inflow: 100,
  inflowByType: { income: 0, refund: 100, interest: 0 },
  spend: 900,
  paymentIn: 1500,
  total: 2500,
});
const VENMO = acct({
  last4: '9999',
  label: 'Venmo ••9999',
  institution: 'Venmo',
  accountName: 'Venmo',
  color: 'series-3',
  balance: 1,
  spend: 50,
  transferIn: 300,
  total: 350,
});
const SAVINGS = acct({
  last4: '5555',
  label: 'Acme Savings ••5555',
  institution: 'Acme',
  accountName: 'Savings',
  color: 'series-4',
  balance: 4000,
  transferIn: 1000,
  total: 1000,
});
const BROKERAGE = acct({
  last4: '7777',
  label: 'Sample Fund ••7777',
  institution: 'Sample Fund',
  accountName: 'Individual Cash Account',
  cls: 'investment',
  color: 'series-5',
  balance: 9000,
  transferIn: 800,
  total: 800,
});

const EDGES: MatchedEdge[] = [
  { from: '1111', to: '2222', amount: 1500, type: 'payment' },
  { from: '1111', to: '5555', amount: 1000, type: 'transfer' },
  { from: '1111', to: '7777', amount: 800, type: 'transfer' },
  { from: '1111', to: '9999', amount: 200, type: 'transfer' },
];

const ESTATE = graph([CHECKING, CARD, VENMO, SAVINGS, BROKERAGE], EDGES);

function mount(flows: FlowGraph) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<FlowSankey flows={flows} />);
  });
  return tree;
}

function measure(tree: TestRenderer.ReactTestRenderer, width: number) {
  act(() => {
    tree.root
      .findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'image')[0]
      .props.onLayout({ nativeEvent: { layout: { width, height: 0, x: 0, y: 0 } } });
  });
}

/** Mounts the chart and gives the canvas its viewBox width, so scale = 1. */
function render(flows: FlowGraph, width = 380) {
  const tree = mount(flows);
  measure(tree, width);
  return tree;
}

const nodes = (tree: TestRenderer.ReactTestRenderer, id: string): ReactTestInstance[] =>
  tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);

const texts = (tree: TestRenderer.ReactTestRenderer) =>
  nodes(tree, 'sk-text').map((n) => ({
    text: n.props.text as string,
    x: n.props.x as number,
    y: n.props.y as number,
    color: n.props.color as string,
    style: n.props.style as string | undefined,
    strokeWidth: n.props.strokeWidth as number | undefined,
  }));

/** The plain RN strings: the summary line, the band totals, the legend. */
const chrome = (tree: TestRenderer.ReactTestRenderer): string[] =>
  tree.root
    .findAll((n) => (n.type as string) === 'Text')
    .map((n) => n.children.filter((c): c is string => typeof c === 'string').join(''))
    .filter(Boolean);

describe('FlowSankey', () => {
  test('draws nothing when no account cleared the $1 floor', () => {
    expect(mount(graph([acct({ last4: '0001', total: 0.5 })])).toJSON()).toBeNull();
  });

  test('the canvas waits for a measured width, then takes the viewBox height', () => {
    const tree = mount(ESTATE);
    expect(nodes(tree, 'sk-canvas')).toHaveLength(0);
    measure(tree, 190);
    // Half the viewBox width, so the 818-unit chart draws 409 tall at scale 0.5.
    expect(nodes(tree, 'sk-canvas')[0].props.style).toEqual({ width: 190, height: 409 });
    expect(nodes(tree, 'sk-group')[0].props.transform).toEqual([{ scale: 0.5 }]);
  });

  test('the caption above the canvas counts accounts and both ends', () => {
    expect(chrome(render(ESTATE))[0]).toBe('in $5,200 · through 2 accounts · out $5,050');
  });

  test('one Path per ribbon, each the shared ribbonPath string at 45% opacity', () => {
    const tree = render(ESTATE);
    const built = buildSankey(ESTATE)!;
    const paths = nodes(tree, 'sk-path');
    expect(paths).toHaveLength(12);
    expect(paths.map((p) => p.props.opacity)).toEqual(Array(12).fill(0.45));
    expect(paths[0].props.path).toBe(ribbonPath(built.ribbons[0]));
    expect(paths[0].props.path).toMatch(/^M12\.0,130 C12\.0,249 /);
    // The colour token resolved through the theme, not passed through raw.
    expect(paths[0].props.color).toBe(tk()['series-1']);
  });

  test('a wide chip prints its name at the left and its balance at the right', () => {
    const all = texts(render(ESTATE));
    const name = all.find((t) => t.text === 'Example Bank Checking')!;
    expect(name).toMatchObject({ x: 19, y: 385, color: tk()['on-series'] }); // x + 7, y + 17
    const amount = all.find((t) => t.text === '$3,000' && t.y === 385)!;
    expect(amount.x).toBe(12 + 356 - 7 - '$3,000'.length * GLYPH); // end-anchored
  });

  test('IN and OUT sit outside the chip, haloed stroke-first so the ribbons cannot eat them', () => {
    const all = texts(render(ESTATE));
    const inLabel = all.filter((t) => t.text === 'IN $5,000');
    expect(inLabel).toHaveLength(2);
    // Stroke pass first, fill second — this is `paint-order: stroke`.
    expect(inLabel[0]).toMatchObject({ style: 'stroke', strokeWidth: 3.5, color: tk()['bg-1'] });
    expect(inLabel[1].style).toBeUndefined();
    expect(inLabel[1].color).toBe(tk()['fg-2']);
    // Centred on the chip, 6 above it.
    expect(inLabel[0].x).toBe(12 + 356 / 2 - ('IN $5,000'.length * GLYPH) / 2);
    expect(inLabel[0].y).toBe(368 - 6);

    const outLabel = all.filter((t) => t.text === 'OUT $5,000');
    expect(outLabel).toHaveLength(2);
    expect(outLabel[0].y).toBe(368 + 26 + 12);
  });

  test('band labels are tracked glyph by glyph, every halo laid before any fill', () => {
    const all = texts(render(ESTATE));
    const cash = all.filter((t) => t.y === 346);
    expect(cash.map((t) => t.text).join('')).toBe('CASHCASH');
    expect(cash.slice(0, 4).every((t) => t.style === 'stroke' && t.strokeWidth === 4)).toBe(true);
    expect(cash.slice(4).every((t) => t.style === undefined)).toBe(true);
    // 0.2em tracking at 10px = 2px after each 6px glyph.
    expect(cash.slice(4).map((t) => t.x)).toEqual([12, 20, 28, 36]);
    expect(all.filter((t) => t.text === 'W' && t.y === 214)[0].x).toBeCloseTo(285.714, 3);
    expect(all.some((t) => t.y === 526)).toBe(true); // MOVED INTO
    expect(all.some((t) => t.y === 810)).toBe(true); // OUT, at VH − 8
  });

  test('the IN band stacks label, amount and the wrapped breakdown', () => {
    const all = texts(render(ESTATE));
    const caption = all.filter((t) => t.text.startsWith('Income $5,000'))[0];
    expect(caption.text).toBe('Income $5,000  ·  Refunds $100');
    expect(caption.color).toBe(tk()['fg-3']);
    expect(all.some((t) => t.text === 'Transfers $100' && t.y === caption.y + 10)).toBe(true);
    expect(all.some((t) => t.text === 'Money in')).toBe(true);
    expect(all.some((t) => t.text === 'Internal')).toBe(true);
  });

  test('the OUT terminals label themselves in their own colour', () => {
    const all = texts(render(ESTATE));
    const spent = all.find((t) => t.text === 'Spent' && t.y >= 744)!;
    expect(spent.color).toBe(tk()['fg-2']);
    expect(spent.y).toBe(718 + 26 + 15);
    const invest = all.find((t) => t.text === '→ Invest')!;
    expect(invest.color).toBe(tk()['flow-invest']);
    expect(all.some((t) => t.text === '$800' && t.y === invest.y + 11)).toBe(true);
  });

  test('institution marks are decoded from base64 and drawn 16px square', () => {
    const tree = render(graph([CHECKING, CARD], EDGES.slice(0, 1), { 'Example Bank': { logo: 'QUJD', color: null } }));
    const images = nodes(tree, 'sk-image');
    expect(images).toHaveLength(2);
    expect(images[0].props).toMatchObject({ image: { decoded: 'QUJD' }, width: 16, height: 16, fit: 'contain' });
    // bothFit inset is 6, the tight one 5; the cash chip is wide here.
    expect(images[0].props.x).toBe(12 + 6);
    expect(images[0].props.y).toBe(262 + 5);
  });

  test('a folded tile draws member stripes with only its two ends rounded', () => {
    const cards = [1, 2, 3, 4, 5, 6].map((n) =>
      acct({ last4: `200${n}`, institution: `Bank${n}`, accountName: 'CREDIT CARD', cls: 'credit', color: `series-${n}`, spend: 1000 + n, paymentIn: 1000, total: 2000 }),
    );
    const tree = render(
      graph([CHECKING, ...cards], cards.map((c) => ({ from: '1111', to: c.last4, amount: 1000, type: 'payment' as const }))),
    );
    // Two members → one rrect for each end and no square middle.
    expect(nodes(tree, 'sk-rect')).toHaveLength(0);
    const stripes = nodes(tree, 'sk-rrect').filter((n) => n.props.color === tk()['series-1'] || n.props.color === tk()['series-2']);
    expect(stripes.length).toBeGreaterThanOrEqual(2);
    expect(chrome(tree)).toEqual(expect.arrayContaining(['Bank1', 'Bank2']));
  });

  test('the strip below the canvas walks the bands, and the legend names every chip', () => {
    const lines = chrome(render(ESTATE));
    expect(lines).toEqual([
      'in $5,200 · through 2 accounts · out $5,050',
      'IN', '$5,400',
      '→', 'WALLETS', '$100',
      '→', 'CASH', '$5,000',
      '→', 'CARDS', '$1,600',
      '→', 'OUT', '$5,050',
      'Venmo', 'Example Bank Checking', 'Example Bank Miles', 'Acme', 'Sample Fund',
    ]);
  });
});
