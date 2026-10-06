// Money (Finance) screen behaviour, asserted against the real components and
// the real route — apps/hub/src/routes/Finance.tsx and its six finance parts.
// Every test here guards a string, a number or a branch that the PWA source
// fixes; the three deliberate quirks the port reproduces rather than fixes
// (OQ-22 fmtUsd's `$0` floor, OQ-23 the dead delta_30d path, OQ-24 the raw
// chip typing) each have a test of their own so a later "fix" fails loudly.
jest.mock('expo-router', () => ({
  // Screen arms the tab-re-press scroll with it; behaviour is asserted in Screen.test.tsx.
  useScrollToTop: () => {},
  useFocusEffect: () => {},
  useIsFocused: () => true,
  router: { push: jest.fn() },
}));

// DecisionCards (rendered inside the page for money decisions) pulls in the
// brief WebView, whose native module is absent under jest. The Decisions task
// owns those; here they only have to import.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef((props: object, _ref: unknown) => React.createElement(View, props)),
  };
});

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

// SyncButton matches a gate refusal with `err instanceof GateError`, which
// means importing lib/gate.ts, whose native module calls
// TurboModuleRegistry.getEnforcing at import time. Mocked exactly as
// src/lib/gate.test.ts mocks it — not `virtual`, because the package IS a
// dependency and a resolution failure is real signal. Nothing here is called:
// GateError is a plain class, and the errors below are constructed directly.
jest.mock('@sbaiahmed1/react-native-biometrics', () => ({
  BiometricStrength: { Strong: 'strong', Weak: 'weak' },
  InputEncoding: { UTF8: 'utf8', Base64: 'base64' },
  createKeys: jest.fn(),
  deleteKeys: jest.fn(),
  signWithOptions: jest.fn(),
}));

// FlowSankey draws on a Skia canvas (TurboModuleRegistry.getEnforcing at
// import time, absent under jest). Task 16 owns and tests it; this file only
// needs the page around it, so it is a prop-recording View here.
jest.mock('./FlowSankey', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlowSankey: (props: Record<string, unknown>) =>
      React.createElement(View, { testID: 'flow-sankey', ...props }),
  };
});

const mockState: {
  finance: unknown;
  financeError: Error | null;
  financeHangs: boolean;
  releaseFinance: (() => void) | null;
  decisions: unknown;
  cron: unknown;
  cronError: Error | null;
  applyError: Error | null;
  applyReal: boolean;
  applyCalls: unknown[];
} = {
  finance: null,
  financeError: null,
  financeHangs: false,
  releaseFinance: null,
  decisions: { open: [], answered: [], errors: [] },
  cron: { generated_at: '', jobs: [], count: 0 },
  cronError: null,
  applyError: null,
  applyReal: false,
  applyCalls: [],
};

// The real module is kept for ApplyError / GateNotWiredError: SyncButton's
// branch is `instanceof`, so a stubbed class would pass a test the app fails.
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    api: {
      finance: jest.fn(async () => {
        if (mockState.financeHangs) {
          await new Promise<void>((resolve) => {
            mockState.releaseFinance = resolve;
          });
        }
        if (mockState.financeError) throw mockState.financeError;
        return mockState.finance;
      }),
      decisions: jest.fn(async () => mockState.decisions),
      cron: jest.fn(async () => {
        if (mockState.cronError) throw mockState.cronError;
        return mockState.cron;
      }),
      applyWrite: jest.fn(async (request: never) => {
        mockState.applyCalls.push(request);
        // The gate test runs the REAL applyWrite: challenge POST, then the
        // typed gate error. Nothing here ever fakes a signature or a success.
        if (mockState.applyReal) return actual.api.applyWrite(request);
        if (mockState.applyError) throw mockState.applyError;
        return { status: 'applied', applied_at: '2026-09-11T12:00:00Z' };
      }),
      answerDecision: jest.fn(async () => ({ status: 'answered' })),
    },
  };
});

import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet, Text, type ViewStyle } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountsStrip } from './AccountsStrip';
import { MovementsBreakdown } from './MovementsBreakdown';
import { SourcesFooter } from './SourcesFooter';
import { SpendHero } from './SpendHero';
import { SyncButton } from './SyncButton';
import { TxnList } from './TxnList';
import { api, ApplyError, GateNotWiredError } from '../../lib/api';
import { GateError } from '../../lib/gate';
import type { Decision, FinanceMovement, FinanceTxn } from '../../lib/types';
import {
  buildFlows,
  type FinanceAccount,
  type FinanceSnapshotFull,
  type FlowGraph,
} from '../../shared/financeModel';
import { relTime } from '../../shared/time';
import { resolveToken, useTheme, type Scheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';
// eslint-disable-next-line import/no-relative-parent-imports
import MoneyScreen from '../../../app/(home)/finance';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

/** Today in the same shape relDay() compares against, so `relDay` renders
 * "today" no matter when the suite runs — and so buildFlows' windowDays is a
 * stable 1 (the only value `round(fraction-of-a-day)` can reach through its
 * `max(1, …)` floor). */
const TODAY = new Date().toISOString().slice(0, 10);

const flatten = (children: unknown): string => {
  if (children == null || typeof children === 'boolean') return '';
  if (Array.isArray(children)) return children.map(flatten).join('');
  if (typeof children === 'object' && 'props' in children) {
    return flatten((children as { props: { children?: unknown } }).props.children);
  }
  return String(children);
};

const mounted: TestRenderer.ReactTestRenderer[] = [];
const clients: QueryClient[] = [];

afterEach(() => {
  // Real timers FIRST. The two poll tests install fake ones mid-test, and a
  // component mounted before that holds REAL timer ids (react-query's 300s
  // refetchInterval): unmounting while the fake clock is installed sends those
  // ids to the fake clearTimeout, which does not know them, and the real timer
  // then keeps the node process alive for five minutes after the suite passes.
  jest.useRealTimers();
  // SkeletonCard's pulse and the refresh/sync spinner are Animated.loops; a
  // renderer left mounted keeps the run alive forever.
  mounted.splice(0).forEach((r) => act(() => r.unmount()));
  clients.splice(0).forEach((c) => c.clear());
  mockState.finance = null;
  mockState.financeError = null;
  mockState.financeHangs = false;
  mockState.releaseFinance?.();
  mockState.releaseFinance = null;
  mockState.decisions = { open: [], answered: [], errors: [] };
  mockState.cron = { generated_at: '', jobs: [], count: 0 };
  mockState.cronError = null;
  mockState.applyError = null;
  mockState.applyReal = false;
  mockState.applyCalls = [];
  jest.clearAllMocks();
});

function inspect(renderer: TestRenderer.ReactTestRenderer) {
  const texts = renderer.root.findAllByType(Text);
  const lines = texts.map((n) => flatten(n.props.children));
  return {
    renderer,
    lines,
    has: (line: string) => lines.includes(line),
    indexOf: (line: string) => lines.findIndex((l) => l === line),
    colorOf(line: string) {
      const node = texts.find((n) => flatten(n.props.children) === line);
      if (!node) throw new Error(`no line ${JSON.stringify(line)} in ${JSON.stringify(lines)}`);
      return StyleSheet.flatten(node.props.style).color as string;
    },
    styleOf(line: string) {
      const node = texts.find((n) => flatten(n.props.children) === line);
      if (!node) throw new Error(`no line ${JSON.stringify(line)} in ${JSON.stringify(lines)}`);
      return StyleSheet.flatten(node.props.style);
    },
    /** Host views matching a style predicate — the swatch, the flow bar. */
    boxes(match: (s: ViewStyle) => boolean) {
      return renderer.root
        .findAll((n) => typeof n.type === 'string')
        .map((n) => StyleSheet.flatten(n.props.style) as ViewStyle | undefined)
        .filter((s): s is ViewStyle => !!s && match(s));
    },
  };
}

function view(node: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(node);
  });
  mounted.push(renderer);
  return inspect(renderer);
}

