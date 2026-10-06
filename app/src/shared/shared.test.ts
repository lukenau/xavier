// Behavioural pins for the verbatim PWA copies. check-shared-parity.mjs proves
// the text matches; these prove the behaviour the app depends on, including the
// quirks the port is required to reproduce rather than fix.
import { deriveTxnType, TXN_COLORS, isInflowType, accountClass } from './financeModel';
import { fmtUsd, fmtTokens, providerColor, OTHER_COLOR } from './seriesColors';
import { relTime, toMs, dateLabel } from './time';
import { dark } from '../theme/tokens.gen';

describe('fmtUsd — reproduces the PWA exactly, quirks included', () => {
  test('prints $0 for zero AND for every negative (documented quirk, not a bug to fix)', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(-3)).toBe('$0');
    expect(fmtUsd(-1284.5)).toBe('$0');
  });

  test('switches format by magnitude', () => {
    expect(fmtUsd(0.004)).toBe('$0.004');
    expect(fmtUsd(0.05)).toBe('$0.05');
    expect(fmtUsd(1)).toBe('$1.00');
    expect(fmtUsd(99.994)).toBe('$99.99');
    expect(fmtUsd(100)).toBe('$100');
    expect(fmtUsd(1284.5)).toBe('$1,285');
  });
});

describe('fmtTokens', () => {
  test('scales at each threshold', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1_000)).toBe('1k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
    expect(fmtTokens(2_000_000_000)).toBe('2.0B');
  });
});

describe('toMs — the UTC quirk the estate depends on', () => {
  test('an offset-less datetime is read as UTC, not local', () => {
    expect(toMs('2026-09-09T12:00:00')).toBe(Date.parse('2026-09-09T12:00:00Z'));
    expect(toMs('2026-09-09 12:00:00')).toBe(Date.parse('2026-09-09T12:00:00Z'));
  });

  test('an explicit offset is honoured', () => {
    expect(toMs('2026-09-09T12:00:00Z')).toBe(Date.parse('2026-09-09T12:00:00Z'));
  });

  test('numbers are seconds unless clearly milliseconds', () => {
    expect(toMs(1_757_000_000)).toBe(1_757_000_000_000);
    expect(toMs(1_757_000_000_000)).toBe(1_757_000_000_000);
  });

  test('junk and null yield null', () => {
    expect(toMs(null)).toBeNull();
    expect(toMs('not a date')).toBeNull();
    expect(toMs(Number.NaN)).toBeNull();
  });
});

describe('relTime', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');

  test('recent stamps stay bare', () => {
    expect(relTime('2026-09-09T11:59:30Z', now)).toBe('just now');
    expect(relTime('2026-09-09T11:30:00Z', now)).toBe('30m ago');
    expect(relTime('2026-09-09T06:00:00Z', now)).toBe('6h ago');
  });

  test('day-scale stamps carry the date as well', () => {
    const out = relTime('2026-09-06T12:00:00Z', now);
    expect(out).toContain('3d ago');
    expect(out).toContain(dateLabel(Date.parse('2026-09-06T12:00:00Z'), now));
  });

  test('future stamps read forwards rather than collapsing to "just now"', () => {
    expect(relTime('2026-09-09T12:00:30Z', now)).toBe('in a moment');
    expect(relTime('2026-09-09T12:20:00Z', now)).toBe('in 20m');
    expect(relTime('2026-09-09T16:00:00Z', now)).toBe('in 4h');
  });

  test('an unparseable stamp renders as empty string, never "Invalid Date"', () => {
    expect(relTime(null, now)).toBe('');
    expect(relTime('nonsense', now)).toBe('');
  });
});

describe('deriveTxnType — the cascade order is the contract', () => {
  const txn = (o: Partial<Parameters<typeof deriveTxnType>[0]>) =>
    deriveTxnType({ merchant: '', category: '', amount: 10, source: 'plaid', kind: null, ...o });

  test('an explicit income kind wins over everything', () => {
    expect(txn({ kind: 'income', category: 'transfer' })).toBe('income');
  });

  test('BNPL merchants are spend, checked BEFORE the payment rule', () => {
    // The deliberate divergence from the producer's Python classifier.
    expect(txn({ merchant: 'Affirm', category: 'credit card payment' })).toBe('spend');
  });

  test('category cascade: payment, interest, refund, fee, transfer', () => {
    expect(txn({ category: 'credit card payment' })).toBe('payment');
    expect(txn({ category: 'interest charged' })).toBe('interest');
    expect(txn({ category: 'refund' })).toBe('refund');
    expect(txn({ category: 'service charge' })).toBe('fee');
    expect(txn({ category: 'transfer' })).toBe('transfer');
    expect(txn({ merchant: 'Zelle' })).toBe('transfer');
  });

  test('an unlabelled credit is income from plaid but a refund from copilot', () => {
    expect(txn({ amount: -20, source: 'plaid' })).toBe('income');
    expect(txn({ amount: -20, source: 'copilot' })).toBe('refund');
  });

  test('anything left over is spend', () => {
    expect(txn({ merchant: 'Some Cafe', amount: 12 })).toBe('spend');
  });
});

describe('token references survive the PARITY-SHIM rewrite', () => {
  test('colour constants carry bare token names that exist in the token table', () => {
    expect(OTHER_COLOR).toBe('series-other');
    expect(OTHER_COLOR in dark).toBe(true);
    expect(providerColor('anthropic') in dark).toBe(true);
    expect(providerColor('nobody-in-particular') in dark).toBe(true);
    for (const pair of Object.values(TXN_COLORS)) {
      expect(pair.fg in dark).toBe(true);
      expect(pair.bg in dark).toBe(true);
    }
  });

  test('no shared colour constant leaked a raw var() or hex', () => {
    for (const pair of Object.values(TXN_COLORS)) {
      expect(pair.fg).not.toMatch(/var\(|#/);
      expect(pair.bg).not.toMatch(/var\(|#/);
    }
  });
});

describe('account and flow helpers', () => {
  test('inflow types are the money-in half of the ledger', () => {
    expect(isInflowType('income')).toBe(true);
    expect(isInflowType('refund')).toBe(true);
    expect(isInflowType('spend')).toBe(false);
  });

  test('account types map onto the three classes the Sankey bands use', () => {
    expect(accountClass('credit')).toBe('credit');
    expect(accountClass('depository')).toBe('cash');
    expect(accountClass('investment')).toBe('investment');
  });
});
