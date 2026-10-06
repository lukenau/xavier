// "Teach the brief" (Ruling 146) — list/add/remove against the real usePoll
// stack; only the three api calls are mocked, so a wiring mistake (wrong
// query key, wrong invalidation) shows up the same way it would live.
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      briefingRules: jest.fn(),
      addBriefingRule: jest.fn(),
      removeBriefingRule: jest.fn(),
    },
  };
});
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RulesSheet } from './RulesSheet';
import { api } from '../../lib/api';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const RULES = [
  { id: 'aaaaaaaaaaaa', text: 'my manager owns OKRs, never me', ts: '2026-09-20T00:00:00Z' },
  { id: 'bbbbbbbbbbbb', text: 'anything from #data-alerts is background', ts: '2026-09-21T00:00:00Z' },
];

let client: QueryClient;
let mounted: TestRenderer.ReactTestRenderer | null = null;

async function render(visible = true) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['briefing-rules'], { rules: RULES });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <RulesSheet visible={visible} onClose={() => {}} />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  mounted = renderer;
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string');
}

function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const found = renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  // Only invalidateQueries()-triggered refetches (after an add/remove) ever
  // reach this; the seeded cache stays fresh under the global staleTime
  // otherwise. A safe default so those refetches never hang on `undefined`.
  (api.briefingRules as jest.Mock).mockResolvedValue({ rules: RULES });
});

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = null;
  client?.clear();
});

test('renders every existing rule, each with a 44pt remove control', async () => {
  const tree = await render();
  const rendered = texts(tree);
  for (const rule of RULES) expect(rendered).toContain(rule.text);

  const remove = button(tree, `Remove rule: ${RULES[0].text}`);
  const flat = [
    typeof remove.props.style === 'function' ? remove.props.style({ pressed: false }) : remove.props.style,
  ]
    .flat(Infinity)
    .filter(Boolean);
  expect(flat.some((s: Record<string, unknown>) => s?.minHeight === 44)).toBe(true);
});

test('adding a rule calls addBriefingRule, clears the field, and refetches the list', async () => {
  (api.addBriefingRule as jest.Mock).mockResolvedValue({ rules: [...RULES] });
  const tree = await render();
  const field = tree.root.findByType(TextInput);
  act(() => field.props.onChangeText('my own new rule'));
  await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());

  expect(api.addBriefingRule).toHaveBeenCalledWith('my own new rule');
  expect(tree.root.findByType(TextInput).props.value).toBe('');
  expect(api.briefingRules).toHaveBeenCalled(); // the post-add refetch
});

test('an empty add does nothing', async () => {
  const tree = await render();
  await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());
  expect(api.addBriefingRule).not.toHaveBeenCalled();
});

test('a failed add says so, and leaves the field for a retry', async () => {
  (api.addBriefingRule as jest.Mock).mockRejectedValue(new Error('nope'));
  const tree = await render();
  act(() => tree.root.findByType(TextInput).props.onChangeText('a rule'));
  await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());
  expect(texts(tree).join(' ')).toContain('Couldn’t save that rule.');
  expect(tree.root.findByType(TextInput).props.value).toBe('a rule');
});

test('removing a rule calls removeBriefingRule with its id', async () => {
  (api.removeBriefingRule as jest.Mock).mockResolvedValue({ rules: [RULES[1]] });
  const tree = await render();
  await act(async () => button(tree, `Remove rule: ${RULES[0].text}`).props.onPress());
  expect(api.removeBriefingRule).toHaveBeenCalledWith(RULES[0].id);
});

test('no rules yet reads calmly, not as an error', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['briefing-rules'], { rules: [] });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <RulesSheet visible onClose={() => {}} />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  mounted = tree;
  expect(texts(tree).join(' ')).toContain('No rules yet.');
});
