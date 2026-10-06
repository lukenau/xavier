// A11 — the Chat tab's badge. The count itself is chat/store.test.ts's
// subject; this is the wiring: the root layout reads it off the store and
// hands it to the Chat trigger's Badge. Automations carries the only other
// one (2026-09-29), fed by its own count, and the two never share a number.
//
// The native tab bar is mocked down to plain views — <NativeTabs.Trigger>
// renders null in the real implementation, so there would be nothing to
// assert against otherwise.
import TestRenderer, { act } from 'react-test-renderer';
import { Text, View } from 'react-native';
import { useChatStore } from '../../chat/store';
import type { AttentionUpsertFrame, Thread } from '../../chat/types';
import RootLayout from '../../../app/_layout';

jest.mock('expo-router/unstable-native-tabs', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Text: T, View: V } = require('react-native');
  const Trigger = ({ name, children }: { name?: string; children?: React.ReactNode }) => (
    <V testID={`trigger-${name}`}>{children}</V>
  );
  Trigger.Icon = () => null;
  Trigger.Label = ({ children }: { children?: React.ReactNode }) => <T>{children}</T>;
  Trigger.Badge = ({ children }: { children?: React.ReactNode }) => <T testID="badge">{children}</T>;
  const NativeTabs = ({ children }: { children?: React.ReactNode }) => <V>{children}</V>;
  NativeTabs.Trigger = Trigger;
  return { NativeTabs };
});
jest.mock('expo-router', () => ({
  ThemeProvider: ({ children }: { children?: React.ReactNode }) => children,
  DarkTheme: { colors: {} },
  DefaultTheme: { colors: {} },
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-gesture-handler', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { View: V } = require('react-native');
  return { GestureHandlerRootView: V };
});
jest.mock('react-native-keyboard-controller', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { View: V } = require('react-native');
  return { KeyboardProvider: V };
});
jest.mock('../../lib/query', () => ({
  HubQueryProvider: ({ children }: { children?: React.ReactNode }) => children,
  // The root layout wires this so refetch-on-focus works at all on a platform
  // with no window focus event (2026-09-23).
  wireFocusManager: () => () => {},
}));
jest.mock('../../lib/gate', () => ({ installGateSigner: () => {} }));
// Push routing has its own suite (lib/push.test.ts); the layout only wires it.
jest.mock('../../lib/push', () => ({ onNotificationTap: () => ({ remove: () => {} }) }));
let mockAutomationsNeedYou = 0;
jest.mock('../../automations/badge', () => ({ useAutomationsBadge: () => mockAutomationsNeedYou }));

function thread(id: string): Thread {
  return {
    id,
    kind: 'chat',
    title: null,
    status: 'idle',
    pinned: false,
    archived: false,
    last_seq: 1,
    created_at: '2026-09-22T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 0,
    unread: 1,
    preview: null,
    preview_role: null,
    hermes_session_id: null,
    origin_thread_id: null,
    origin_message_id: null,
  };
}

function needsYou(threadId: string, attentionId: string): AttentionUpsertFrame {
  return {
    type: 'attention.upsert',
    seq: 2,
    thread_id: threadId,
    attention_id: attentionId,
    kind: 'approval',
    request_id: 'r1',
    run_id: 'run1',
    summary: 'terminal: ls',
    message_id: null,
  };
}

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => active?.unmount());
  active = null;
  useChatStore.getState().reset();
  mockAutomationsNeedYou = 0;
});

function render(): TestRenderer.ReactTestRenderer {
  act(() => {
    active = TestRenderer.create(<RootLayout />);
  });
  return active as TestRenderer.ReactTestRenderer;
}

/** Host nodes only: `findAll` matches the mock component AND the <Text> it
 * renders, so every badge would otherwise be counted twice. */
const isBadge = (n: TestRenderer.ReactTestInstance) =>
  typeof n.type === 'string' && n.props?.testID === 'badge';

function badges(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAll(isBadge).map((n) => String(n.props.children ?? ''));
}

/** One tab's badge, by the trigger it sits in. */
function badgeOf(tree: TestRenderer.ReactTestRenderer, tab: string): string {
  const trigger = tree.root.find((n) => typeof n.type === 'string' && n.props?.testID === `trigger-${tab}`);
  return trigger.findAll(isBadge).map((n) => String(n.props.children ?? '')).join('|');
}

test('a quiet estate shows bare chrome — no badge element at all', () => {
  // The element IS the dot: iOS draws one for an empty string too, so a tab
  // with nothing waiting wore a red dot for ever (the user, 2026-09-30).
  expect(badges(render())).toEqual([]);
});

test('the badge counts threads waiting on the user and updates live', () => {
  const tree = render();
  act(() => {
    const store = useChatStore.getState();
    store.hydrateSnapshot(thread('ops'), []);
    store.hydrateSnapshot(thread('brief'), []);
    store.applyFrame(needsYou('ops', 'att_1'));
  });
  expect(badgeOf(tree, 'chat')).toBe('1');
  act(() => useChatStore.getState().applyFrame(needsYou('brief', 'att_2')));
  expect(badgeOf(tree, 'chat')).toBe('2');
  // A thread waiting on him is not an automation waiting on him.
  expect(badgeOf(tree, 'automations')).toBe('');
});

test('the Automations tab counts the jobs that need him', () => {
  mockAutomationsNeedYou = 3;
  const tree = render();
  expect(badgeOf(tree, 'automations')).toBe('3');
  expect(badgeOf(tree, 'chat')).toBe('');
});

test('only Chat and Automations carry one', () => {
  const tree = render();
  act(() => {
    const store = useChatStore.getState();
    store.hydrateSnapshot(thread('ops'), []);
    store.applyFrame(needsYou('ops', 'att_1'));
  });
  const chat = tree.root.find((n) => typeof n.type === 'string' && n.props?.testID === 'trigger-chat');
  expect(chat.findAll(isBadge)).toHaveLength(1);
  // One badge on the whole bar: Chat's. Automations has nothing waiting, so
  // it carries no badge rather than an empty one.
  expect(badges(tree)).toHaveLength(1);
  for (const tab of ['(home)', 'ops']) expect(badgeOf(tree, tab)).toBe('');
});

test('the badge is a View-free string — an empty one, not a zero', () => {
  const tree = render();
  expect(tree.root.findAllByType(View).length).toBeGreaterThan(0);
  expect(tree.root.findAllByType(Text).some((n) => n.props.children === 0)).toBe(false);
});
