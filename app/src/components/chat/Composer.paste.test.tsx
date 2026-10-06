// One paste affordance, never two.
//
// Build 14 shipped the system UIPasteControl next to the composer's own
// "paste" label, and the user saw both at once (2026-10-01). The old button was
// rendered unconditionally while the native one was rendered as well, so the
// bug was two siblings where there should have been a branch. These tests pin
// the branch in both directions, since the native control can only be the one
// shown where the OS actually draws it.
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, api: { ...actual.api, chatCommands: jest.fn() } };
});

// `mock`-prefixed: babel-plugin-jest-hoist rejects any other out-of-scope
// name inside a jest.mock factory.
let mockNativeAvailable = true;

jest.mock('../../../modules/paste-control', () => ({
  // A getter, not a value: the composer reads this through the module object
  // on every render, so one mock serves both branches.
  get available() {
    return mockNativeAvailable;
  },
  PasteControl: (props: Record<string, unknown>) => {
    const { View } = jest.requireActual('react-native');
    return <View accessibilityLabel="System paste" {...props} />;
  },
}));

import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer';
import { api } from '../../lib/api';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let renderer: TestRenderer.ReactTestRenderer | null = null;
let client: QueryClient;

async function renderComposer(threadId: string | undefined) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <Composer
            mode="queue"
            onModeChange={() => {}}
            onSend={() => {}}
            running={false}
            onStop={() => {}}
            threadId={threadId}
          />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  renderer = r;
  return r;
}

/** Host elements only — a testID or label also matches the composite wrapper
 * above it, which would double every count. */
function labelled(r: TestRenderer.ReactTestRenderer, label: string) {
  return r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
}

function texts(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => typeof n.type === 'string')
    .flatMap((n) => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]))
    .filter((c): c is string => typeof c === 'string');
}

beforeEach(() => {
  mockNativeAvailable = true;
  (api.chatCommands as jest.Mock).mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  client?.clear();
  jest.clearAllMocks();
});

test('with the system control available there is exactly one paste button, the native one', async () => {
  const r = await renderComposer('thr_1');
  expect(labelled(r, 'System paste')).toHaveLength(1);
  expect(labelled(r, 'Paste from clipboard')).toHaveLength(0);
  expect(texts(r)).not.toContain('paste');
});

test('without the system control the composer keeps its own paste button', async () => {
  mockNativeAvailable = false;
  const r = await renderComposer('thr_1');
  expect(labelled(r, 'System paste')).toHaveLength(0);
  expect(labelled(r, 'Paste from clipboard')).toHaveLength(1);
  expect(texts(r)).toContain('paste');
});

test('with no thread yet the fallback button shows even where the OS has a control', async () => {
  const r = await renderComposer(undefined);
  expect(labelled(r, 'System paste')).toHaveLength(0);
  expect(labelled(r, 'Paste from clipboard')).toHaveLength(1);
});
