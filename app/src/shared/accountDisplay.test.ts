// Account names and colour pins are the user's own configuration: nothing ships
// in the source, a malformed value costs the user their preferences rather than
// the Money tab, and a configured value reaches every place an account is named.
import { NO_ACCOUNT_DISPLAY, lookup, parseAccountDisplay, type AccountDisplay } from './accountDisplay';
import { ACCOUNT_PALETTE, buildFlows, cleanInstitution, type FinanceAccount, type FinanceSnapshotFull } from './financeModel';
import { chartNames } from './sankeyLayout';
import type { FinanceTxn } from '../lib/types';

const card = (last4: string, over: Partial<FinanceAccount> = {}): FinanceAccount => ({
  name: 'CREDIT CARD',
  institution: 'Example Bank',
  last4,
  type: 'credit card',
  balance: -100,
  currency: 'USD',
  source: 'plaid',
  id: `acct-${last4}`,
  asof: '2026-01-15T08:00:00Z',
  ...over,
});

const spend = (last4: string, amount: number): FinanceTxn => ({
  date: '2026-01-15',
  merchant: 'Example Store',
  amount,
  category: 'Shopping',
  account_last4: last4,
  pending: false,
  source: 'plaid',
});

// Three cards from one issuer, all named "CREDIT CARD" — the case nicknames exist for.
const SNAP: FinanceSnapshotFull = {
  schema_version: 3,
  asof: '2026-01-15T12:00:00Z',
  sources: { copilot_mcp: { status: 'ok' }, plaid: { status: 'ok' } },
  spend_windows: { today: 0, last_7d: 0, last_30d: 0, top_categories: [] },
  spend: [],
  accounts: [card('0001'), card('0002'), card('0003')],
  recent_transactions: [spend('0001', 300), spend('0002', 200), spend('0003', 100)],
};

const CONFIG: AccountDisplay = {
  nicknames: { '0001': 'Example Bank Travel', '0002': 'Groceries card' },
  last4Colors: { '0001': 'series-5' },
  institutionColors: { 'Example Bank': 'series-2' },
  institutions: ['Example Bank'],
};

describe('parseAccountDisplay', () => {
  test('unset or blank is the empty config', () => {
    expect(parseAccountDisplay(undefined)).toEqual(NO_ACCOUNT_DISPLAY);
    expect(parseAccountDisplay('  ')).toEqual(NO_ACCOUNT_DISPLAY);
    expect(NO_ACCOUNT_DISPLAY).toEqual({ nicknames: {}, last4Colors: {}, institutionColors: {}, institutions: [] });
  });

  test('reads every field, trimmed', () => {
    expect(
      parseAccountDisplay(
        JSON.stringify({
          nicknames: { '0001': ' Example Bank Travel ' },
          last4Colors: { '0001': 'series-5' },
          institutionColors: { 'Example Bank': 'series-2' },
          institutions: [' Example Bank '],
        }),
      ),
    ).toEqual({
      nicknames: { '0001': 'Example Bank Travel' },
      last4Colors: { '0001': 'series-5' },
      institutionColors: { 'Example Bank': 'series-2' },
      institutions: ['Example Bank'],
    });
  });

  test('a colour that is not a theme token is dropped, with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const parsed = parseAccountDisplay(
        JSON.stringify({ last4Colors: { '0001': 'series-99', '0002': 'toString', '0003': 'series-1' } }),
      );
      expect(parsed.last4Colors).toEqual({ '0003': 'series-1' });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('malformed input is the empty config, never a throw', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseAccountDisplay('{not json')).toEqual(NO_ACCOUNT_DISPLAY);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(parseAccountDisplay('[1, 2]')).toEqual(NO_ACCOUNT_DISPLAY);
      expect(parseAccountDisplay('"a string"')).toEqual(NO_ACCOUNT_DISPLAY);
      expect(parseAccountDisplay(JSON.stringify({ nicknames: ['x'], institutions: 'Example Bank' }))).toEqual(
        NO_ACCOUNT_DISPLAY,
      );
      expect(parseAccountDisplay(JSON.stringify({ nicknames: { '0001': 42, '0002': '' } })).nicknames).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  test('a lookup never resolves to something on Object.prototype', () => {
    expect(lookup({}, 'constructor')).toBeUndefined();
    expect(lookup({ '0001': 'Travel' }, '0001')).toBe('Travel');
  });
});

describe('with no configuration', () => {
  const flows = buildFlows(SNAP, NO_ACCOUNT_DISPLAY);

  test('three same-named cards fall back to the mask, and nothing carries a nickname', () => {
    expect(flows.accounts.map((f) => f.label)).toEqual([
      'Example Bank Credit Card …0001',
      'Example Bank Credit Card …0002',
      'Example Bank Credit Card …0003',
    ]);
    expect(flows.accounts.some((f) => f.nickname !== undefined)).toBe(false);
  });

  test('colours fill from the palette in flow-rank order', () => {
    expect(flows.accounts.map((f) => f.color)).toEqual(ACCOUNT_PALETTE.slice(0, 3));
  });

  test('a truncated institution stays as it came', () => {
    expect(cleanInstitution('Example Ba', NO_ACCOUNT_DISPLAY.institutions)).toBe('Example Ba');
  });
});

describe('with the user’s configuration', () => {
  const flows = buildFlows(SNAP, CONFIG);
  const byLast4 = (k: string) => flows.byLast4.get(k)!;

  test('a nickname names the account in lists and travels with it to the chart', () => {
    expect(byLast4('0001')).toMatchObject({ label: 'Example Bank Travel', nickname: 'Example Bank Travel' });
    expect(byLast4('0002')).toMatchObject({ label: 'Groceries card', nickname: 'Groceries card' });
    expect(byLast4('0003').nickname).toBeUndefined();
  });

  test('an account pin beats its institution pin; the institution pin covers the rest', () => {
    expect(byLast4('0001').color).toBe('series-5');
    expect(byLast4('0002').color).toBe('series-2');
    expect(byLast4('0003').color).toBe('series-2');
  });

  test('an unpinned account skips every pinned colour', () => {
    const other = buildFlows(
      {
        ...SNAP,
        accounts: [...SNAP.accounts!, card('0004', { institution: 'Sample Credit' })],
        recent_transactions: [...SNAP.recent_transactions, spend('0004', 50)],
      },
      CONFIG,
    );
    const color = other.byLast4.get('0004')!.color;
    expect(['series-5', 'series-2']).not.toContain(color);
    expect(ACCOUNT_PALETTE).toContain(color);
  });

  test('a truncated institution snaps back to a listed one', () => {
    expect(cleanInstitution('Example Ba', CONFIG.institutions)).toBe('Example Bank');
  });

  test('the chart drops a leading institution from a nickname for its short form', () => {
    const names = chartNames([byLast4('0001'), byLast4('0002'), byLast4('0003')]);
    expect(names.get('0001')).toEqual({ full: 'Example Bank Travel', alt: 'Travel' });
    expect(names.get('0002')).toEqual({ full: 'Groceries card', alt: 'Groceries card' });
    // Unnamed, and the issuer's own name separates nothing: the institution it is.
    expect(names.get('0003')).toEqual({ full: 'Example Bank', alt: 'Example Bank' });
  });
});
