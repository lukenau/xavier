import {
  discordDown,
  failedRunCount,
  isFailedRun,
  pickLastRun,
  ringColors,
  ringFade,
  RING_SIZE,
  RING_STOPS,
  RING_STROKE,
  shortModel,
  xavierState,
} from './xavierState';
import { dark, light } from '../../theme/tokens.gen';
import type { AgentSession, CronRun, PairingReport, Vitals } from '../../lib/types';

const NOW = Date.parse('2026-09-10T18:00:00Z');

function vitals(over: Partial<Vitals['agent']> = {}, rest: Partial<Vitals> = {}): Vitals {
  return {
    agent: {
      id: 'hermes',
      name: 'Xavier',
      status: 'up',
      model: null,
      gateway_state: 'running',
      discord_state: 'connected',
      busy: false,
      ...over,
    },
    containers: [],
    activity: { sessions: 3, turns: 12, tool_calls: 40, mcp_calls: 2 },
    spend: { today_usd: 1.5, mtd_usd: null, cap_usd: null },
    cron: { total: 24, next_label: '18:30 ops-watch' },
    updated_at: '',
    ...rest,
  };
}

const session = (over: Partial<AgentSession> = {}): AgentSession =>
  ({ source: 'cli', model: null, last_active: NOW / 1000 - 300, ...over }) as AgentSession;

const run = (over: Partial<CronRun> = {}): CronRun =>
  ({ job_id: 'j', name: 'job', run_time: null, mode: null, status: 'ok', output: '', truncated: false, ...over });

const pairing = (pending_count: number): PairingReport =>
  ({ pending: [], approved: [], pending_count, approved_count: 0 }) as PairingReport;

