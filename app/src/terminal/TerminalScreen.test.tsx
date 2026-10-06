// Composition: which screen the lock state produces, and how the surface is
// wired to the transport. The transport itself is Task 22's and is stubbed
// here — what this file pins is the CALLER, which is where a wiring bug lives
// (a measured grid that never reaches connect(), a re-lock that never
// re-renders the gate, a composer that sends to nothing).
const mockSockets: MockSocket[] = [];

class MockSocket {
  connect = jest.fn();
  resize = jest.fn();
  write = jest.fn();
  ack = jest.fn();
  retryNow = jest.fn();
  close = jest.fn();
  detach = jest.fn();
  attachAppState = jest.fn(() => this.detach);
  constructor(public opts: TerminalSocketOptions) {
    mockSockets.push(this);
  }
}

jest.mock('./wsClient', () => ({
  TerminalSocket: jest.fn().mockImplementation((opts) => new MockSocket(opts)),
}));

jest.mock('expo-router', () => ({
  // Screen arms the tab-re-press scroll with it; behaviour is asserted in Screen.test.tsx.
  useScrollToTop: () => {},
  router: { navigate: jest.fn() },
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

// The library ships its own jest double: KeyboardStickyView becomes a plain
// View and useKeyboardState reports a closed keyboard. Without it the native
// module lookup throws at import time.
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest'),
);

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef((props: object, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({ injectJavaScript: () => {}, reload: () => {} }));
      return React.createElement(View, props);
    }),
  };
});

jest.mock('../lib/query', () => ({
  ...jest.requireActual('../lib/query'),
  usePoll: jest.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  })),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { api, ApplyError, GateNotWiredError, GATE_NOT_WIRED_MESSAGE } from '../lib/api';
import TerminalScreen from './TerminalScreen';
import { NO_PASSKEY_MESSAGE, UNLOCK_KEY, UNLOCK_TTL_MS, useTerminalLock } from './lock';
import type { TerminalSocketOptions } from './wsClient';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out;
}

function byLabel(tree: TestRenderer.ReactTestRenderer, label: string) {
  const hit = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => n.props.accessibilityLabel === label);
  if (!hit) throw new Error(`nothing labelled ${label}`);
  return hit.props.onPress as () => void;
}

/** Text nodes joined — several of these lines are assembled from two children
 * (`{status}` + ` · retry`), exactly as the PWA assembles them. */
const joined = (tree: TestRenderer.ReactTestRenderer) => texts(tree).join('');

/** Press the control whose OWN joined text is `label`. */
function byJoinedText(tree: TestRenderer.ReactTestRenderer, label: string) {
  const flat = (node: TestRenderer.ReactTestInstance) =>
    node
      .findAllByType(Text)
      .map((inner) => ([] as unknown[]).concat(inner.props.children).join(''))
      .join('');
  const hit = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => flat(n) === label);
  if (!hit) throw new Error(`nothing reading ${label}`);
  return hit.props.onPress as () => void;
}

function byText(tree: TestRenderer.ReactTestRenderer, label: string) {
  const hit = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) =>
      n.findAllByType(Text).some((inner) => inner.props.children === label),
    );
  if (!hit) throw new Error(`nothing reading ${label}`);
  return hit.props.onPress as () => void;
}

let tree: TestRenderer.ReactTestRenderer | null = null;

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  await act(async () => {
    tree = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <TerminalScreen />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

/** iOS fires Modal.onDismiss once the dismissal animation finishes; nothing
 * in the test renderer does, so the sheets' deferred work needs a nudge. */
function dismissModal(t: TestRenderer.ReactTestRenderer) {
  const modal = t.root.findAll((n) => typeof n.props.onDismiss === 'function')[0];
  modal.props.onDismiss();
}

/** The WebView reports its measured grid; the screen turns that into a connect. */
function measure(t: TestRenderer.ReactTestRenderer, height = 500) {
  const canvas = t.root.findAll((n) => typeof n.props.onLayout === 'function')[0];
  act(() => canvas.props.onLayout({ nativeEvent: { layout: { height } } }));
}

function size(cols: number, rows: number) {
  const webview = tree!.root.findAll((n) => typeof n.props.onMessage === 'function')[0];
  act(() =>
    webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ t: 'size', cols, rows }) } }),
  );
}

