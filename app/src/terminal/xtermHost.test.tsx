// react-native-webview reaches for a native module at import time, and no
// WKWebView exists here anyway: the mock records what would have been
// evaluated in the page. What this file pins is the RN half of the bridge —
// which strings are injected, when, and the ack ledger across a reload.
const mockInjected: string[] = [];
const mockReloads = { count: 0 };

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef((props: object, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: (js: string) => mockInjected.push(js),
        reload: () => {
          mockReloads.count += 1;
        },
      }));
      return React.createElement(View, props);
    }),
  };
});

import { createRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { decideTerminalNavigation, XtermHost, type XtermHostHandle } from './xtermHost';
import { jsFontSize, jsTheme, jsViewportHeight, type XtermTheme } from './xtermHtml';
import { bytesToBase64 } from './base64';
import { resolveToken } from '../theme/useTheme';

// Both themes come from the token table, so this file asserts "the CURRENT
// --term-* values are what reach the page", not a frozen palette.
const termTheme = (scheme: 'dark' | 'light'): XtermTheme => ({
  background: resolveToken(scheme, 'term-bg'),
  foreground: resolveToken(scheme, 'term-fg'),
  cursor: resolveToken(scheme, 'term-cursor'),
  cursorAccent: resolveToken(scheme, 'term-bg'),
  selectionBackground: resolveToken(scheme, 'term-selection'),
});
const DARK = termTheme('dark');
const LIGHT = termTheme('light');

const bytes = (...values: number[]) => new Uint8Array(values);

interface Harness {
  tree: TestRenderer.ReactTestRenderer;
  ref: React.RefObject<XtermHostHandle | null>;
  onSize: jest.Mock;
  onAck: jest.Mock;
  onData: jest.Mock;
  send: (message: unknown) => void;
  webview: () => TestRenderer.ReactTestInstance;
  update: (props: Partial<{ theme: XtermTheme; fontSize: number; viewportHeight: number }>) => void;
}

function mount(): Harness {
  const ref = createRef<XtermHostHandle>();
  const onSize = jest.fn();
  const onAck = jest.fn();
  const onData = jest.fn();
  const props = { theme: DARK, fontSize: 13, height: 500, viewportHeight: 500 };
  let tree!: TestRenderer.ReactTestRenderer;
  const element = (extra: Partial<typeof props>) => (
    <XtermHost
      ref={ref}
      {...props}
      {...extra}
      onSize={onSize}
      onAck={onAck}
      onData={onData}
    />
  );
  act(() => {
    tree = TestRenderer.create(element({}));
  });
  const webview = () => tree.root.findAll((n) => typeof n.props.onMessage === 'function')[0];
  return {
    tree,
    ref,
    onSize,
    onAck,
    onData,
    webview,
    send: (message) =>
      act(() => webview().props.onMessage({ nativeEvent: { data: JSON.stringify(message) } })),
    update: (extra) => act(() => tree.update(element(extra))),
  };
}

let harness: Harness | null = null;
beforeEach(() => {
  mockInjected.length = 0;
  mockReloads.count = 0;
});
afterEach(() => {
  act(() => harness?.tree.unmount());
  harness = null;
});

test('only about:blank may load', () => {
  expect(decideTerminalNavigation('about:blank')).toBe(true);
  expect(decideTerminalNavigation('')).toBe(true);
  expect(decideTerminalNavigation('https://hub.example.com/')).toBe(false);
  expect(decideTerminalNavigation('file:///etc/passwd')).toBe(false);
});

test('nothing is injected before the page says it is ready', () => {
  harness = mount();
  harness.update({ fontSize: 16, theme: LIGHT, viewportHeight: 400 });
  expect(mockInjected).toEqual([]);
});

test('on ready the live theme, font size and viewport are pushed', () => {
  harness = mount();
  harness.send({ t: 'ready' });
  expect(mockInjected).toEqual([jsTheme(DARK), jsFontSize(13), jsViewportHeight(500)]);
});

test('a theme or font change after ready is pushed without rebuilding the page', () => {
  harness = mount();
  const source = harness.webview().props.source;
  harness.send({ t: 'ready' });
  mockInjected.length = 0;

  harness.update({ theme: LIGHT });
  harness.update({ theme: LIGHT, fontSize: 15 });
  harness.update({ theme: LIGHT, fontSize: 15, viewportHeight: 260 });

  expect(mockInjected).toEqual([jsTheme(LIGHT), jsFontSize(15), jsViewportHeight(260)]);
  // Same `source` object: a new one would reload the page and wipe scrollback.
  expect(harness.webview().props.source).toBe(source);
});

describe('output', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a frame of writes becomes one injected call carrying the ack count', () => {
    harness = mount();
    harness.send({ t: 'ready' });
    mockInjected.length = 0;

    act(() => {
      harness!.ref.current?.write(bytes(104, 105), false);
      harness!.ref.current?.write(bytes(33), true);
    });
    act(() => jest.advanceTimersByTime(16));

    expect(mockInjected).toEqual([`window.__w("${bytesToBase64(bytes(104, 105, 33))}",1);true;`]);
  });

  test('the page reporting the batch releases exactly that many acks', () => {
    harness = mount();
    act(() => {
      harness!.ref.current?.write(bytes(1), true);
      harness!.ref.current?.write(bytes(2), true);
    });
    act(() => jest.advanceTimersByTime(16));
    expect(harness.onAck).not.toHaveBeenCalled();

    harness.send({ t: 'ack', n: 2 });

    expect(harness.onAck).toHaveBeenCalledTimes(2);
  });

  test('a dead content process reloads AND settles the acks those writes owed', () => {
    // Without the settle, ttyd's window stays above FLOW_HIGH and the pty
    // never resumes for the rest of the session.
    harness = mount();
    act(() => harness!.ref.current?.write(bytes(1), true));
    act(() => jest.advanceTimersByTime(16));

    act(() => harness!.webview().props.onContentProcessDidTerminate());

    expect(harness.onAck).toHaveBeenCalledTimes(1);
    expect(mockReloads.count).toBe(1);
  });

  test('bytes arriving DURING the reload are acked, not stranded', () => {
    // The wedge this guards: the reload is async, so output keeps coming
    // while the new page is still loading. Injected then, it vanishes into a
    // page with no window.__w — and eleven lost acks (FLOW_HIGH is 10) leave
    // the pty paused for the rest of the session.
    harness = mount();
    harness.send({ t: 'ready' });
    act(() => harness!.webview().props.onContentProcessDidTerminate());
    mockInjected.length = 0;

    act(() => {
      for (let i = 0; i < 11; i += 1) harness!.ref.current?.write(bytes(i), true);
    });
    act(() => jest.advanceTimersByTime(16));

    expect(mockInjected).toHaveLength(0);
    expect(harness.onAck).toHaveBeenCalledTimes(11);

    // …and once the reloaded page reports ready, output flows again.
    harness.send({ t: 'ready' });
    mockInjected.length = 0;
    act(() => harness!.ref.current?.write(bytes(42), false));
    act(() => jest.advanceTimersByTime(16));

    expect(mockInjected).toHaveLength(1);
  });

  test('unmounting settles the acks too', () => {
    harness = mount();
    act(() => harness!.ref.current?.write(bytes(1), true));
    act(() => jest.advanceTimersByTime(16));
    const onAck = harness.onAck;

    act(() => harness!.tree.unmount());
    harness = null;

    expect(onAck).toHaveBeenCalledTimes(1);
  });
});

