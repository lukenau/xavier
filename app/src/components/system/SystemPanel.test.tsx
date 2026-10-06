// Collapse defaults and the doctor's issues-first filter — the two System
// behaviours the parity inventory calls out as easy to get backwards
// (ops.md §6: "Skills section is open by default; Plugins collapsed by
// default"). Everything below the header is driven by the real usePoll stack;
// only the four api reads are mocked.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      skills: jest.fn(),
      plugins: jest.fn(),
      mcp: jest.fn(),
      doctor: jest.fn(),
    },
  };
});

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemPanel } from './SystemPanel';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const SKILLS = {
  total: 2,
  enabled: 1,
  disabled: 1,
  builtin: null,
  hub: null,
  local: null,
  categories: [{ name: 'finance', count: 2 }],
  skills: [
    { name: 'runbook', category: 'finance', source: 'hub', trust: 'trusted', status: 'enabled' },
    { name: 'oura-sync', category: 'health', source: 'local', trust: 'untrusted', status: 'disabled' },
  ],
};

const PLUGINS = {
  total: 2,
  enabled: 1,
  plugins: [
    { name: 'superpowers', status: 'enabled', version: '1.2.0', description: 'TDD skills', source: 'hub', enabled: true },
    { name: 'disk-cleanup', status: 'bundled', version: null, description: null, source: 'builtin', enabled: false },
  ],
};

const MCP = {
  count: 1,
  enabled: 1,
  servers: [{ name: 'exa', transport: 'http', tools: '4', status: 'enabled', enabled: true }],
};

const DOCTOR = {
  sections: [
    { name: 'gateway', checks: [{ status: 'pass' as const, label: 'gateway up' }, { status: 'warn' as const, label: 'slow doctor' }] },
    { name: 'disk', checks: [{ status: 'pass' as const, label: 'disk ok' }] },
  ],
  summary: { pass: 2, warn: 1, fail: 0, total: 3, ok: false },
};

let client: QueryClient;
let mounted: TestRenderer.ReactTestRenderer | null = null;

/** The four reads are seeded into the cache rather than awaited: every query
 * here has the global 20s staleTime, so a seeded entry is fresh and usePoll
 * returns it on the first render. The api mocks stay in place so an
 * unexpected refetch is a mock call, never a real request. */
async function render() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['skills'], SKILLS);
  client.setQueryData(['plugins'], PLUGINS);
  client.setQueryData(['mcp'], MCP);
  client.setQueryData(['doctor'], DOCTOR);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <SystemPanel />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  mounted = renderer;
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).flatMap((n) => {
    const kids = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
    return kids.filter((c: unknown): c is string => typeof c === 'string');
  });
}

/** The nearest ancestor Pressable of the <Text> reading `label`. */
function pressableFor(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const text = renderer.root.findAll((n) => n.type === Text && n.props.children === label)[0];
  let node: TestRenderer.ReactTestInstance | null = text;
  while (node && node.props?.onPress === undefined) node = node.parent ?? null;
  if (!node) throw new Error(`no pressable ancestor for "${label}"`);
  return node;
}

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = null;
  client?.clear();
  jest.clearAllMocks();
});

test('the header says read-only', async () => {
  const renderer = await render();
  const t = texts(renderer);
  expect(t).toContain('System');
  expect(t).toContain('read-only');
});

test('Skills is open by default and Plugins is collapsed', async () => {
  const renderer = await render();
  let t = texts(renderer);
  // Skills body is rendered...
  expect(t).toContain('runbook');
  expect(t).toContain('installed · 1 enabled · 1 disabled');
  // ...and both counts are on their headers even though one body is hidden.
  expect(t).toContain('1/2');
  // Plugins body is not.
  expect(t).not.toContain('superpowers');

  await act(async () => {
    pressableFor(renderer, 'Plugins').props.onPress();
  });
  t = texts(renderer);
  expect(t).toContain('superpowers');
  // Enabled first (SystemPanel.tsx:254-257).
  expect(t.indexOf('superpowers')).toBeLessThan(t.indexOf('disk-cleanup'));

  await act(async () => {
    pressableFor(renderer, 'Skills').props.onPress();
  });
  expect(texts(renderer)).not.toContain('trader-runbook');
});

test('Doctor shows issues only, and the toggle reveals the passing checks', async () => {
  const renderer = await render();
  let t = texts(renderer);
  expect(t).toContain('attention');
  expect(t).toContain('slow doctor');
  expect(t).not.toContain('gateway up');
  // The all-pass "disk" section is dropped entirely under the filter.
  expect(t).not.toContain('disk');
  expect(t).toContain('Show all 3 checks');

  await act(async () => {
    pressableFor(renderer, 'Show all 3 checks').props.onPress();
  });
  t = texts(renderer);
  expect(t).toContain('gateway up');
  expect(t).toContain('disk');
  expect(t).toContain('Show only issues');
});

test('searching the skills list filters it, and a miss shows the query back', async () => {
  const renderer = await render();
  const input = renderer.root.findAll((n) => n.props.placeholder === 'Search skills…')[0];
  await act(async () => {
    input.props.onChangeText('oura');
  });
  let t = texts(renderer);
  expect(t).toContain('oura-sync');
  expect(t).not.toContain('trader-runbook');

  await act(async () => {
    input.props.onChangeText('zzz');
  });
  t = texts(renderer);
  expect(t.some((s) => s.includes('No skills match'))).toBe(true);
});
