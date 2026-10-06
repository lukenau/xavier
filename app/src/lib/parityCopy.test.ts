// The copy gate for docs/PARITY-INVENTORY.md §2.
//
// Task 24 swept every surface's strings against the inventory. This file keeps
// the result: one assertion per inventory item whose copy is produced by a pure
// function, so a later edit to any of those sentences fails here with the item
// id that governs it rather than somewhere in a screen's own suite.
//
// Rules this file follows, and why:
//   • Pure modules only — no component is mounted. SkeletonCard's pulse and the
//     refresh spinner are `Animated.loop`s (shell/motion.ts:62); a test that
//     mounts either without unmounting hangs the whole jest run.
//   • The literal is spelled out here. Importing the constant that produces it
//     would make the assertion tautological, which is the one thing a copy gate
//     must not be.
//   • Where the inventory and apps/hub disagree, the PWA CODE wins and the
//     assertion follows the code; those cases carry a comment saying so.
import { fmtUsd, fmtTokens, shortModel } from '../shared/seriesColors';
import { relTime } from '../shared/time';
import { GATE_NOT_WIRED_MESSAGE } from './api';
import {
  bucketHeaderLabel,
  cacheSummaryLine,
  creditsMetersLine,
  creditsUsedLine,
  cronCostLabel,
  cronScriptFooter,
  deltaChipParts,
  heroTokensLine,
  modelMetaLine,
  rangeLabel,
  unpricedDetail,
  unpricedHeadline,
} from '../components/finance/costModel';
import { backupSubLine, unreachableHostLine, attachSnippet, writeErrorMessage } from '../components/ops/opsFormat';
import { decisionsBannerView } from '../components/home/homeState';
import type { Decision } from './types';
import type { SpendSummary } from './types';

describe('MONEY-12 — fmtUsd / fmtTokens, including the $0 negative rule', () => {
  test('the four bands', () => {
    expect(fmtUsd(1234.56)).toBe('$1,235');
    expect(fmtUsd(12.5)).toBe('$12.50');
    expect(fmtUsd(0.004)).toBe('$0.004');
  });

  test('anything at or below zero prints $0 — negatives never show a sign', () => {
    // The inventory calls this out because a caller that forgets to abs() gets
    // a silently wrong figure rather than a visible "-$4".
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(-4.2)).toBe('$0');
  });

  test('fmtTokens B / M / k', () => {
    expect(fmtTokens(2_400_000_000)).toBe('2.4B');
    expect(fmtTokens(3_200_000)).toBe('3.2M');
    // k is ROUNDED, not one decimal — the inventory's "B/M/k" hides that.
    expect(fmtTokens(4_800)).toBe('5k');
    expect(fmtTokens(999)).toBe('999');
  });
});

describe('COST-01/02/03 — window, hero, unpriced', () => {
  const summary = (over: Partial<SpendSummary> = {}) =>
    ({
      total_usd: 12.5,
      range: { start: '2026-09-04T00:00:00-04:00', end: '2026-09-11T00:00:00-04:00' },
      prev_range: null,
      delta_pct: null,
      models: [],
      by_provider: {},
      tokens: { input: 1000, output: 2000, cache_read: 0, cache_write: 0 },
      sessions: 3,
      cache: { read_tokens: 0, saved_usd: 0, saved_pct: 0, would_have_cost_usd: 0 },
      unpriced: [],
      ...over,
    }) as SpendSummary;

  test('COST-01 range line uses an en dash with spaces', () => {
    expect(rangeLabel(summary())).toBe('Sep 4 – Sep 11');
    expect(rangeLabel(undefined)).toBe(' ');
  });

  test('COST-02 delta chip: spend up wears the DOWN colour, and the arrow is U+2191', () => {
    const up = deltaChipParts(25, { start: '2026-09-10T00:00:00-04:00', end: '2026-09-10T23:59:59-04:00' });
    expect(up).toEqual({ direction: 'up', arrow: '↑', text: '↑ 25% vs Sep 10' });
    const down = deltaChipParts(-25, { start: '2026-09-08T00:00:00-04:00', end: '2026-09-10T00:00:00-04:00' });
    // Two-day label joins with an en dash and NO spaces — unlike the range line.
    expect(down?.text).toBe('↓ 25% vs Sep 8–Sep 10');
    expect(deltaChipParts(0.01, { start: 'a', end: 'a' })?.arrow).toBe('→');
    expect(deltaChipParts(25, null)).toBeNull();
  });

  test('COST-02 tokens line, and the $/hr tail only on the today window', () => {
    expect(heroTokensLine(summary(), '7d')).toBe('3 sessions · 1k in · 2k out');
    expect(heroTokensLine(summary({ sessions: 1 }), '7d')).toBe('1 session · 1k in · 2k out');
    // A null session count is an en dash (U+2013), not a zero. `SpendSummary`
    // types `sessions` as non-null, so the cast is what the PWA's own `?? '–'`
    // is defending against — the server has sent null here.
    expect(heroTokensLine({ ...summary(), sessions: null } as unknown as SpendSummary, '7d')).toBe(
      '– sessions · 1k in · 2k out',
    );
    expect(heroTokensLine(summary(), 'today')).toMatch(/ · \$[\d.,]+\/hr$/);
  });

  test('COST-03 unpriced copy, and the token filter that suppresses the live noise row', () => {
    expect(unpricedHeadline(1)).toBe('1 model unpriced — spend not counted');
    expect(unpricedHeadline(2)).toBe('2 models unpriced — spend not counted');
    expect(unpricedDetail([{ model: 'openai/gpt-5', input: 900, output: 100, cache_read: 0 }])).toBe(
      'gpt-5 (1k tok)',
    );
  });
});

