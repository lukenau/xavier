// The demo's doors and its way out: the Explore demo button and the reserved
// `demo` address on the server screen, the first-run card on Home, a relaunch
// that comes back into the demo, and Exit demo from Config and the server
// screen — which must leave nothing of the demo behind.
import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { api, clearUserApiBase, resolveApiBase } from '../lib/api';
import { ServerPage } from '../components/config/ServerPage';
import { DEMO_STORAGE_KEY, demoReady, isDemoActive, resetDemoModeForTests, setDemoFlag } from './mode';
import { HomeCard } from './HomeCard';
import { DemoConfigRow } from './ConfigRow';
import { DemoBadge } from './DemoBadge';
import { enterDemo, exitDemo } from './session';
import { resetDemoWorld } from './server';
import { inDemo, LiveDemo } from './ServerOnly';

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useEffect } = require('react');
  return {
    router: { push: jest.fn(), dismissTo: jest.fn(), navigate: jest.fn() },
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
    usePathname: () => '/',
    useIsFocused: () => true,
    useScrollToTop: () => {},
  };
});

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const fetchSpy = jest.fn();

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function render(node: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  });
  mounted.push(tree);
  return tree;
}

function press(tree: TestRenderer.ReactTestRenderer, label: string) {
  const found = tree.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  expect(found).toHaveLength(1);
  return act(async () => {
    found[0].props.onPress();
    // The handlers are async (storage, the switch); let them land inside act.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await clearUserApiBase();
  resetDemoModeForTests();
  resetDemoWorld();
  jest.clearAllMocks();
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(async () => {
  await act(async () => {
    mounted.splice(0).forEach((tree) => tree.unmount());
  });
  resetDemoWorld();
  resetDemoModeForTests();
});

test('Explore demo on the server screen enters the demo and goes Home', async () => {
  const tree = await render(<ServerPage />);
  await press(tree, 'Explore demo');
  await until(() => isDemoActive());

  expect(await AsyncStorage.getItem(DEMO_STORAGE_KEY)).toBe('1');
  await until(() => (router.dismissTo as jest.Mock).mock.calls.length > 0);
  expect(router.dismissTo).toHaveBeenCalledWith('/');
});

test('typing "demo" as the server address enters the demo too', async () => {
  const tree = await render(<ServerPage />);
  await act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(' Demo ');
  });
  await press(tree, 'Save server address');
  await until(() => isDemoActive());
  expect(await AsyncStorage.getItem(DEMO_STORAGE_KEY)).toBe('1');
  // Not a server address: nothing was saved as one.
  expect(await AsyncStorage.getItem('hub.apiBase')).toBeNull();
});

test('the first-run card on Home offers the demo when no server is set', async () => {
  const tree = await render(<HomeCard />);
  await until(() => tree.root.findAllByProps({ testID: 'first-run-card' }).length > 0);
  await press(tree, 'Explore demo');
  await until(() => isDemoActive());
  await until(() => tree.root.findAllByProps({ testID: 'demo-home-card' }).length > 0);
  expect(tree.root.findAllByProps({ testID: 'first-run-card' })).toHaveLength(0);
});

test('a server address already saved means no first-run card', async () => {
  await AsyncStorage.setItem('hub.apiBase', 'https://hub.example.org');
  const tree = await render(<HomeCard />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(tree.root.findAllByProps({ testID: 'first-run-card' })).toHaveLength(0);
});

test('the demo survives a relaunch, and reads stay off the network', async () => {
  await enterDemo();
  // A relaunch: memory is gone, storage is not.
  resetDemoModeForTests();
  expect(isDemoActive()).toBe(false);
  await demoReady();
  expect(isDemoActive()).toBe(true);

  const health = await api.health();
  expect(health).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a cold launch in the demo never sends its first request to a server', async () => {
  await AsyncStorage.setItem(DEMO_STORAGE_KEY, '1');
  // No one has read the flag yet; the request itself waits for it.
  const vitals = await api.vitals();
  expect(vitals).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('the badge is shown only in the demo', async () => {
  const outside = await render(<DemoBadge />);
  expect(outside.root.findAllByProps({ testID: 'demo-badge' })).toHaveLength(0);
  await act(async () => {
    await setDemoFlag(true);
  });
  const inside = await render(<DemoBadge />);
  expect(inside.root.findAllByProps({ testID: 'demo-badge' }).length).toBeGreaterThan(0);
});

test('a server-only route says where it runs in the demo, and is itself outside it', async () => {
  const LiveRoute = inDemo(() => <Text>the real Live page</Text>, LiveDemo);
  const outside = await render(<LiveRoute />);
  expect(JSON.stringify(outside.toJSON())).toContain('the real Live page');

  await act(async () => {
    await setDemoFlag(true);
  });
  const inside = await render(<LiveRoute />);
  const shown = JSON.stringify(inside.toJSON());
  expect(shown).toContain('Runs on your own server');
  expect(shown).not.toContain('the real Live page');
});

test('Exit demo in Config leaves the demo, clears its state and returns to the address screen', async () => {
  await enterDemo();
  const brief = await api.brief();
  const item = brief.buckets.now[0];
  await api.dismissBriefItem(item.item_id, 'dismiss', item.token as string, brief.date);
  const demoThread = (await api.chatBootstrap()).threads[0].id;
  await AsyncStorage.setItem(`chat.tail.${demoThread}`, '{}');
  await AsyncStorage.setItem('chat.tail.thr_8f2a91c0d3', '{}');

  const tree = await render(<DemoConfigRow />);
  await press(tree, 'Exit demo');
  await until(() => !isDemoActive());
  await until(() => (router.push as jest.Mock).mock.calls.length > 0);

  expect(router.push).toHaveBeenCalledWith('/config/server');
  expect(await AsyncStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
  expect(await AsyncStorage.getItem(`chat.tail.${demoThread}`)).toBeNull();
  // A real thread's cached tail is not the demo's to remove.
  expect(await AsyncStorage.getItem('chat.tail.thr_8f2a91c0d3')).toBe('{}');
  expect(tree.root.findAllByProps({ testID: 'demo-config-exit' })).toHaveLength(0);

  // Back in, the world starts fresh: the dismissal is gone with the old one.
  await act(async () => {
    await enterDemo();
  });
  const again = await api.brief();
  expect(again.buckets.now.map((i) => i.item_id)).toContain(item.item_id);
});

test('saving a real address from inside the demo leaves the demo for that server', async () => {
  await enterDemo();
  const tree = await render(<ServerPage />);
  await act(async () => {
    tree.root.findByType(TextInput).props.onChangeText('https://hub.example.net');
  });
  await press(tree, 'Save server address');
  await until(() => !isDemoActive());
  expect(await AsyncStorage.getItem('hub.apiBase')).toBe('https://hub.example.net');
  expect(resolveApiBase()).toEqual({ base: 'https://hub.example.net', source: 'user' });
  expect(await AsyncStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
});

test('Exit demo on the server screen keeps the address saved before the demo', async () => {
  await AsyncStorage.setItem('hub.apiBase', 'https://hub.example.org');
  await enterDemo();
  const tree = await render(<ServerPage />);
  await press(tree, 'Exit demo');
  await until(() => !isDemoActive());
  expect(await AsyncStorage.getItem('hub.apiBase')).toBe('https://hub.example.org');
  await exitDemo();
});
