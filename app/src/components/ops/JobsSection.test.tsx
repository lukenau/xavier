// Cron rows and the gated run/pause/resume sheet. Same rule as NeedsYou: the
// action goes through the real api.applyWrite, so the challenge POST is real
// and the gate's typed error is what the user sees.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';
import { JobsSection } from './JobsSection';
import type { CronJob, CronReport } from '../../lib/types';
import { GATE_NOT_WIRED_MESSAGE } from '../../lib/api';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const BASE = 'https://hub.example.com/api';

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

function fakeQuery(jobs: CronJob[]) {
  return {
    data: { generated_at: '', jobs, count: jobs.length } as CronReport,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  } as unknown as UseQueryResult<CronReport, Error>;
}

function render(jobs: CronJob[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <JobsSection q={fakeQuery(jobs)} />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  return { renderer, invalidate };
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).flatMap((n) => {
    const kids = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
    return kids.filter((c: unknown): c is string => typeof c === 'string');
  });
}

/** The nearest ancestor Pressable of the <Text> reading `label`. */
function pressableFor(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const text = renderer.root.findAll(
    (n) => n.type === Text && n.props.children === label,
  )[0];
  let node: TestRenderer.ReactTestInstance | null = text;
  while (node && node.props?.onPress === undefined) node = node.parent ?? null;
  if (!node) throw new Error(`no pressable ancestor for "${label}"`);
  return node;
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.resetAllMocks();
});

test('a job row opens the sheet with the PWA field set, and "Run now" is always offered', () => {
  const { renderer } = render([job()]);
  act(() => {
    pressableFor(renderer, 'Daily Briefing').props.onPress();
  });
  const t = texts(renderer);
  expect(t).toContain('Job');
  expect(t).toContain('Schedule');
  expect(t).toContain('Next run');
  expect(t).toContain('Deliver');
  expect(t).toContain('Mode');
  expect(t).toContain('State');
  expect(t).toContain('Last run');
  expect(t).toContain('Run now');
  // An active job offers Pause; a paused one offers Resume.
  expect(t).toContain('Pause');
});

test('a completed job gets no second button (only active/paused toggle)', () => {
  const { renderer } = render([job({ state: 'completed' })]);
  act(() => {
    pressableFor(renderer, 'Daily Briefing').props.onPress();
  });
  const t = texts(renderer);
  expect(t).toContain('Run now');
  expect(t).not.toContain('Pause');
  expect(t).not.toContain('Resume');
});

test('a paused job offers Resume', () => {
  const { renderer } = render([job({ state: 'paused' })]);
  act(() => {
    pressableFor(renderer, 'Daily Briefing').props.onPress();
  });
  expect(texts(renderer)).toContain('Resume');
});

test('"Run now" posts cron.run to /action/challenge and surfaces the gate error without invalidating', async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      challenge: 'Y2hhbGxlbmdl',
      rp_id: 'hub.example.com',
      user_verification: 'required',
      allowed_credentials: [],
      timeout_ms: 60000,
    }),
  });

  const { renderer, invalidate } = render([job()]);
  act(() => {
    pressableFor(renderer, 'Daily Briefing').props.onPress();
  });
  await act(async () => {
    await pressableFor(renderer, 'Run now').props.onPress();
  });

  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(`${BASE}/action/challenge`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: { action: 'cron.run', job_id: 'daily-brief' } }),
  });
  expect(invalidate).not.toHaveBeenCalled();
  const t = texts(renderer);
  expect(t).toContain(GATE_NOT_WIRED_MESSAGE);
  expect(t).not.toContain('applied · exit 0');
});

test('a 412 from the challenge endpoint surfaces the server copy, not the gate copy', async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: false,
    status: 412,
    json: async () => ({ detail: { code: 'no_passkey', detail: 'No passkey registered. Enrol in Settings first.' } }),
  });

  const { renderer } = render([job()]);
  act(() => {
    pressableFor(renderer, 'Daily Briefing').props.onPress();
  });
  await act(async () => {
    await pressableFor(renderer, 'Run now').props.onPress();
  });
  expect(texts(renderer)).toContain('No passkey registered. Enrol in Settings first.');
});
