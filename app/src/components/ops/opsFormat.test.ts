// Row-derivation parity for the Ops route: each expectation is the string the
// PWA's own expression produces for the same input (apps/hub/src/routes/Ops.tsx).
import { ApplyError, GateNotWiredError, GATE_NOT_WIRED_MESSAGE } from '../../lib/api';
import {
  attachSnippet,
  backupSubLine,
  boardLine,
  jobDotToken,
  jobMeta,
  lastRunCostLine,
  pastSessionMeta,
  sessionMeta,
  sessionRowHasBorder,
  shellMeta,
  sourceBadgeTone,
  unreachableHostLine,
  weekCostLabel,
  writeErrorMessage,
} from './opsFormat';
import type { AgentSession, CronJob, TmuxPastSession, TmuxSession } from '../../lib/types';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const TEN_MIN_AGO = NOW / 1000 - 600;

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    source: 'telegram',
    model: null,
    title: 'Morning brief',
    message_count: 12,
    tool_call_count: 0,
    total_tokens: null,
    estimated_cost_usd: null,
    started_at: null,
    last_active: TEN_MIN_AGO,
    preview: null,
    ...over,
  };
}

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'daily-brief',
    name: 'Daily Briefing',
    schedule: '30 7 * * 1-5',
    repeat: null,
    next_run_at: '2026-09-11 07:30',
    deliver: 'telegram',
    mode: 'agent',
    script: null,
    last_run: '2026-09-10 07:30',
    state: 'active',
    active: true,
    cost: null,
    ...over,
  };
}

function shell(over: Partial<TmuxSession> = {}): TmuxSession {
  return {
    name: 'claude-abc',
    created: TEN_MIN_AGO,
    attached: false,
    windows: 2,
    protected: false,
    host: 'vps',
    title: null,
    session_id: null,
    ...over,
  };
}

describe('writeErrorMessage (Ops.tsx:43-48)', () => {
  test('a cancelled gate is silent', () => {
    expect(writeErrorMessage(new ApplyError('cancelled', 'User cancelled'))).toBeNull();
    expect(writeErrorMessage(new GateNotWiredError('cancelled'))).toBeNull();
  });

  test('every other ApplyError code surfaces its message', () => {
    expect(writeErrorMessage(new ApplyError('bridge_error', 'cron run failed'))).toBe(
      'cron run failed',
    );
  });

  test('a gate with no signer surfaces its message rather than failing silently', () => {
    // api.applyWrite POSTs /action/challenge and then throws GateNotWiredError
    // (code 'unknown') from the assertion step when installGateSigner never ran.
    expect(writeErrorMessage(new GateNotWiredError())).toBe(GATE_NOT_WIRED_MESSAGE);
  });

  test('a plain Error passes through; anything else gets the generic copy', () => {
    expect(writeErrorMessage(new Error('boom'))).toBe('boom');
    expect(writeErrorMessage({ nope: true })).toBe('Write failed.');
  });
});

describe('sessions', () => {
  test('meta joins relTime, message count and cost', () => {
    expect(sessionMeta(session(), NOW)).toBe('10m ago · 12 msgs');
    expect(sessionMeta(session({ estimated_cost_usd: 1.5 }), NOW)).toBe('10m ago · 12 msgs · $1.50');
  });

  test('a zero cost still renders (0 != null)', () => {
    expect(sessionMeta(session({ estimated_cost_usd: 0 }), NOW)).toBe('10m ago · 12 msgs · $0.00');
  });

  test('only discord gets the accent badge', () => {
    expect(sourceBadgeTone('discord')).toEqual({ bg: 'accent-soft', border: 'accent-border', fg: 'accent' });
    expect(sourceBadgeTone('telegram')).toEqual({ bg: 'bg-2', border: 'border', fg: 'fg-3' });
  });

  test('the last visible row keeps its border while rows are hidden (Ops.tsx:228)', () => {
    // 8 of 8 shown: the last row has no border.
    expect(sessionRowHasBorder(7, 8, 8)).toBe(false);
    // 8 of 20 shown: the last VISIBLE row keeps its border.
    expect(sessionRowHasBorder(7, 8, 20)).toBe(true);
    // expanded to all 20: the last row loses it again only when total <= 8,
    // so a fully expanded long list still shows a trailing border.
    expect(sessionRowHasBorder(19, 20, 20)).toBe(true);
    expect(sessionRowHasBorder(0, 8, 8)).toBe(true);
  });
});