beforeEach(async () => {
  mockSockets.length = 0;
  await AsyncStorage.clear();
  useTerminalLock.setState({ unlocked: false, hydrated: false, busy: false, error: null });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

describe('the lock screen', () => {
  test('is what a cold launch shows, with the PWA\'s copy', async () => {
    const t = await mount();
    const rendered = texts(t);

    expect(rendered).toContain(
      'Shell access to the VPS. Unlock with Face ID — the session stays live for an hour.',
    );
    expect(rendered).toContain('Unlock terminal');
    expect(rendered).toContain('‹ Ops');
    // Nothing dials the pty until the gate has passed.
    expect(mockSockets).toHaveLength(0);
  });

  test('a live unlock stamp skips the gate entirely', async () => {
    // The stamp is what lets a relaunch reuse the hour-long server cookie.
    await AsyncStorage.setItem(UNLOCK_KEY, String(Date.now() + UNLOCK_TTL_MS));

    const t = await mount();

    expect(texts(t)).not.toContain('Unlock terminal');
    expect(texts(t)).toContain('xavier · tmux hub-term');
  });

  test('does not flash while the stamp is still being read', async () => {
    // hydrate() is async. Rendering the gate before it resolves would put a
    // Face ID button — and its prompt — in front of an already-valid session.
    await AsyncStorage.setItem(UNLOCK_KEY, String(Date.now() + UNLOCK_TTL_MS));
    act(() => {
      tree = TestRenderer.create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <TerminalScreen />
        </SafeAreaProvider>,
      );
    });

    // No await between create() and here, so the hydrate microtask has not run.
    expect(texts(tree!)).toEqual([]);

    await act(async () => {});
    expect(texts(tree!)).toContain('xavier · tmux hub-term');
  });

  test('an expired stamp does not', async () => {
    await AsyncStorage.setItem(UNLOCK_KEY, String(Date.now() - 1));
    const t = await mount();
    expect(texts(t)).toContain('Unlock terminal');
  });

  test('unlocking goes through api.terminalUnlock and stamps only on success', async () => {
    const unlock = jest.spyOn(api, 'terminalUnlock').mockResolvedValue(true);
    const t = await mount();

    await act(async () => {
      byText(t, 'Unlock terminal')();
    });

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(UNLOCK_KEY)).not.toBeNull();
    expect(texts(t)).toContain('xavier · tmux hub-term');
  });

  test('a refused mint leaves the gate up and stamps nothing', async () => {
    jest.spyOn(api, 'terminalUnlock').mockResolvedValue(false);
    const t = await mount();

    await act(async () => {
      byText(t, 'Unlock terminal')();
    });

    expect(texts(t)).toContain('Unlock terminal');
    expect(await AsyncStorage.getItem(UNLOCK_KEY)).toBeNull();
  });

  test('an unwired gate says so; a cancelled prompt says nothing', async () => {
    jest.spyOn(api, 'terminalUnlock').mockRejectedValue(new GateNotWiredError());
    const t = await mount();
    await act(async () => {
      byText(t, 'Unlock terminal')();
    });
    expect(texts(t)).toContain(GATE_NOT_WIRED_MESSAGE);

    jest
      .spyOn(api, 'terminalUnlock')
      .mockRejectedValue(new ApplyError('cancelled', 'User cancelled the Face ID prompt.'));
    await act(async () => {
      byText(t, 'Unlock terminal')();
    });
    expect(texts(t)).not.toContain('User cancelled the Face ID prompt.');
  });

  test('no enrolled passkey points at Config → Security', async () => {
    jest.spyOn(api, 'terminalUnlock').mockRejectedValue(new ApplyError('no_passkey', 'whatever'));
    const t = await mount();

    await act(async () => {
      byText(t, 'Unlock terminal')();
    });

    expect(texts(t)).toContain(NO_PASSKEY_MESSAGE);
  });
});

