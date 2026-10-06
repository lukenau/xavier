// Wiring-level regression test for the sheet.tsx finding: the vulnerability
// was never in resolveBriefUri itself, it was that app/(home)/sheet.tsx
// forgot to call it. A pure-function test of resolveBriefUri would not have
// caught that class of bug — this test exercises the actual route component
// (mocking only `useLocalSearchParams`, the one thing that needs a router)
// so a future edit that drops the validation call is caught here too.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: jest.fn(),
}));

// react-native-webview reaches for a native module at import time
// (TurboModuleRegistry.getEnforcing), which doesn't exist under jest — stub
// it with a plain View. Nothing here asserts on WebView's own behaviour
// (that's "needs device verify", per task-19-report.md); this test only
// checks WHICH uri BriefWebView is mounted with, which happens one level up.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: React.forwardRef((props: object, _ref: unknown) => React.createElement(View, props)) };
});

import TestRenderer, { act } from 'react-test-renderer';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { BriefWebView } from './BriefWebView';
import { StatePanel } from '../shell';
// eslint-disable-next-line import/no-relative-parent-imports
import BriefSheetScreen from '../../../app/(home)/sheet';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function renderSheet(params: { uri?: string; title?: string }) {
  (useLocalSearchParams as jest.Mock).mockReturnValue(params);
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <BriefSheetScreen />
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

test('an off-host uri (the attack) never reaches BriefWebView — the error panel renders instead', () => {
  const renderer = renderSheet({ uri: 'https://attacker.example/login', title: 'Hub' });
  expect(renderer.root.findAllByType(BriefWebView)).toHaveLength(0);
  expect(renderer.root.findByType(StatePanel).props.title).toBe('Nothing to show');
});

test('a javascript: uri never reaches BriefWebView', () => {
  const renderer = renderSheet({ uri: 'javascript:alert(1)' });
  expect(renderer.root.findAllByType(BriefWebView)).toHaveLength(0);
  expect(renderer.root.findByType(StatePanel).props.title).toBe('Nothing to show');
});

test('a legitimate same-host /my-pages/… uri DOES reach BriefWebView, resolved to an absolute URL', () => {
  const renderer = renderSheet({ uri: '/my-pages/briefing-2026-09-09/', title: 'Daily brief' });
  const webView = renderer.root.findByType(BriefWebView);
  expect(webView.props.uri).toBe('https://hub.example.com/my-pages/briefing-2026-09-09/');
});

test('a missing uri shows the "no URL provided" detail, not the generic one', () => {
  const renderer = renderSheet({});
  expect(renderer.root.findByType(StatePanel).props.detail).toBe('No page URL was provided.');
});