/** The Pressable instance whose subtree carries this text. `findAllByType`
 * misses Pressable under RN 0.86 (memo/forwardRef wrapper), and only the
 * composite carries onPress. */
function pressable(renderer: TestRenderer.ReactTestRenderer, text: string) {
  const found = renderer.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      (flatten(n.props.children).includes(text) || n.props.accessibilityLabel === text),
  );
  expect(found).toHaveLength(1);
  return found[0];
}

/** Polls `condition` under `act()` until it holds. A fixed `setTimeout(…, 0)`
 * flush assumes one tick is enough for the mocked read to resolve AND for
 * react-query's batched notification to re-render: true on a warm machine,
 * false on a cold babel cache, where this file went 17 tests red. Ported from
 * src/lib/query.test.ts, where the identical flake was fixed the same way —
 * wait for the condition, never for longer. */
async function waitFor(
  condition: () => boolean,
  { timeoutMs = 5000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not satisfied within ${timeoutMs}ms`);
    }
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
  }
}

let schemeUsed: Scheme | null = null;
function scheme(): Scheme {
  if (!schemeUsed) {
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
    schemeUsed = captured[0] ?? 'dark';
  }
  return schemeUsed;
}
const tone = (name: TokenName) => resolveToken(scheme(), name);

// --- fixtures ---------------------------------------------------------------

const account = (over: Partial<FinanceAccount> = {}): FinanceAccount => ({
  name: 'Checking',
  institution: 'Example Bank',
  last4: '1111',
  type: 'checking',
  balance: 5000,
  currency: 'USD',
  source: 'plaid',
  id: 'acct-1111',
  asof: `${TODAY}T08:00:00-04:00`,
  ...over,
});

const txn = (over: Partial<FinanceTxn> = {}): FinanceTxn => ({
  date: TODAY,
  merchant: 'Blue Bottle',
  amount: 12.5,
  category: 'Coffee Shops',
  account_last4: '1111',
  pending: false,
  source: 'plaid',
  ...over,
});

const movement = (over: Partial<FinanceMovement> = {}): FinanceMovement => ({
  from: '1111',
  to: 'external:Amazon',
  amount: 40,
  date: TODAY,
  meaning: 'spend',
  confidence: 'observed',
  counterparty: 'Amazon',
  category: 'Shopping',
  sources: ['plaid'],
  ...over,
});

const snapshot = (over: Partial<FinanceSnapshotFull> = {}): FinanceSnapshotFull => ({
  schema_version: 3,
  asof: `${TODAY}T12:00:00-04:00`,
  sources: {
    copilot_mcp: { status: 'ok' },
    plaid: { status: 'ok', items_errored: [] },
  },
  spend_windows: { today: 42.5, last_7d: 310, last_30d: 1280, top_categories: [] },
  spend: [],
  recent_transactions: [txn()],
  accounts: [account()],
  ...over,
});

const decision = (over: Partial<Decision> = {}): Decision =>
  ({
    id: 'd1',
    title: 'Approve the Plaid relink',
    summary: 'Example Bank item needs a relink.',
    source: 'hermes',
    domain: 'finance',
    category: 'required',
    created: `${TODAY}T09:00:00Z`,
    status: 'open',
    options: [{ key: 'yes', label: 'Relink now' }],
    ...over,
  }) as Decision;

async function renderScreen(seed: {
  snapshot?: FinanceSnapshotFull | null;
  error?: Error;
  loading?: boolean;
  decisions?: Decision[];
}) {
  mockState.finance = seed.snapshot ?? null;
  mockState.financeError = seed.error ?? null;
  mockState.financeHangs = seed.loading ?? false;
  mockState.decisions = { open: seed.decisions ?? [], answered: [], errors: [] };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <MoneyScreen />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  mounted.push(renderer);
  // The mount act can return before the reads have resolved and re-rendered,
  // so wait for the state each caller is about to assert on — rendered text,
  // not a tick count. `loading` is the one seed whose read never resolves: its
  // settled state is the skeleton itself.
  const moneyDecisions = (seed.decisions ?? []).filter((d) => d.domain === 'finance');
  await waitFor(() => {
    if (client.getQueryState(['decisions'])?.status === 'pending') return false;
    const v = inspect(renderer);
    if (moneyDecisions.length > 0 && !v.has('Waiting on you · money decisions')) return false;
    if (seed.loading) return v.boxes((s) => s.height === 84).length > 0;
    if (seed.error) return v.has('Finance unavailable');
    if (!seed.snapshot) return v.has('Not connected yet');
    return v.has('Bank activity · all movement');
  });
  return inspect(renderer);
}

// --- SpendHero (SpendHero.tsx:7-43) -----------------------------------------

describe('SpendHero', () => {
  it('renders today / 7d / 30d through fmtUsd, today in gold at 23px', () => {
    const v = view(<SpendHero windows={snapshot().spend_windows} />);
    expect(v.lines).toEqual(['$42.50', 'today', '$310', 'last 7d', '$1,280', 'last 30d']);
    expect(v.colorOf('$42.50')).toBe(tone('accent-hi'));
    expect(v.styleOf('$42.50').fontSize).toBe(23);
    expect(v.colorOf('$310')).toBe(tone('fg-1'));
    expect(v.styleOf('$310').fontSize).toBe(15);
  });

  it('falls back to 0 for a window the snapshot omits', () => {
    const v = view(
      <SpendHero
        windows={{ today: 0, last_7d: 0, last_30d: 0, top_categories: [] } as never}
      />,
    );
    expect(v.lines).toEqual(['$0', 'today', '$0', 'last 7d', '$0', 'last 30d']);
  });
});

// --- AccountsStrip (AccountsStrip.tsx) --------------------------------------

const STRIP_SNAP = snapshot({
  accounts: [
    account({ last4: '1111', name: 'Checking', balance: 5000 }),
    account({ last4: '2222', name: 'Savings', balance: 9000, id: 'acct-2222' }),
    account({
      last4: '4444',
      institution: 'Example Card',
      name: 'Rewards',
      type: 'credit card',
      balance: -1200,
      id: 'acct-4444',
      source: 'copilot',
    }),
    account({
      last4: '5555',
      institution: 'Sample Credit',
      name: 'Cashback',
      type: 'credit card',
      balance: -300,
      id: 'acct-5555',
      source: 'plaid',
    }),
    account({
      last4: 'samplefund',
      institution: 'Sample Fund',
      name: 'Individual',
      type: 'brokerage',
      balance: 25000,
      id: 'acct-sf',
      source: 'copilot',
    }),
  ],
  recent_transactions: [
    txn({ amount: 12.5, account_last4: '1111' }),
    txn({ amount: -3000, category: 'Paycheck', merchant: 'ACME PAYROLL', account_last4: '1111' }),
    txn({ amount: 60, account_last4: '2222', merchant: 'Transfer to savings', category: 'Transfer' }),
  ],
});

describe('AccountsStrip', () => {
  const flows = buildFlows(STRIP_SNAP);

  it('groups Cash / Credit / Investments in order, each with a signed group total', () => {
    const v = view(<AccountsStrip accounts={STRIP_SNAP.accounts ?? []} flows={flows} />);
    expect(v.indexOf('Cash')).toBeLessThan(v.indexOf('Credit'));
    expect(v.indexOf('Credit')).toBeLessThan(v.indexOf('Investments'));
    expect(v.has('$14,000')).toBe(true); // cash 5000 + 9000
    expect(v.has('−$1,500')).toBe(true); // credit group total, U+2212 minus
    expect(v.has('$25,000')).toBe(true);
  });

  it('orders a group by money moved, then by |balance|', () => {
    const v = view(<AccountsStrip accounts={STRIP_SNAP.accounts ?? []} flows={flows} />);
    // 1111 moved $3,012.50 this window, 2222 only $60 — despite the bigger balance.
    expect(v.indexOf('$5,000')).toBeLessThan(v.indexOf('$9,000'));
  });

  it('labels an account by institution + name, mask and source', () => {
    const v = view(<AccountsStrip accounts={STRIP_SNAP.accounts ?? []} flows={flows} />);
    expect(v.has('Example Bank · Checking')).toBe(true);
    expect(v.has('…1111 · Plaid')).toBe(true);
    expect(v.has('Example Card')).toBe(true);
    // A maskless Copilot key gets no "…key ·" prefix, just the source.
    expect(v.has('Copilot')).toBe(true);
  });

  it('colours a negative balance fg-1 and a positive one accent-hi', () => {
    const v = view(<AccountsStrip accounts={STRIP_SNAP.accounts ?? []} flows={flows} />);
    expect(v.colorOf('−$1,200')).toBe(tone('fg-1'));
    expect(v.colorOf('$5,000')).toBe(tone('accent-hi'));
  });

  it('draws the in/out bar only for accounts that moved money', () => {
    const v = view(<AccountsStrip accounts={STRIP_SNAP.accounts ?? []} flows={flows} />);
    expect(v.has('↓ in $3,000')).toBe(true);
    expect(v.has('↑ out $12.50')).toBe(true);
    expect(v.colorOf('↓ in $3,000')).toBe(tone('inflow'));
    expect(v.colorOf('↑ out $12.50')).toBe(tone('fg-3'));
    // Sample Fund moved nothing this window: no bar row for it.
    expect(v.lines.filter((l) => l.startsWith('↓ in '))).toHaveLength(2);
  });

  it('sizes the two bar segments against the busiest account, floor 2%', () => {
    const v = view(<AccountsStrip accounts={STRIP_SNAP.accounts ?? []} flows={flows} />);
    const widths = v
      .boxes((s) => s.borderRadius === 2 && typeof s.width === 'string')
      .map((s) => s.width);
    // maxFlow = 3000 (1111's inflow). 1111: in 100%, out 12.5/3000 → floor 2%.
    expect(widths).toContain('100%');
    expect(widths).toContain('2%');
    expect(widths).toContain(`${(60 / 3000) * 100}%`);
  });

  it('paints the swatch with the account colour, resolved from its token', () => {
    const v = view(<AccountsStrip accounts={STRIP_SNAP.accounts ?? []} flows={flows} />);
    const swatches = v.boxes((s) => s.width === 8 && s.height === 8 && s.borderRadius === 2);
    const colors = swatches.map((s) => s.backgroundColor);
    expect(colors).toContain(tone(flows.byLast4.get('1111')!.color as TokenName));
    // Sample Fund never moved money, so it has no flow and falls back to NEUTRAL.
    expect(colors).toContain(tone('series-other'));
    expect(colors.every((c) => typeof c === 'string' && c.startsWith('#'))).toBe(true);
  });

  it('collapses past four per group and expands every group at once', () => {
    const many = snapshot({
      accounts: [1, 2, 3, 4, 5, 6].map((n) =>
        account({ last4: `100${n}`, name: `Account ${n}`, balance: 100 * n, id: `a${n}` }),
      ),
      recent_transactions: [],
    });
    const v = view(<AccountsStrip accounts={many.accounts ?? []} flows={buildFlows(many)} />);
    expect(v.has('show 2 more accounts')).toBe(true);
    expect(v.lines.filter((l) => l.startsWith('…100'))).toHaveLength(4);
    act(() => pressable(v.renderer, 'show 2 more accounts').props.onPress());
    const after = inspect(v.renderer);
    expect(after.lines.filter((l) => l.startsWith('…100'))).toHaveLength(6);
    expect(after.has('show 2 more accounts')).toBe(false);
  });

  // "out" is spend + transferOut + paymentOut. A card payment leaving a cash
  // account is the only one of the three no other fixture here produces, so
  // without this the paymentOut term can be deleted with the suite still green.
  it('counts a card payment leaving a cash account as money out', () => {
    const paying = snapshot({
      accounts: [account({ last4: '1111', name: 'Checking', balance: 5000 })],
      recent_transactions: [
        txn({
          merchant: 'EXAMPLE BANK CRD AUTOPAY',
          category: 'Credit Card Payment',
          amount: 250,
          account_last4: '1111',
        }),
      ],
    });
    const payFlows = buildFlows(paying);
    expect(payFlows.byLast4.get('1111')).toMatchObject({ paymentOut: 250, spend: 0, transferOut: 0 });
    const v = view(<AccountsStrip accounts={paying.accounts ?? []} flows={payFlows} />);
    expect(v.has('↑ out $250')).toBe(true);
    expect(v.has('↓ in $0')).toBe(true);
  });

  it('renders nothing without accounts', () => {
    const v = view(<AccountsStrip accounts={[]} flows={buildFlows(snapshot({ accounts: [] }))} />);
    expect(v.lines).toEqual([]);
  });
});

// --- TxnList (TxnList.tsx) --------------------------------------------------

describe('TxnList', () => {
  const flows = buildFlows(STRIP_SNAP);

  it('says so, uncarded, when there are no transactions', () => {
    const v = view(<TxnList txns={[]} byLast4={flows.byLast4} />);
    expect(v.lines).toEqual(['no recent transactions']);
    expect(v.colorOf('no recent transactions')).toBe(tone('fg-4'));
  });

  it('renders merchant, chip, meta line and a signed amount', () => {
    const v = view(<TxnList txns={STRIP_SNAP.recent_transactions} byLast4={flows.byLast4} />);
    expect(v.has('Blue Bottle')).toBe(true);
    expect(v.has('today · Example Bank Checking …1111 · Plaid')).toBe(true);
    expect(v.has('$12.50')).toBe(true);
    expect(v.colorOf('$12.50')).toBe(tone('fg-0'));
    expect(v.has('+$3,000')).toBe(true);
    expect(v.colorOf('+$3,000')).toBe(tone('inflow'));
  });

  it('falls back to category, then to "Transaction", for a nameless row', () => {
    const v = view(
      <TxnList
        txns={[txn({ merchant: '', category: 'Groceries' }), txn({ merchant: '', category: '' })]}
        byLast4={flows.byLast4}
      />,
    );
    expect(v.has('Groceries')).toBe(true);
    expect(v.has('Transaction')).toBe(true);
  });

  it('flags a pending row', () => {
    const v = view(<TxnList txns={[txn({ pending: true })]} byLast4={flows.byLast4} />);
    expect(v.has('pending')).toBe(true);
    expect(v.colorOf('pending')).toBe(tone('status-warn'));
  });

  it('chips every type with its own token pair', () => {
    const v = view(
      <TxnList
        txns={[
          txn({ merchant: 'Blue Bottle' }),
          txn({ merchant: 'ACME PAYROLL', category: 'Paycheck', amount: -3000 }),
          txn({ merchant: 'Zelle to Sam', category: 'Transfer', amount: 40 }),
          txn({ merchant: 'AUTOPAY PAYMENT', category: 'Credit Card Payment', amount: 500 }),
          txn({ merchant: 'Amazon', category: 'Refund', amount: -20 }),
          txn({ merchant: 'Example Bank', category: 'Bank Fees', amount: 35 }),
          txn({ merchant: 'Example Savings', category: 'Interest Earned', amount: -3 }),
        ]}
        byLast4={flows.byLast4}
      />,
    );
    for (const type of ['spend', 'income', 'transfer', 'payment', 'refund', 'fee', 'interest']) {
      expect(v.has(type)).toBe(true);
      expect(v.colorOf(type)).toBe(tone(`cat-${type}` as TokenName));
    }
  });

  it('strips a trailing last4 from a disambiguated label, keeps the mask chip', () => {
    const snap = snapshot({
      accounts: [
        account({ last4: '7001', name: 'CREDIT CARD', type: 'credit card', id: 'a1' }),
        account({ last4: '7002', name: 'CREDIT CARD', type: 'credit card', id: 'a2' }),
      ],
      recent_transactions: [txn({ account_last4: '7001' })],
    });
    const f = buildFlows(snap);
    expect(f.byLast4.get('7001')!.label).toBe('Example Bank Credit Card …7001');
    const v = view(<TxnList txns={snap.recent_transactions} byLast4={f.byLast4} />);
    // The strip leaves the label's own ellipsis behind, so the mask reads twice
    // over — the PWA's output, character for character.
    expect(v.has('today · Example Bank Credit Card … …7001 · Plaid')).toBe(true);
  });

  it('titlecases a maskless account key when the flow map has no entry', () => {
    const v = view(<TxnList txns={[txn({ account_last4: 'venmo' })]} byLast4={new Map()} />);
    expect(v.has('today · Venmo · Plaid')).toBe(true);
  });

  it('shows 12 rows, then all of them, then 12 again', () => {
    const many = Array.from({ length: 14 }, (_, i) => txn({ merchant: `Merchant ${i}` }));
    const v = view(<TxnList txns={many} byLast4={flows.byLast4} />);
    expect(v.lines.filter((l) => l.startsWith('Merchant '))).toHaveLength(12);
    expect(v.has('show all 14')).toBe(true);
    act(() => pressable(v.renderer, 'show all 14').props.onPress());
    let after = inspect(v.renderer);
    expect(after.lines.filter((l) => l.startsWith('Merchant '))).toHaveLength(14);
    expect(after.has('show less')).toBe(true);
    act(() => pressable(v.renderer, 'show less').props.onPress());
    after = inspect(v.renderer);
    expect(after.lines.filter((l) => l.startsWith('Merchant '))).toHaveLength(12);
  });

  it('keeps no footer when there are exactly 12', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => txn({ merchant: `Merchant ${i}` }));
    const v = view(<TxnList txns={twelve} byLast4={flows.byLast4} />);
    expect(v.lines.some((l) => l.startsWith('show all'))).toBe(false);
  });

  // OQ-24, half one: the client's BNPL rule has no counterpart in the
  // producer's Python classifier. Klarna files under LOAN_PAYMENTS, which the
  // PAYMENT rule would otherwise claim.
  it('types a BNPL charge as spend, not payment (OQ-24)', () => {
    const v = view(
      <TxnList
        txns={[txn({ merchant: 'KLARNA*ABC', category: 'LOAN_PAYMENTS', amount: 60 })]}
        byLast4={flows.byLast4}
      />,
    );
    expect(v.has('spend')).toBe(true);
    expect(v.has('payment')).toBe(false);
  });

  // OQ-24, half two: the chip is raw deriveTxnType, while buildFlows corrects
  // the same row against the account class. The client is canonical for
  // display, so the list and the chart disagree on purpose.
  it('chips the RAW type even where buildFlows retypes the row (OQ-24)', () => {
    const snap = snapshot({
      accounts: [account({ last4: '4444', institution: 'Example Card', type: 'credit card', balance: -100 })],
      recent_transactions: [
        txn({ account_last4: '4444', merchant: 'CREDIT ADJUSTMENT', category: 'Dividend', amount: -120 }),
      ],
    });
    const f = buildFlows(snap);
    // The chart counts it as a refund onto the card; the chip still says income.
    expect(f.byLast4.get('4444')!.inflowByType).toEqual({ income: 0, refund: 120, interest: 0 });
    const v = view(<TxnList txns={snap.recent_transactions} byLast4={f.byLast4} />);
    expect(v.has('income')).toBe(true);
    expect(v.has('refund')).toBe(false);
  });
});

// --- MovementsBreakdown (MovementsBreakdown.tsx) -----------------------------

describe('MovementsBreakdown', () => {
  const flows = buildFlows(STRIP_SNAP);
  const MOVEMENTS: FinanceMovement[] = [
    movement({ amount: 40, counterparty: 'Amazon' }),
    movement({ amount: 60, counterparty: 'Whole Foods', category: 'Groceries' }),
    movement({
      meaning: 'income',
      from: 'external:ACME',
      to: '1111',
      amount: 3000,
      counterparty: 'ACME PAYROLL',
    }),
    movement({
      meaning: 'reversed',
      from: '1111',
      to: 'external:',
      amount: 500,
      counterparty: 'RETURNED AUTOPAY',
      confidence: 'single-sided',
    }),
  ];

  it('renders nothing at all when there are no movements', () => {
    const v = view(<MovementsBreakdown movements={[]} byLast4={flows.byLast4} />);
    expect(v.lines).toEqual([]);
  });

  it('heads the card with the movement count and orders groups by total desc', () => {
    const v = view(<MovementsBreakdown movements={MOVEMENTS} byLast4={flows.byLast4} />);
    expect(v.has('how money moved · 4 movements')).toBe(true);
    expect(v.indexOf('Income')).toBeLessThan(v.indexOf('Reversed'));
    expect(v.indexOf('Reversed')).toBeLessThan(v.indexOf('Spend'));
  });

  it('carries each meaning label, its reason and its count', () => {
    const v = view(<MovementsBreakdown movements={MOVEMENTS} byLast4={flows.byLast4} />);
    expect(v.has('Spend')).toBe(true);
    expect(v.has('Money leaving for goods and services')).toBe(true);
    expect(v.has('Income')).toBe(true);
    expect(v.has('Earned money entering from outside')).toBe(true);
    expect(v.has('2')).toBe(true); // the spend group's count
  });

  it('signs an inflow group, strikes a reversed one', () => {
    const v = view(<MovementsBreakdown movements={MOVEMENTS} byLast4={flows.byLast4} />);
    expect(v.has('+$3,000')).toBe(true);
    expect(v.colorOf('+$3,000')).toBe(tone('inflow'));
    expect(v.colorOf('$100')).toBe(tone('fg-0')); // spend group total
    expect(v.colorOf('$500')).toBe(tone('fg-4')); // reversed
    expect(v.styleOf('$500').textDecorationLine).toBe('line-through');
  });

  it('opens one group at a time, biggest movement first', () => {
    const v = view(<MovementsBreakdown movements={MOVEMENTS} byLast4={flows.byLast4} />);
    expect(v.has('Whole Foods')).toBe(false);
    act(() => pressable(v.renderer, 'Spend').props.onPress());
    let open = inspect(v.renderer);
    expect(open.indexOf('Whole Foods')).toBeLessThan(open.indexOf('Amazon'));
    // Opening another closes this one.
    act(() => pressable(v.renderer, 'Income').props.onPress());
    open = inspect(v.renderer);
    expect(open.has('Whole Foods')).toBe(false);
    expect(open.has('ACME PAYROLL')).toBe(true);
    // Tapping the open group closes it.
    act(() => pressable(v.renderer, 'Income').props.onPress());
    expect(inspect(v.renderer).has('ACME PAYROLL')).toBe(false);
  });

  it('resolves both endpoints, and flags a one-sided movement', () => {
    const v = view(<MovementsBreakdown movements={MOVEMENTS} byLast4={flows.byLast4} />);
    act(() => pressable(v.renderer, 'Income').props.onPress());
    expect(inspect(v.renderer).has(`${TODAY} · ACME → Example Bank Checking`)).toBe(true);
    act(() => pressable(v.renderer, 'Reversed').props.onPress());
    expect(
      inspect(v.renderer).has(`${TODAY} · Example Bank Checking → outside · one side only`),
    ).toBe(true);
  });

  it('falls back to "…key" for an account the flow map never saw', () => {
    const v = view(
      <MovementsBreakdown
        movements={[movement({ from: '9999', to: '1111', meaning: 'transfer', amount: 25 })]}
        byLast4={flows.byLast4}
      />,
    );
    act(() => pressable(v.renderer, 'Transfers').props.onPress());
    expect(inspect(v.renderer).has(`${TODAY} · …9999 → Example Bank Checking`)).toBe(true);
  });

  it('labels a meaning it has never heard of with the raw string', () => {
    const v = view(
      <MovementsBreakdown
        movements={[movement({ meaning: 'teleported' as never, counterparty: 'Elsewhere' })]}
        byLast4={flows.byLast4}
      />,
    );
    expect(v.has('teleported')).toBe(true);
    expect(v.has('$40.00')).toBe(true);
  });

  it('names a movement by counterparty, then category, then "movement"', () => {
    const v = view(
      <MovementsBreakdown
        movements={[
          movement({ counterparty: '', category: 'Groceries', amount: 30 }),
          movement({ counterparty: '', category: '', amount: 10 }),
        ]}
        byLast4={flows.byLast4}
      />,
    );
    act(() => pressable(v.renderer, 'Spend').props.onPress());
    const open = inspect(v.renderer);
    expect(open.has('Groceries')).toBe(true);
    expect(open.has('movement')).toBe(true);
  });
});

// --- SourcesFooter (SourcesFooter.tsx) ---------------------------------------

describe('SourcesFooter', () => {
  it('badges both sources healthy and stamps the snapshot age', () => {
    const snap = snapshot({ asof: '2026-01-02T03:04:05-05:00' });
    const v = view(<SourcesFooter snap={snap} />);
    expect(v.has('copilot')).toBe(true);
    expect(v.has('plaid')).toBe(true);
    expect(v.colorOf('copilot')).toBe(tone('fg-3'));
    expect(v.has(`snapshot ${relTime(snap.asof)}`)).toBe(true);
  });

  it('spells out a degraded source in warn ink', () => {
    const snap = snapshot({
      sources: {
        copilot_mcp: { status: 'ok' },
        plaid: { status: 'degraded', items_errored: ['chase', 'amex'] },
      },
    });
    const v = view(<SourcesFooter snap={snap} />);
    expect(v.has('plaid · degraded')).toBe(true);
    expect(v.colorOf('plaid · degraded')).toBe(tone('status-warn'));
    expect(v.has('plaid items needing relink: chase, amex')).toBe(true);
    expect(v.colorOf('plaid items needing relink: chase, amex')).toBe(tone('status-warn'));
  });

  it('omits the relink line when nothing needs relinking', () => {
    const v = view(<SourcesFooter snap={snapshot()} />);
    expect(v.lines.some((l) => l.startsWith('plaid items needing relink'))).toBe(false);
  });

  it('carries the note verbatim', () => {
    const v = view(<SourcesFooter snap={snapshot()} />);
    expect(
      v.has(
        'Amounts show only on the Hub, never in Telegram.',
      ),
    ).toBe(true);
  });
});

// --- SyncButton, through the page (SyncButton.tsx:16-105) --------------------

const CRON_JOB = {
  id: 'job-finance',
  name: 'finance-snapshot',
  schedule: '0 */8 * * *',
  repeat: null,
  next_run_at: null,
  deliver: null,
  mode: 'script' as const,
  script: 'finance-snapshot.py',
  last_run: null,
  state: 'active' as const,
  active: true,
};

async function pressSync(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    await pressable(renderer, 'Sync accounts now').props.onPress();
  });
}

describe('SyncButton', () => {
  it('runs the finance-snapshot cron job through the gated write path', async () => {
    mockState.cron = { generated_at: '', jobs: [CRON_JOB], count: 1 };
    const v = await renderScreen({ snapshot: snapshot() });
    expect(v.has('Sync')).toBe(true);

    await pressSync(v.renderer);

    expect(mockState.applyCalls).toEqual([{ action: 'cron.run', job_id: 'job-finance' }]);
    expect(inspect(v.renderer).has('Sync')).toBe(true);
    // Success refetches the page: the finance read ran again after the write.
    expect((api.finance as jest.Mock).mock.calls.length).toBeGreaterThan(1);
  });

  it('fails when the hub has no finance-snapshot job, without writing', async () => {
    mockState.cron = { generated_at: '', jobs: [{ ...CRON_JOB, name: 'other-job' }], count: 1 };
    const v = await renderScreen({ snapshot: snapshot() });
    await pressSync(v.renderer);
    expect(mockState.applyCalls).toEqual([]);
    expect(inspect(v.renderer).has('Failed — retry')).toBe(true);
  });

  it('fails when the cron listing itself is unreachable', async () => {
    mockState.cronError = new Error('cron unavailable');
    const v = await renderScreen({ snapshot: snapshot() });
    await pressSync(v.renderer);
    expect(inspect(v.renderer).has('Failed — retry')).toBe(true);
  });

  // The PWA returns to idle with no message when the gate refuses; nothing ran,
  // so there is nothing to poll for.
  it('returns quietly to idle when the gate refuses', async () => {
    mockState.cron = { generated_at: '', jobs: [CRON_JOB], count: 1 };
    mockState.applyError = new GateNotWiredError('cancelled');
    const v = await renderScreen({ snapshot: snapshot() });
    await pressSync(v.renderer);
    const after = inspect(v.renderer);
    expect(after.has('Sync')).toBe(true);
    expect(after.has('Failed — retry')).toBe(false);
  });

  it('treats a cancelled Face ID the same way', async () => {
    mockState.cron = { generated_at: '', jobs: [CRON_JOB], count: 1 };
    mockState.applyError = new ApplyError('cancelled', 'Face ID cancelled.');
    const v = await renderScreen({ snapshot: snapshot() });
    await pressSync(v.renderer);
    expect(inspect(v.renderer).has('Sync')).toBe(true);
  });

  // Every gate refusal is raised at the signing step, BEFORE the apply POST —
  // a face that did not match carries `assertion_invalid`, an unpaired key / a
  // lockout / biometrics not enrolled carry `unknown`, and none of them are a
  // `cancelled` code. They are GateErrors, and GateError extends ApplyError, so
  // matching on the code alone drops them into the poll branch: the button then
  // sits on "Syncing…" for 90 dead seconds and claims "Failed — retry" for a
  // write that was never dispatched.
  const REFUSALS: [string, GateError][] = [
    ['a face that did not match', new GateError('assertion_invalid', 'Face ID did not verify.')],
    ['an unpaired key', new GateError('unknown', 'This iPhone is no longer paired.')],
    ['a Face ID lockout', new GateError('unknown', 'Face ID is locked out.')],
  ];
  for (const [label, gateError] of REFUSALS) {
    it(`returns quietly to idle on ${label}, without polling`, async () => {
      mockState.cron = { generated_at: '', jobs: [CRON_JOB], count: 1 };
      mockState.applyError = gateError;
      const v = await renderScreen({ snapshot: snapshot() });
      const readsBefore = (api.finance as jest.Mock).mock.calls.length;

      await pressSync(v.renderer);

      const after = inspect(v.renderer);
      expect(after.has('Sync')).toBe(true);
      expect(after.has('Syncing…')).toBe(false);
      expect(after.has('Failed — retry')).toBe(false);
      // The poll branch refetches the snapshot on every tick; the refusal
      // branch touches nothing, because nothing was dispatched.
      expect((api.finance as jest.Mock).mock.calls.length).toBe(readsBefore);
    });
  }

  // The gate is wired, not stubbed: the REAL api.applyWrite runs here, so a
  // genuine /action/challenge POST goes out and the typed error comes back
  // from the signing step — never a faked success, never an apply without a
  // proof.
  it('posts a real challenge and stops at the unwired signer', async () => {
    mockState.cron = { generated_at: '', jobs: [CRON_JOB], count: 1 };
    mockState.applyReal = true;
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        challenge: 'abc',
        rp_id: 'hub.example.com',
        user_verification: 'required',
        allowed_credentials: [],
        timeout_ms: 60_000,
      }),
    }));
    const realFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const v = await renderScreen({ snapshot: snapshot() });
      await pressSync(v.renderer);
      const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls.some((u) => u.endsWith('/api/action/challenge'))).toBe(true);
      expect(urls.some((u) => u.endsWith('/api/action/apply'))).toBe(false);
      expect(inspect(v.renderer).has('Sync')).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('polls the asof for 90s after an apply failure, and clears when it moves', async () => {
    mockState.cron = { generated_at: '', jobs: [CRON_JOB], count: 1 };
    mockState.applyError = new ApplyError('bridge_error', 'bridge timed out');
    const v = await renderScreen({ snapshot: snapshot({ asof: 'A' }) });

    jest.useFakeTimers();
    await act(async () => {
      pressable(v.renderer, 'Sync accounts now').props.onPress();
    });
    expect(inspect(v.renderer).has('Syncing…')).toBe(true);

    // First tick: the snapshot has not moved, so the button keeps waiting.
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(inspect(v.renderer).has('Syncing…')).toBe(true);

    // Second tick: the run landed.
    mockState.finance = snapshot({ asof: 'B' });
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    const after = inspect(v.renderer);
    expect(after.has('Sync')).toBe(true);
    expect(after.has('Failed — retry')).toBe(false);
  });

  it('gives up after 18 tries when the asof never moves', async () => {
    mockState.cron = { generated_at: '', jobs: [CRON_JOB], count: 1 };
    mockState.applyError = new ApplyError('bridge_error', 'bridge timed out');
    const v = await renderScreen({ snapshot: snapshot({ asof: 'A' }) });

    jest.useFakeTimers();
    await act(async () => {
      pressable(v.renderer, 'Sync accounts now').props.onPress();
    });
    for (let i = 0; i < 17; i++) {
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      expect(inspect(v.renderer).has('Syncing…')).toBe(true);
    }
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(inspect(v.renderer).has('Failed — retry')).toBe(true);
  });
});

// --- The Money screen (app/(home)/finance.tsx) -------------------------------

describe('Money screen', () => {
  it('titles the page and shows both header controls', async () => {
    const v = await renderScreen({ snapshot: snapshot() });
    expect(v.has('Money')).toBe(true);
    expect(v.has('Sync')).toBe(true);
    expect(pressable(v.renderer, 'Refresh')).toBeTruthy();
  });

  it('shows an 84 and a 300 skeleton while the first read is in flight', async () => {
    const v = await renderScreen({ loading: true });
    const heights = v.boxes((s) => s.height === 84 || s.height === 300).map((s) => s.height);
    expect(heights).toContain(84);
    expect(heights).toContain(300);
    expect(v.has('Not connected yet')).toBe(false);
    // Let the read finish inside the test: an unresolved query left behind
    // keeps react-query's machinery (and the node process) busy after the run.
    mockState.finance = snapshot();
    await act(async () => {
      mockState.releaseFinance?.();
    });
    await waitFor(() => inspect(v.renderer).has('Bank activity · all movement'));
    expect(inspect(v.renderer).has('Bank activity · all movement')).toBe(true);
  });

  it('surfaces a finance read failure with the server message', async () => {
    const v = await renderScreen({ error: new Error('finance snapshot unreadable') });
    expect(v.has('Finance unavailable')).toBe(true);
    expect(v.has('finance snapshot unreadable')).toBe(true);
  });

  it('explains a missing snapshot (404 → null) instead of showing an error', async () => {
    const v = await renderScreen({ snapshot: null });
    expect(v.has('Not connected yet')).toBe(true);
    expect(
      v.has("No finance snapshot on the server — the Copilot/Plaid cron hasn't written one."),
    ).toBe(true);
    expect(v.has('Finance unavailable')).toBe(false);
  });

  it('lays the sections out in the PWA order, with the labels verbatim', async () => {
    const v = await renderScreen({ snapshot: { ...STRIP_SNAP, movements: [movement()] } });
    const order = [
      'Personal money · spend & accounts',
      'Money flow · last 1d',
      'Accounts · balances & 1d flow',
      'Bank activity · all movement',
      'How money moved · classifications',
    ];
    const seen = order.map((label) => v.indexOf(label));
    expect(seen.every((i) => i >= 0)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('hands FlowSankey the built graph and captions it', async () => {
    const v = await renderScreen({ snapshot: STRIP_SNAP });
    const sankey = v.renderer.root.findAll((n) => n.props.testID === 'flow-sankey');
    expect(sankey.length).toBeGreaterThan(0);
    expect((sankey[0].props.flows as FlowGraph).byLast4.get('1111')!.spend).toBe(12.5);
    expect(
      v.has(
        'Top to bottom: money comes in, lands in an account, then leaves as spend or a move. Ribbon width = dollars; color = the account it moved through.',
      ),
    ).toBe(true);
  });

  it('hides the flow chart when no account moved more than half a cent', async () => {
    const still = snapshot({ recent_transactions: [txn({ amount: 0.004 })] });
    const v = await renderScreen({ snapshot: still });
    expect(v.renderer.root.findAll((n) => n.props.testID === 'flow-sankey')).toHaveLength(0);
    expect(v.lines.some((l) => l.startsWith('Money flow · last'))).toBe(false);
    // The rest of the page still renders.
    expect(v.has('Bank activity · all movement')).toBe(true);
  });

  it('omits the movements section when the snapshot carries none', async () => {
    const v = await renderScreen({ snapshot: snapshot() });
    expect(v.has('How money moved · classifications')).toBe(false);
  });

  it('shows only finance-domain decisions, above everything else', async () => {
    const v = await renderScreen({
      snapshot: snapshot(),
      decisions: [
        decision(),
        decision({ id: 'd2', title: 'Rebalance the sleeve', domain: 'ops' }),
        decision({ id: 'd3', title: 'Domainless card', domain: undefined }),
      ],
    });
    expect(v.has('Waiting on you · money decisions')).toBe(true);
    expect(v.has('Approve the Plaid relink')).toBe(true);
    expect(v.has('Rebalance the sleeve')).toBe(false);
    expect(v.has('Domainless card')).toBe(false);
    expect(v.indexOf('Waiting on you · money decisions')).toBeLessThan(
      v.indexOf('Personal money · spend & accounts'),
    );
  });

  it('drops the decisions section entirely when none are money decisions', async () => {
    const v = await renderScreen({
      snapshot: snapshot(),
      decisions: [decision({ domain: 'ops' })],
    });
    expect(v.has('Waiting on you · money decisions')).toBe(false);
  });

  it('closes with net worth, then the sources footer', async () => {
    const v = await renderScreen({
      snapshot: snapshot({
        net_worth: { total: 12_000, assets: 15_000, liabilities: 3_000, delta_1d: 0, delta_30d: 0 },
      }),
    });
    expect(v.has('net worth')).toBe(true);
    expect(v.has('$12,000 · assets $15,000 · owed $3,000')).toBe(true);
    expect(v.indexOf('net worth')).toBeLessThan(v.indexOf('copilot'));
  });

  // OQ-23: the producer always writes delta_30d: 0, so the "30d" fragment is a
  // dead path. Reproduced, not deleted — it renders the moment a delta arrives.
  it('omits the 30d delta at 0 and renders it when one arrives (OQ-23)', async () => {
    const zero = await renderScreen({
      snapshot: snapshot({
        net_worth: { total: 12_000, assets: 15_000, liabilities: 3_000, delta_1d: 0, delta_30d: 0 },
      }),
    });
    // "last 30d" belongs to SpendHero — the net-worth line is the one under test.
    expect(zero.has('$12,000 · assets $15,000 · owed $3,000')).toBe(true);
    expect(zero.lines.some((l) => /owed .* 30d$/.test(l))).toBe(false);

    const moved = await renderScreen({
      snapshot: snapshot({
        net_worth: { total: 12_000, assets: 15_000, liabilities: 3_000, delta_1d: 0, delta_30d: 500 },
      }),
    });
    expect(moved.has('$12,000 · assets $15,000 · owed $3,000 · +$500 30d')).toBe(true);

    const down = await renderScreen({
      snapshot: snapshot({
        net_worth: { total: 12_000, assets: 15_000, liabilities: 3_000, delta_1d: 0, delta_30d: -500 },
      }),
    });
    expect(down.has('$12,000 · assets $15,000 · owed $3,000 · −$500 30d')).toBe(true);
  });

  // OQ-22: fmtUsd floors at `$0` for anything ≤ 0, and net worth reaches it
  // unguarded — a net-negative estate reads as $0. Reproduced, not fixed.
  it('prints a negative net worth as $0 (OQ-22)', async () => {
    const v = await renderScreen({
      snapshot: snapshot({
        net_worth: { total: -4_000, assets: 1_000, liabilities: 5_000, delta_1d: 0, delta_30d: 0 },
      }),
    });
    expect(v.has('$0 · assets $1,000 · owed $5,000')).toBe(true);
  });

  it('drops the net-worth row when the snapshot has none', async () => {
    const v = await renderScreen({ snapshot: snapshot() });
    expect(v.has('net worth')).toBe(false);
    expect(v.has('copilot')).toBe(true);
  });
});
