// The Automations tab against live-shaped data: jobs land in the section the
// server gave them, the quiet ones stay folded until asked for, and a row opens
// the screen for the thing it names.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { AutomationJob, RunSummary, TimelineResponse } from '../../automations/types';
import AutomationsScreen from './AutomationsScreen';
import { JobSurface } from './JobScreen';
import { RunCard, runAsMessage } from './RunScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args), dismissTo: jest.fn() },
  useIsFocused: () => true,
  useScrollToTop: () => {},
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(cb, [cb]);
  },
}));
jest.mock('../chat/ChatLockGate', () => ({
  ChatLockGate: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../chat/hooks', () => ({ useRelockOn401: () => {} }));
// The run screen hands off to the chat's own thread surface, which has its own
// suites and pulls in the keyboard controller's native module.
jest.mock('../chat/ThreadScreen', () => ({ ThreadSurface: () => null }));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
const mockApi = {
  automations: jest.fn(),
  automationsTimeline: jest.fn(),
  automationJob: jest.fn(),
  automationsReadAll: jest.fn(() => Promise.resolve({ counts: {} })),
  automationPrefs: jest.fn(() => Promise.resolve({})),
  automationMarkRead: jest.fn(() => Promise.resolve({})),
  applyWrite: jest.fn(() => Promise.resolve({ code: 0 })),
};
jest.mock('../../lib/api', () => ({
  api: new Proxy({}, { get: (_t, key: string) => (mockApi as Record<string, unknown>)[key] }),
  ApplyError: class extends Error {},
  GateNotWiredError: class extends Error {},
}));
let mockData: Record<string, unknown> = {};
jest.mock('../../lib/query', () => ({
  usePoll: (key: string[]) => ({
    data: mockData[key[0]],
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: jest.fn(() => Promise.resolve()),
  }),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'c0ffee000001:2026-09-28_21-00-20', job_id: 'c0ffee000001', job_name: 'ops-watch', category: 'ops',
    run_time: '2026-09-29T01:00:20Z', day: '2026-09-28', status: 'ok', severity: 'warn',
    preview: 'backup stale — last snapshot 136h ago', items: 4, unchanged: false, new_lines: 1,
    streak: 1, since: '2026-09-29T01:00:20Z', read: false, replies: 2, ...overrides,
  };
}

function job(id: string, name: string, section: string, overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id, name, category: 'ops', schedule: '0 21 * * *', deliver: 'discord:1,hub:ops', state: 'active',
    mode: 'script', next_run_at: null, last_status: 'ok', last_error: null, notify: 'push',
    snoozed_until: null, origin_thread: null, latest: run({ job_id: id, job_name: name, run_id: `${id}:a` }),
    last_run: { run_time: '2026-09-29T01:00:20Z', status: 'ok' }, unread: section === 'new' ? 1 : 0,
    needs_you: section === 'needs_you', followups: 0, section,
    counts_30d: { runs: 30, reported: 11, silent: 19, failed: 0 }, ...overrides,
  };
}

const JOBS = [
  job('c0ffee000001', 'ops-watch', 'needs_you'),
  job('d96e594403d8', 'Amazon order tracker', 'new', { category: 'ops', latest: run({ severity: 'info', items: 0, new_lines: 0, replies: 0, preview: 'Cocofloss arriving today' }) }),
  job('cbb0aa34f607', 'finance-snapshot', 'earlier', { category: 'money' }),
  job('c0ffee000002', 'Porch Light ON (2 PM)', 'quiet', { category: 'background', latest: null }),
];

let active: TestRenderer.ReactTestRenderer | null = null;
function mount(node: React.ReactElement) {
  act(() => {
    active = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  });
  return active as unknown as TestRenderer.ReactTestRenderer;
}
function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) => [n.props.children].flat(3).join(''));
}
/** A row's label is its title, time and preview; a control's is its own text. */
function press(tree: TestRenderer.ReactTestRenderer, label: string) {
  const target = tree.root.findAll(
    (n) => typeof n.props.accessibilityLabel === 'string' && (n.props.accessibilityLabel === label || n.props.accessibilityLabel.startsWith(`${label}, `)) && typeof n.props.onPress === 'function',
  )[0];
  act(() => target.props.onPress());
}

/** For a press whose handler awaits: the state it sets afterwards lands inside act. */
async function pressAndSettle(tree: TestRenderer.ReactTestRenderer, label: string) {
  const target = tree.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  expect(target).toBeDefined();
  await act(async () => {
    await target.props.onPress();
  });
}

beforeEach(() => {
  mockPush.mockClear();
  mockData = {
    automations: { jobs: JOBS, counts: { needs_you: 1, unread: 1, jobs: 4 }, generated_at: '2026-09-29T14:00:00Z' },
  };
});
afterEach(() => {
  act(() => active?.unmount());
  active = null;
});

test('jobs are listed under the section the server put them in, quiet ones folded', () => {
  const seen = texts(mount(<AutomationsScreen />));
  expect(seen).toEqual(expect.arrayContaining(['Needs you', 'New', 'Up to date', 'Quiet']));
  expect(seen).toEqual(expect.arrayContaining(['ops-watch', 'Amazon order tracker', 'finance-snapshot']));
  expect(seen).toContain('1 needs you · 1 new');
  expect(seen).toContain('4 issues');
  expect(seen).toContain('2 replies');
  expect(seen).not.toContain('Porch Light ON (2 PM)');
  expect(seen).toContain('1 automations with nothing to report');
});

test('the quiet fold opens on a tap', () => {
  const tree = mount(<AutomationsScreen />);
  press(tree, '1 automations with nothing to report');
  expect(texts(tree)).toContain('Porch Light ON (2 PM)');
});