test('size and data messages reach the screen', () => {
  harness = mount();
  harness.send({ t: 'size', cols: 92, rows: 31 });
  harness.send({ t: 'data', d: '\x03' });

  expect(harness.onSize.mock.calls).toEqual([[92, 31]]);
  expect(harness.onData.mock.calls).toEqual([['\x03']]);
});

test('a malformed message is ignored', () => {
  harness = mount();
  act(() => harness!.webview().props.onMessage({ nativeEvent: { data: 'garbage' } }));
  expect(harness.onSize).not.toHaveBeenCalled();
  expect(harness.onData).not.toHaveBeenCalled();
  expect(harness.onAck).not.toHaveBeenCalled();
});

test('the WebView is display-only', () => {
  // Each of these is load-bearing and invisible as text: a scrollable,
  // bouncing, inset-adjusting WebView with a keyboard accessory is the exact
  // configuration the PWA spent months fighting.
  harness = mount();
  const props = harness.webview().props;
  expect(props.scrollEnabled).toBe(false);
  expect(props.bounces).toBe(false);
  expect(props.automaticallyAdjustContentInsets).toBe(false);
  expect(props.hideKeyboardAccessoryView).toBe(true);
  expect(props.dataDetectorTypes).toBe('none');
  expect(props.source.baseUrl).toBe('about:blank');
});