describe('cron jobs', () => {
  test('the dot is up only for an active job', () => {
    expect(jobDotToken(job())).toBe('status-up');
    expect(jobDotToken(job({ state: 'paused' }))).toBe('fg-4');
    expect(jobDotToken(job({ state: 'completed' }))).toBe('fg-4');
  });

  test('meta prefers schedule and falls back to repeat', () => {
    expect(jobMeta(job())).toBe('30 7 * * 1-5 · next 2026-09-11 07:30 · telegram');
    expect(jobMeta(job({ schedule: null, repeat: 'every 15m' }))).toBe(
      'every 15m · next 2026-09-11 07:30 · telegram',
    );
  });

  test('meta drops the pieces the server did not send', () => {
    expect(jobMeta(job({ schedule: null, repeat: null, next_run_at: null, deliver: null }))).toBe('');
  });

  test('script jobs get the fixed no-LLM line', () => {
    expect(lastRunCostLine(job({ mode: 'script' }))).toBe('last run: $0 LLM · no model');
  });

  test('no ledger cost at all hides the line', () => {
    expect(lastRunCostLine(job())).toBeNull();
    expect(lastRunCostLine(job({ cost: { last_run: null, week: { runs: 0, cost_usd: 0, unknown_runs: 0, tokens: 0, days: {} } } }))).toBeNull();
  });

  test('an unknown ledger cost says so — never $0.00', () => {
    const week = { runs: 0, cost_usd: 0, unknown_runs: 0, tokens: 0, days: {} };
    expect(
      lastRunCostLine(
        job({ cost: { last_run: { at: 1, cost_usd: null, cost_status: 'known', tokens: 1_200_000, model: 'deepseek/deepseek-v4-pro' }, week } }),
      ),
    ).toBe('last run: cost unknown · 1.2M tok · deepseek-v4-pro');
    expect(
      lastRunCostLine(
        job({ cost: { last_run: { at: 1, cost_usd: 0.08, cost_status: 'unknown', tokens: 900, model: null }, week } }),
      ),
    ).toBe('last run: cost unknown · 900 tok · no model');
  });

  test('a known cost formats through fmtUsd/fmtTokens/shortModel', () => {
    const week = { runs: 0, cost_usd: 0, unknown_runs: 0, tokens: 0, days: {} };
    expect(
      lastRunCostLine(
        job({ cost: { last_run: { at: 1, cost_usd: 0.08, cost_status: 'ok', tokens: 12_000, model: 'anthropic/claude-sonnet-4' }, week } }),
      ),
    ).toBe('last run: $0.08 · 12k tok · sonnet-4');
  });

  test('the weekly label omits a zero cost and counts unknown runs', () => {
    const mk = (week: { runs: number; cost_usd: number; unknown_runs: number }) =>
      job({ cost: { last_run: null, week: { ...week, tokens: 0, days: {} } } });
    expect(weekCostLabel(mk({ runs: 0, cost_usd: 5, unknown_runs: 0 }))).toBeNull();
    expect(weekCostLabel(mk({ runs: 1, cost_usd: 0, unknown_runs: 0 }))).toBe('7d: 1 run');
    expect(weekCostLabel(mk({ runs: 4, cost_usd: 0, unknown_runs: 2 }))).toBe('7d: 4 runs · 2 cost unknown');
    expect(weekCostLabel(mk({ runs: 4, cost_usd: 1.25, unknown_runs: 0 }))).toBe('7d: 4 runs · $1.25');
  });
});

describe('claude shells', () => {
  const label = (id: string) => (id === 'vps' ? 'VPS' : 'MacBook');

  test('an untitled single-host row', () => {
    expect(shellMeta(shell(), false, label, NOW)).toBe('detached · 2w · 10m ago');
  });

  test('a titled multi-host attached protected row', () => {
    expect(
      shellMeta(shell({ title: 'refactor', attached: true, protected: true, host: 'mac' }), true, label, NOW),
    ).toBe('claude-abc · MacBook · attached · 2w · 10m ago · protected');
  });

  test('past-session meta appends cwd and the live marker', () => {
    const past: TmuxPastSession = {
      host: 'vps',
      session_id: 'aaaaaaaa-bbbb',
      title: null,
      cwd: '/home/user/projects',
      last_active: TEN_MIN_AGO,
      live: true,
    };
    expect(pastSessionMeta(past, NOW)).toBe('10m ago · /home/user/projects · running');
    expect(pastSessionMeta({ ...past, cwd: null, live: false }, NOW)).toBe('10m ago');
  });

  test('a sleeping host reads as unreachable, with a fallback reason', () => {
    expect(unreachableHostLine('MacBook', 'ssh: connect timed out')).toBe(
      'MacBook unreachable — ssh: connect timed out. Asleep?',
    );
    expect(unreachableHostLine('MacBook', null)).toBe('MacBook unreachable — no response. Asleep?');
  });

  test('the attach snippet falls back to switch-client only when the daemon sent none', () => {
    expect(attachSnippet('tmux new-window -n mac:claude-x', 'claude-x')).toBe('tmux new-window -n mac:claude-x');
    expect(attachSnippet(undefined, 'claude-x')).toBe('tmux switch-client -t claude-x');
  });
});

describe('backups and board', () => {
  test('the sub line carries no schedule the server did not send', () => {
    // Fixtures are deliberately fictional: a real repo name and size must not
    // ship in this public repo.
    expect(backupSubLine({ rel_time: '4h ago', repo: 'b2:example-bucket', total_size_gb: 12.5 })).toBe(
      'b2:example-bucket · 12.5 GB',
    );
    expect(backupSubLine({ rel_time: 'unknown' })).toBe('repo unknown');
  });

  test('a schedule and append-only policy render only when the deployment reports them', () => {
    expect(
      backupSubLine({
        rel_time: '4h ago',
        repo: 's3:demo-bucket',
        total_size_gb: 1.5,
        schedule: 'weekly 02:00 UTC',
        append_only: true,
      }),
    ).toBe('s3:demo-bucket · 1.5 GB · weekly 02:00 UTC · append-only');
    // A deployment with no configured schedule says nothing about one.
    expect(backupSubLine({ rel_time: 'unknown', schedule: null, append_only: false })).toBe(
      'repo unknown',
    );
  });

  test('the board pulse is one joined line', () => {
    expect(boardLine([{ status: 'todo', count: 3 }, { status: 'done', count: 9 }])).toBe('todo 3 · done 9');
    expect(boardLine([])).toBe('');
  });
});
