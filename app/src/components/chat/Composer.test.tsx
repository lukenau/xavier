// Component-level coverage for the `/` picker wiring inside Composer.tsx —
// the pure functions it calls (chat/commands.ts) already have unit tests,
// but nothing previously exercised the composer's own send-time gate or its
// fail-open behaviour when the catalog read itself fails. Adversarial-review
// gap found 2026-09-21: "unknown-command gate ... must be tests, not
// reasoning" and "what happens if the catalog fetch fails" had no test at
// this level at all.
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      chatCommands: jest.fn(),
    },
  };
});

import TestRenderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer';
import { CommandSheet } from './CommandSheet';
import { api } from '../../lib/api';
import type { ChatCommandsResponse } from '../../chat/commands';

const CATALOG: ChatCommandsResponse = {
  version: 1,
  source: 'live',
  commands: [
    { name: '/new', aliases: ['/reset'], category: 'builtin', description: '', arg_hint: null, busy_policy: 'interrupt_then_dispatch' },
    { name: '/brainstorming', aliases: [], category: 'skill', description: '', arg_hint: null, busy_policy: 'dispatch' },
  ],
};

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let client: QueryClient;
let renderer: TestRenderer.ReactTestRenderer | null = null;

function input(r: TestRenderer.ReactTestRenderer) {
  return r.root.findByType(TextInput);
}

function sendButton(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll((n) => n.props.accessibilityLabel === 'Send')[0];
}

/** Types `text` and reports the cursor at `cursor` (default: end) — the same
 * two-callback sequence RN fires (onChangeText, then onSelectionChange). */
function type(r: TestRenderer.ReactTestRenderer, text: string, cursor = text.length) {
  act(() => input(r).props.onChangeText(text));
  act(() => input(r).props.onSelectionChange({ nativeEvent: { selection: { start: cursor, end: cursor } } }));
}

function select(r: TestRenderer.ReactTestRenderer, start: number, end: number) {
  act(() => input(r).props.onSelectionChange({ nativeEvent: { selection: { start, end } } }));
}

/** Seeds the catalog into the cache directly (SystemPanel.test.tsx's own
 * pattern) rather than awaiting the mocked promise — sidesteps a real
 * microtask race against react-query's fetch scheduling. */
async function renderComposer(onSend = jest.fn(), catalog: ChatCommandsResponse | null = CATALOG) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (catalog) client.setQueryData(['chat-commands'], catalog);
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <Composer mode="queue" onModeChange={() => {}} onSend={onSend} running={false} onStop={() => {}} />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  renderer = r;
  return { renderer: r, onSend };
}

beforeEach(() => {
  (api.chatCommands as jest.Mock).mockImplementation(() => new Promise(() => {})); // never resolves by default
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  client?.clear();
  jest.clearAllMocks();
});

test('a leading unknown command is blocked and never reaches onSend', async () => {
  const { renderer: r, onSend } = await renderComposer();
  type(r, '/nope do something');
  act(() => sendButton(r).props.onPress());
  expect(onSend).not.toHaveBeenCalled();
});

test('a mid-sentence unknown token is prose and is sent verbatim', async () => {
  const { renderer: r, onSend } = await renderComposer();
  type(r, 'look at /nope over there');
  act(() => sendButton(r).props.onPress());
  expect(onSend).toHaveBeenCalledWith('look at /nope over there', 'queue', []);
});

test('a leading command that matches the catalog sends normally', async () => {
  const { renderer: r, onSend } = await renderComposer();
  type(r, '/new session please');
  act(() => sendButton(r).props.onPress());
  expect(onSend).toHaveBeenCalledWith('/new session please', 'queue', []);
});

test('a failed catalog fetch still lets plain text send — the composer fails open', async () => {
  (api.chatCommands as jest.Mock).mockRejectedValue(new Error('network down'));
  const { renderer: r, onSend } = await renderComposer(jest.fn(), null);
  type(r, '/whatever this would be if the catalog had loaded');
  act(() => sendButton(r).props.onPress());
  expect(onSend).toHaveBeenCalledWith('/whatever this would be if the catalog had loaded', 'queue', []);
});

test('an empty (still-loading) catalog also fails open rather than blocking every leading slash', async () => {
  const { renderer: r, onSend } = await renderComposer(jest.fn(), null);
  type(r, '/nope not loaded yet');
  act(() => sendButton(r).props.onPress());
  expect(onSend).toHaveBeenCalledWith('/nope not loaded yet', 'queue', []);
});

test('picking a command uses selection.end as the caret — a non-collapsed selection does not corrupt insertion', async () => {
  const { renderer: r } = await renderComposer();
  const text = 'fix the bug /new';
  type(r, text, text.length);
  // The user drags to select the whole token, start != end (a real range,
  // not a collapsed caret) — insertCommandToken must key off .end only.
  select(r, text.indexOf('/new'), text.length);
  const sheet = r.root.findByType(CommandSheet);
  act(() => sheet.props.onSelect(CATALOG.commands[0])); // /new, builtin -> relocates to start
  expect(input(r).props.value).toBe('/new fix the bug ');
});

test('picking a skill mid-sentence with a range selected inserts in place, byte for byte', async () => {
  const { renderer: r } = await renderComposer();
  const text = 'archive or delete /br whether to keep it';
  const slashStart = text.indexOf('/br');
  const cursor = slashStart + '/br'.length;
  type(r, text, cursor);
  select(r, slashStart, cursor); // a range selecting exactly the typed token
  const sheet = r.root.findByType(CommandSheet);
  act(() => sheet.props.onSelect(CATALOG.commands[1])); // /brainstorming, skill -> inline
  expect(input(r).props.value).toBe('archive or delete /brainstorming whether to keep it');
});