test('a category chip narrows the list', () => {
  const tree = mount(<AutomationsScreen />);
  press(tree, 'Money');
  const seen = texts(tree);
  expect(seen).toContain('finance-snapshot');
  expect(seen).not.toContain('Amazon order tracker');
  expect(seen).not.toContain('Quiet');
  // What needs him is never filtered out of view.
  expect(seen).toContain('ops-watch');
});

test('jobs failing the same way are one row until it is opened', () => {
  const failing = (id: string, name: string) =>
    job(id, name, 'needs_you', {
      category: 'background',
      latest: run({ job_id: id, job_name: name, run_id: `${id}:a`, severity: 'failed', items: 0, new_lines: 0, replies: 0, fingerprint: 'curl-28', preview: 'Script exited with code 28' }),
    });
  mockData = {
    automations: {
      jobs: [JOBS[0], failing('c1', 'Hall Lamp ON (9 PM)'), failing('c2', 'Hall Lamp OFF (11 PM)'), failing('c3', 'Porch Light ON (2 PM)')],
      counts: { needs_you: 4, unread: 0, jobs: 4 },
      generated_at: '2026-09-29T14:00:00Z',
    },
  };
  const tree = mount(<AutomationsScreen />);
  expect(texts(tree)).toContain('3 automations failing the same way');
  expect(texts(tree)).not.toContain('Hall Lamp ON (9 PM)');
  expect(texts(tree)).toContain('ops-watch');
  press(tree, '3 automations failing the same way');
  expect(texts(tree)).toEqual(expect.arrayContaining(['Hall Lamp ON (9 PM)', 'Hall Lamp OFF (11 PM)', 'Porch Light ON (2 PM)']));
});

test('a job row opens that job', () => {
  const tree = mount(<AutomationsScreen />);
  press(tree, 'ops-watch');
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/automations/job', params: { jobId: 'c0ffee000001' } });
});

test('the timeline is by day, names each run, and counts the quiet ones on one line', () => {
  const timeline: TimelineResponse = {
    before: null,
    days: [
      {
        day: '2026-09-28',
        runs: [run(), run({ run_id: 'c:a', job_id: 'c', job_name: 'finance-snapshot', category: 'money', severity: 'info', items: 0 })],
        quiet: [{ job_id: 'q', name: 'inbox-sweep', count: 121, silent: 121 }],
      },
    ],
  };
  mockData['automations-timeline'] = timeline;
  const tree = mount(<AutomationsScreen />);
  press(tree, 'Timeline');
  const seen = texts(tree);
  expect(seen).toEqual(expect.arrayContaining(['ops-watch', 'finance-snapshot']));
  expect(seen).toContain('121 runs with nothing to report');
  expect(seen).toContain('inbox-sweep ×121');
  press(tree, 'finance-snapshot');
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/automations/run', params: { runId: 'c:a' } });
});

test('one automation shows its controls and its history with the folds', async () => {
  mockData['automation-job'] = {
    job: JOBS[0],
    items: [
      { kind: 'run', run: run() },
      { kind: 'span', span: 'unchanged', count: 5, from: '2026-09-22T12:00:00Z', to: '2026-09-26T12:00:00Z' },
      { kind: 'span', span: 'silent', count: 19, from: '2026-09-02T12:00:00Z', to: '2026-09-21T12:00:00Z' },
    ],
  };
  const tree = mount(<JobSurface jobId="c0ffee000001" />);
  const seen = texts(tree);
  expect(seen).toEqual(expect.arrayContaining(['Run now', 'Pause', 'Push', 'Quiet', 'Muted', '1 day', '3 days', '1 week']));
  expect(seen).toContain('Discord, Hub');
  expect(seen).toContain('30 runs · 11 reported · 19 silent');
  expect(seen.some((s) => s.startsWith('5 runs, same output'))).toBe(true);
  expect(seen.some((s) => s.startsWith('19 silent runs'))).toBe(true);
  await pressAndSettle(tree, 'Quiet');
  // A script job can be run by hand; an agent job cannot (Ruling 36).
  act(() => tree.unmount());
  mockData['automation-job'] = { job: { ...JOBS[1], mode: 'agent' }, items: [] };
  const agent = mount(<JobSurface jobId="d96e594403d8" />);
  expect(texts(agent)).not.toContain('Run now');
  expect(texts(agent)).toContain('Pause');
  expect(texts(agent).some((s) => s.startsWith('An agent job runs on its schedule'))).toBe(true);
  expect(mockApi.automationPrefs).toHaveBeenCalledWith('c0ffee000001', { notify: 'quiet' });
});

test('a run is drawn as the one message it is', () => {
  const detail = {
    ...run(),
    output: '⚠️ ops-watch:\n• backup stale',
    truncated: false,
    parts: [{ type: 'text' as const, text: '⚠️ ops-watch:\n• backup stale' }],
  };
  const message = runAsMessage(detail, 'fu_abc');
  expect(message).toMatchObject({ role: 'assistant', status: 'complete', thread_id: 'fu_abc', cron_run_id: detail.run_id });
  const tree = mount(<RunCard run={detail} threadId="fu_abc" />);
  const seen = texts(tree).join('\n');
  expect(seen).toContain('ops-watch');
  expect(seen).toContain('backup stale');
  press(tree, 'ops-watch, all runs');
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/automations/job', params: { jobId: 'c0ffee000001' } });
});

test('a run that said nothing says so', () => {
  const tree = mount(
    <RunCard run={{ ...run({ status: 'silent', severity: 'info', items: 0, new_lines: 0, replies: 0 }), output: '', truncated: false, parts: [] }} threadId="fu_abc" />,
  );
  expect(texts(tree)).toContain('This run had nothing to report.');
});
