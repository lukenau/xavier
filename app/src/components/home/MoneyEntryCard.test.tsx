// The one component in this port with no PWA original, so its copy is not
// guarded by the parity inventory the way every other string here is: these
// render it for real and assert the words that reach the screen, plus the
// route it opens. Pixels are not verifiable on this host; text and props are.
import TestRenderer, { act } from 'react-test-renderer';
import { MoneyEntryCard, moneyLine } from './MoneyEntryCard';
import type { FinanceSnapshot } from '../../lib/types';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// expo-symbols renders a native view; the card's text is what is under test.
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router } = require('expo-router') as { router: { push: jest.Mock } };

const snapshot = (last_30d: number): FinanceSnapshot => ({
  schema_version: 4,
  asof: '2026-09-10T18:00:00Z',
  sources: { copilot_mcp: { status: 'ok' }, plaid: { status: 'ok' } },
  spend_windows: { today: 12, last_7d: 300, last_30d, top_categories: [] },
  spend: [],
  recent_transactions: [],
});

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

/** Rendered text NODES only — not props, so an accessibilityLabel carrying
 * the same word cannot stand in for a title that has actually changed. */
function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out;
}


beforeEach(() => router.push.mockClear());

describe('the line under the title', () => {
  test('is the 30-day spend window, labelled for what it actually measures', () => {
    // NOT "this month": the finance snapshot carries no month-to-date total,
    // and a rolling 30-day sum shown as "this month" reads several times too
    // high early in a month. See task-9-report.md §2.
    expect(moneyLine(snapshot(1200.4))).toBe('$1,200 last 30d');
    expect(moneyLine(snapshot(0))).toBe('$0 last 30d');
  });

  test('survives a snapshot without spend_windows instead of crashing Home', () => {
    // Demo/unwired instances serve partial snapshots; the tab must degrade,
    // not throw "Cannot read property 'last_30d' of undefined".
    const { spend_windows, ...partial } = snapshot(1200.4) as
      FinanceSnapshot & { spend_windows?: unknown };
    expect(moneyLine(partial as FinanceSnapshot)).toBe('$0 last 30d');
  });

  test('falls back to a descriptor rather than a fake $0 when no snapshot exists', () => {
    expect(moneyLine(null)).toBe('personal spend & accounts');
    expect(moneyLine(undefined)).toBe('personal spend & accounts');
  });
});

describe('rendering', () => {
  test('the card is titled Money and shows the spend line', () => {
    expect(texts(render(<MoneyEntryCard finance={snapshot(1200.4)} />))).toEqual([
      'Money',
      '$1,200 last 30d',
    ]);
  });

  test('it still renders with no snapshot — Money has no tab, so this is the only door', () => {
    expect(texts(render(<MoneyEntryCard finance={null} />))).toEqual([
      'Money',
      'personal spend & accounts',
    ]);
  });

  test('tapping it opens the Money route', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MoneyEntryCard finance={snapshot(10)} />);
    });
    // RN's Pressable is a forwardRef wrapper, so match on the handler rather
    // than the component identity.
    const pressable = tree.root.findAll((n) => typeof n.props.onPress === 'function')[0];
    act(() => {
      pressable.props.onPress();
    });
    expect(router.push).toHaveBeenCalledWith('/finance');
  });
});
