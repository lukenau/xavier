// expo-router's useFocusEffect needs a navigation container; "always focused"
// is the semantics under test here, so it is shimmed to a plain effect.
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(callback, [callback]);
  },
}));

import TestRenderer, { act } from 'react-test-renderer';
import { TabBarVisibilityProvider, useHideTabBar, useTabBarHidden } from './tabBar';

let hidden = false;

function Probe() {
  hidden = useTabBarHidden();
  return null;
}

function Detail({ enabled = true }: { enabled?: boolean }) {
  useHideTabBar(enabled);
  return null;
}

function Tree({ a, b }: { a: boolean; b: boolean }) {
  return (
    <TabBarVisibilityProvider>
      <Probe />
      {a ? <Detail /> : null}
      {b ? <Detail /> : null}
    </TabBarVisibilityProvider>
  );
}

beforeEach(() => {
  hidden = false;
});

test('the tab bar is visible until a pushed screen asks for it to go', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Tree a={false} b={false} />);
  });
  expect(hidden).toBe(false);

  act(() => renderer.update(<Tree a b={false} />));
  expect(hidden).toBe(true);

  act(() => renderer.update(<Tree a={false} b={false} />));
  expect(hidden).toBe(false);
});

test('a second pushed screen keeps the bar hidden after the first unmounts', () => {
  // Pushing detail B over detail A runs A's blur cleanup and B's focus effect
  // in an order react-navigation does not promise. A boolean loses that race
  // in one of the two orders and the bar flashes back in mid-push; the
  // provider counts instead.
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Tree a b={false} />);
  });
  expect(hidden).toBe(true);

  act(() => renderer.update(<Tree a b />));
  expect(hidden).toBe(true);

  // A pops while B is still on screen.
  act(() => renderer.update(<Tree a={false} b />));
  expect(hidden).toBe(true);

  act(() => renderer.update(<Tree a={false} b={false} />));
  expect(hidden).toBe(false);
});

test('useHideTabBar(false) is a no-op, so a pushed screen can keep the bar', () => {
  act(() => {
    TestRenderer.create(
      <TabBarVisibilityProvider>
        <Probe />
        <Detail enabled={false} />
      </TabBarVisibilityProvider>,
    );
  });
  expect(hidden).toBe(false);
});

test('the counter never goes negative', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Tree a b />);
  });
  act(() => renderer.update(<Tree a={false} b={false} />));
  expect(hidden).toBe(false);
  act(() => renderer.update(<Tree a b={false} />));
  expect(hidden).toBe(true);
});