describe('model naming (XavierCard.tsx:9-12)', () => {
  test('strips only the two prefixes the PWA strips', () => {
    expect(shortModel('claude-opus-4-5')).toBe('opus-4-5');
    expect(shortModel('openai/gpt-5')).toBe('gpt-5');
    expect(shortModel('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat');
    expect(shortModel(null)).toBe('');
  });
});

describe('cron run selection (XavierCard.tsx:30-33)', () => {
  test('a failure anywhere beats a newer silent success', () => {
    const runs = [run({ name: 'newest', status: 'ok' }), run({ name: 'older', status: 'FAILED' })];
    expect(pickLastRun(runs)?.name).toBe('older');
  });

  test('otherwise the newest run carrying a status wins', () => {
    const runs = [run({ name: 'no status', status: null }), run({ name: 'has status', status: 'ok' })];
    expect(pickLastRun(runs)?.name).toBe('has status');
  });

  test('with no statuses at all it falls back to the first row', () => {
    const runs = [run({ name: 'first', status: null }), run({ name: 'second', status: null })];
    expect(pickLastRun(runs)?.name).toBe('first');
    expect(pickLastRun([])).toBeUndefined();
    expect(pickLastRun(undefined)).toBeUndefined();
  });

  test('"fail" and "error" both count, case-insensitively', () => {
    expect(isFailedRun(run({ status: 'Error: boom' }))).toBe(true);
    expect(isFailedRun(run({ status: 'failed' }))).toBe(true);
    expect(isFailedRun(run({ status: 'ok' }))).toBe(false);
    expect(isFailedRun(run({ status: null }))).toBe(false);
    expect(failedRunCount([run({ status: 'fail' }), run({ status: 'ok' }), run({ status: 'ERROR' })])).toBe(2);
    expect(failedRunCount(undefined)).toBe(0);
  });
});

describe('discord state (inventory OQ-4)', () => {
  test('anything but exactly "connected" is down once vitals has loaded', () => {
    expect(discordDown(undefined)).toBe(false);
    expect(discordDown(vitals({ discord_state: 'connected' }))).toBe(false);
    expect(discordDown(vitals({ discord_state: null }))).toBe(true);
    expect(discordDown(vitals({ discord_state: 'reconnecting' }))).toBe(true);
  });
});

describe('liveness state → ring colour and presence (XavierCard.tsx:40-51)', () => {
  test('gateway down is red and says so, even while Discord is fine', () => {
    const s = xavierState(vitals({ status: 'down' }), [session()], undefined, undefined, NOW);
    expect(s.ring).toBe('status-down');
    expect(s.presence).toBe('gateway unreachable');
  });

  test('Discord down is amber — it runs, it just cannot hear the user', () => {
    const s = xavierState(vitals({ discord_state: null }), [session()], undefined, undefined, NOW);
    expect(s.ring).toBe('status-warn');
    expect(s.presence).toBe('Discord disconnected — gateway up');
  });

  test('Discord down outranks busy — the broken thing is what the user needs to see', () => {
    const s = xavierState(
      vitals({ busy: true, discord_state: null }),
      [session()],
      undefined,
      undefined,
      NOW,
    );
    expect(s.presence).toBe('Discord disconnected — gateway up');
    expect(s.ring).toBe('status-warn');
  });

  test('busy beats a recent session', () => {
    const s = xavierState(vitals({ busy: true }), [session()], undefined, undefined, NOW);
    expect(s.ring).toBe('status-up');
    expect(s.busy).toBe(true);
    expect(s.presence).toBe('working right now');
  });

  test('idle with a session reports when, from where, and on what', () => {
    const s = xavierState(
      vitals(),
      [session({ source: 'discord', model: 'claude-opus-4-5' })],
      undefined,
      undefined,
      NOW,
    );
    expect(s.presence).toBe('active 5m ago · discord · opus-4-5');
  });

  test('a session with no model drops the model clause entirely', () => {
    const s = xavierState(vitals(), [session({ source: 'cli' })], undefined, undefined, NOW);
    expect(s.presence).toBe('active 5m ago · cli');
  });

  test('no sessions at all is idle, and unknown status is amber', () => {
    const s = xavierState(vitals({ status: 'unknown' }), [], undefined, undefined, NOW);
    expect(s.ring).toBe('status-warn');
    expect(s.presence).toBe('idle · no recent sessions');
  });

  test('no vitals at all: unknown, amber, and en-dashes rather than zeros', () => {
    const s = xavierState(undefined, undefined, undefined, undefined, NOW);
    expect(s).toMatchObject({ status: 'unknown', ring: 'status-warn', name: 'Xavier' });
    expect(s.todayLine).toBe('– sessions · – turns · – tools');
  });
});

describe('the today line and the needs-you strip', () => {
  test('spend is appended only when the gateway reported one', () => {
    expect(xavierState(vitals(), [], undefined, undefined, NOW).todayLine).toBe(
      '3 sessions · 12 turns · 40 tools · $1.50',
    );
    const noSpend = vitals({}, { spend: { today_usd: null, mtd_usd: null, cap_usd: null } });
    expect(xavierState(noSpend, [], undefined, undefined, NOW).todayLine).toBe(
      '3 sessions · 12 turns · 40 tools',
    );
  });

  test('needs-you counts pairings plus failed runs, and names what it is', () => {
    const runs = [run({ status: 'FAILED' }), run({ status: 'ok' })];
    expect(xavierState(vitals(), [], pairing(2), runs, NOW)).toMatchObject({
      needsYou: 3,
      needsYouDetail: 'pairing + failed runs →',
    });
    expect(xavierState(vitals(), [], pairing(2), [], NOW)).toMatchObject({
      needsYou: 2,
      needsYouDetail: 'pairing approval →',
    });
    expect(xavierState(vitals(), [], pairing(0), runs, NOW)).toMatchObject({
      needsYou: 1,
      needsYouDetail: 'failed cron runs →',
    });
    expect(xavierState(vitals(), [], undefined, [], NOW).needsYou).toBe(0);
  });

  test('the last-run row knows whether it is reporting a failure', () => {
    expect(xavierState(vitals(), [], undefined, [run({ status: 'FAILED' })], NOW).lastRunFailed).toBe(true);
    expect(xavierState(vitals(), [], undefined, [run({ status: 'ok' })], NOW).lastRunFailed).toBe(false);
  });
});

describe('ring geometry and gradient stops (theme.md §5.3)', () => {
  test('the annulus matches the CSS mask: 46px avatar, -4px inset, 2.5px stroke', () => {
    expect(RING_SIZE).toBe(54);
    expect((RING_SIZE - RING_STROKE) / 2 + RING_STROKE / 2).toBe(27); // outer edge = the span's edge
  });

  test('the sweep reproduces `transparent 8%, ring 42%, transparent 78%`', () => {
    expect(RING_STOPS).toEqual([0, 0.08, 0.42, 0.78, 1]);
    // theme-exempt: gradient-stop arithmetic on a sample colour, not a theme
    // choice — the test asserts the alpha channel appended to whatever the
    // ring token resolves to.
    expect(ringColors('#4ade80')).toEqual(['#4ade8000', '#4ade8000', '#4ade80', '#4ade8000', '#4ade8000']);
  });

  test('every colour the ring can take is a plain hex, so the fade never needs the keyword', () => {
    for (const table of [dark, light]) {
      for (const token of ['status-up', 'status-warn', 'status-down'] as const) {
        expect(table[token]).toMatch(/^#[0-9a-f]{6}$/i);
        expect(ringFade(table[token])).toBe(`${table[token]}00`);
      }
    }
  });

  test('a non-hex colour still fades rather than painting an opaque ring', () => {
    // theme-exempt: an input the parser must reject, not a colour to render.
    expect(ringFade('rgba(1, 2, 3, 0.4)')).toBe('transparent');
  });
});