describe('COST-04/05/08/10/11 — the account cards, bucket labels, rows', () => {
  test('COST-04 prepaid line, with the low-balance tail', () => {
    expect(creditsUsedLine({ total_credits: 120, total_usage: 88.4, balance: 31.6 } as never)).toBe(
      'used $88.40 of $120 prepaid',
    );
    expect(creditsUsedLine({ total_credits: 120, total_usage: 115, balance: 5 } as never)).toBe(
      'used $115 of $120 prepaid — running low, top up',
    );
    expect(creditsMetersLine({ usage_daily: 1.5, usage_monthly: 40 } as never)).toBe(
      '$1.50 today · $40.00 this month',
    );
    expect(creditsMetersLine({ usage_daily: 1.5, usage_monthly: null } as never)).toBeNull();
  });

  test('COST-05 prompt-cache sentence', () => {
    expect(
      cacheSummaryLine({ read_tokens: 1000, saved_usd: 2, saved_pct: 40, would_have_cost_usd: 5 }, 3),
    ).toBe('would have cost $5.00 → paid $3.00 (40% off)');
  });

  test('COST-08 bucket labels, and the weekday that leads ONLY a day axis', () => {
    expect(bucketHeaderLabel('2026-09-09', 'day', 3)).toBe('Wed Sep 9');
    expect(bucketHeaderLabel('2026-09-09T13:00', 'hour', 3)).toBe('1p');
    expect(bucketHeaderLabel('2026-09-09T00:00', 'hour', 3)).toBe('Wed 12a');
  });

  test('COST-10 model row meta line', () => {
    expect(
      modelMetaLine(
        { model: 'anthropic/claude-opus-5', sessions: 4, input: 1000, output: 2000, cache_read: 500, total_spend: 25 } as never,
        50,
      ),
    ).toBe('50% · 4 sess · 1k in · 2k out · 500 cached');
    // shortModel strips the vendor AND a leading `claude-`.
    expect(shortModel('anthropic/claude-opus-5')).toBe('opus-5');
    expect(shortModel('openai/gpt-5')).toBe('gpt-5');
  });

  test('COST-11 scheduled jobs: "cost unknown" is never rendered as $0.00', () => {
    expect(cronCostLabel({ cost_usd: 0, unknown_runs: 3 } as never)).toBe('cost unknown');
    expect(cronCostLabel({ cost_usd: 0, unknown_runs: 0 } as never)).toBe('$0');
    expect(cronScriptFooter(1)).toBe('+ 1 script job · $0 LLM · no model');
    expect(cronScriptFooter(4)).toBe('+ 4 script jobs · $0 LLM · no model');
  });
});

describe('OPS-04/08/10 — ops copy', () => {
  test('OPS-08 backup sub-line reports only what the server sends', () => {
    // Fictional fixture values — never the author's real bucket or size.
    expect(backupSubLine({ repo: 'b2:example-bucket', total_size_gb: 12.5 } as never)).toBe(
      'b2:example-bucket · 12.5 GB',
    );
  });

  test('OPS-04 an unreachable host says so, and asks the obvious question', () => {
    expect(unreachableHostLine('MacBook', 'timed out')).toBe('MacBook unreachable — timed out. Asleep?');
    // hub-tmuxd normally supplies the snippet; this is the client fallback, and
    // it is switch-client (the shell is already inside tmux), never attach.
    expect(attachSnippet(undefined, 'claude-x')).toBe('tmux switch-client -t claude-x');
    expect(attachSnippet('tmux a -t x', 'claude-x')).toBe('tmux a -t x');
  });

  test('OPS-10 a cancelled Face ID is silent; everything else surfaces its own message', () => {
    expect(writeErrorMessage(new Error('boom'))).toBe('boom');
    expect(writeErrorMessage(null)).toBe('Write failed.');
    // The gate's own no-signer copy reaches the screens through this mapper.
    expect(writeErrorMessage(new Error(GATE_NOT_WIRED_MESSAGE))).toBe(GATE_NOT_WIRED_MESSAGE);
  });
});

describe('HOME-06 / SHELL-22 — the banner headline and the one relative clock', () => {
  const decision = (category: string): Decision =>
    ({ id: category, category, title: 't', created: 0 }) as unknown as Decision;

  test('HOME-06 headline is stakes-honest, never a flat count', () => {
    expect(decisionsBannerView([decision('required')])?.headline).toBe('1 needs your answer');
    expect(
      decisionsBannerView([
        decision('required'),
        decision('required'),
        decision('tradeoff'),
        decision('info'),
        decision('frozen'),
      ])?.headline,
    ).toBe('2 need your answer · 1 your call · 1 for later · 1 frozen');
    expect(decisionsBannerView([])).toBeNull();
  });

  test('SHELL-22 relTime exact strings, including the 86 400 s boundary', () => {
    const now = Date.UTC(2026, 8, 11, 12, 0, 0);
    expect(relTime(now - 5_000, now)).toBe('just now');
    expect(relTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relTime(now - 5 * 3_600_000, now)).toBe('5h ago');
    expect(relTime(now + 30_000, now)).toBe('in a moment');
    expect(relTime(now + 5 * 60_000, now)).toBe('in 5m');
  });
});