describe('the unlocked surface', () => {
  beforeEach(async () => {
    await AsyncStorage.setItem(UNLOCK_KEY, String(Date.now() + UNLOCK_TTL_MS));
  });

  test('connects with the grid the page measured, and resizes on every later one', async () => {
    // The transport sends no post-connect resize of its own (task-22 §1.5):
    // the handshake carries the first size and this screen owns the rest.
    const t = await mount();
    measure(t);

    size(92, 31);
    expect(mockSockets[0].connect).toHaveBeenCalledWith(92, 31);
    expect(mockSockets[0].resize).not.toHaveBeenCalled();

    size(92, 18);
    expect(mockSockets[0].resize).toHaveBeenCalledWith(92, 18);
    expect(mockSockets[0].connect).toHaveBeenCalledTimes(1);
  });

  test('re-fits the pty when the socket reports connected', async () => {
    const t = await mount();
    measure(t);
    size(80, 24);
    mockSockets[0].resize.mockClear();

    act(() => mockSockets[0].opts.onStatus('connected'));

    expect(mockSockets[0].resize).toHaveBeenCalledWith(80, 24);
    expect(texts(t)).toContain('live');
  });

  test('shows each status, with a retry affordance while it is down', async () => {
    const t = await mount();
    measure(t);
    expect(joined(t)).toContain('connecting · retry');

    act(() => mockSockets[0].opts.onStatus('closed'));
    expect(joined(t)).toContain('disconnected · retry');

    act(() => mockSockets[0].opts.onStatus('error'));
    expect(joined(t)).toContain('error · retry');

    act(() => byJoinedText(t, 'error · retry')());
    expect(mockSockets[0].retryNow).toHaveBeenCalledTimes(1);

    act(() => mockSockets[0].opts.onStatus('connected'));
    // Connected has no retry button — the pill is just the state.
    expect(texts(t)).toContain('live');
    expect(joined(t)).not.toContain('live · retry');
  });

  test('output reaches the renderer and the renderer\'s acks reach the socket', async () => {
    jest.useFakeTimers();
    try {
      const t = await mount();
      measure(t);
      const webview = t.root.findAll((n) => typeof n.props.onMessage === 'function')[0];

      // Two flagged chunks in one frame → one batch the page acks once, and
      // the socket must still be told twice. An ack for an UNFLAGGED chunk
      // would drive ttyd's window negative and kill the pause for good.
      act(() => {
        mockSockets[0].opts.onData(new Uint8Array([104, 105]), false);
        mockSockets[0].opts.onData(new Uint8Array([33]), true);
        mockSockets[0].opts.onData(new Uint8Array([10]), true);
      });
      act(() => jest.advanceTimersByTime(16));
      expect(mockSockets[0].ack).not.toHaveBeenCalled();

      act(() =>
        webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ t: 'ack', n: 2 }) } }),
      );

      expect(mockSockets[0].ack).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the composer sends the line with a CR and the chips send raw bytes', async () => {
    const t = await mount();
    measure(t);
    act(() => mockSockets[0].opts.onStatus('connected'));

    const field = t.root.findAllByType(TextInput)[0];
    act(() => field.props.onChangeText('docker ps'));
    act(() => field.props.onSubmitEditing());
    act(() => byText(t, '⌃C')());

    expect(mockSockets[0].write.mock.calls).toEqual([['docker ps\r'], ['\x03']]);
  });

  test('a hardware keystroke inside the page goes straight to the pty', async () => {
    const t = await mount();
    measure(t);
    const webview = t.root.findAll((n) => typeof n.props.onMessage === 'function')[0];

    act(() =>
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ t: 'data', d: 'ls' }) } }),
    );

    expect(mockSockets[0].write.mock.calls).toEqual([['ls']]);
  });

  test('the ⌘ chip opens Runbooks, and a runbook lands in the composer AFTER the sheet goes', async () => {
    const t = await mount();
    measure(t);

    act(() => byLabel(t, 'Command snippets')());
    expect(texts(t)).toContain('Runbooks');

    act(() => byText(t, 'System info')());

    // The sheet closes first and the composer is still untouched: fill()
    // focuses, and iOS drops a focus requested from behind a presenting modal.
    expect(texts(t)).not.toContain('Runbooks');
    expect(t.root.findAllByType(TextInput)[0].props.value).toBe('');

    act(() => dismissModal(t));

    expect(t.root.findAllByType(TextInput)[0].props.value).toBe('uname -a');
  });

  test('the padlock re-locks, and so does the transport\'s own expiry', async () => {
    const logout = jest.spyOn(api, 'terminalLogout').mockResolvedValue(undefined);
    const t = await mount();
    measure(t);

    await act(async () => {
      byLabel(t, 'Lock terminal')();
    });
    expect(texts(t)).toContain('Unlock terminal');
    expect(await AsyncStorage.getItem(UNLOCK_KEY)).toBeNull();
    expect(logout).toHaveBeenCalled();

    // And the path that matters when nobody touches anything: a 401 on the
    // token probe or a 1008 close calls onLock, which must reach the gate.
    await act(async () => {
      useTerminalLock.setState({ unlocked: true });
    });
    const socket = mockSockets[mockSockets.length - 1];
    await act(async () => {
      socket.opts.onLock('session expired');
    });

    expect(texts(t)).toContain('Unlock terminal');
  });

  test('leaving the screen detaches the AppState listener AND closes the socket', async () => {
    const t = await mount();
    measure(t);
    const socket = mockSockets[0];
    expect(socket.attachAppState).toHaveBeenCalledTimes(1);

    act(() => t.unmount());
    tree = null;

    expect(socket.detach).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
