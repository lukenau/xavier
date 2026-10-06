// Demo mode's switch: whether this install is showing the bundled fictional
// hub instead of talking to a server. It exists for App Review, whose reviewers
// cannot run a server or join a tailnet, and for anyone who wants to look before
// installing one.
//
// Deliberately dependency-free (AsyncStorage and zustand only): api.ts reads it
// on every call, so it must not import anything that imports api.ts back.
//
// The flag is persisted, so a relaunch comes back into the demo, and it is read
// before the first request leaves: api.ts awaits `demoReady()` ahead of every
// call, which is what keeps a cold launch in demo mode from sending even one
// request to whatever server address was stored before.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

export const DEMO_STORAGE_KEY = 'hub.demo';

/** Typed into Config › Server address, this opens the demo instead of a server. */
export const DEMO_ADDRESS = 'demo';

/** Where the real thing lives — the server-only screens point here. */
export const DEMO_REPO = 'github.com/lukenau/xavier';

/** The hub origin while the demo is on (api.ts's HUB_ORIGIN). `.invalid` is
 * reserved never to resolve (RFC 2606), so a page or media URL built from it
 * cannot reach a real server, whatever address was stored before. */
export const DEMO_ORIGIN = 'https://demo.invalid';

interface DemoModeState {
  active: boolean;
  /** False until the stored flag has been read; screens that must not guess
   * (the first-run card) wait for it. */
  hydrated: boolean;
}

export const useDemoMode = create<DemoModeState>(() => ({ active: false, hydrated: false }));

let hydration: Promise<void> | null = null;

/** Reads the stored flag once; every later call shares the same promise. A read
 * that fails leaves the demo off — the app then behaves exactly as before the
 * demo existed. */
export function demoReady(): Promise<void> {
  if (!hydration) {
    hydration = Promise.resolve()
      .then(() => AsyncStorage.getItem(DEMO_STORAGE_KEY))
      .then(
        (stored) => useDemoMode.setState({ active: stored === '1', hydrated: true }),
        () => useDemoMode.setState({ hydrated: true }),
      );
  }
  return hydration;
}

export function isDemoActive(): boolean {
  return useDemoMode.getState().active;
}

/** `demo`, in any case and with stray spaces — the reserved setup string. */
export function isDemoAddress(input: string): boolean {
  return input.trim().toLowerCase() === DEMO_ADDRESS;
}

/** Flips the flag in memory first, so the very next request already goes the
 * new way, then persists it. session.ts owns everything else that has to
 * happen around a switch. */
export async function setDemoFlag(active: boolean): Promise<void> {
  useDemoMode.setState({ active, hydrated: true });
  hydration = Promise.resolve();
  if (active) await AsyncStorage.setItem(DEMO_STORAGE_KEY, '1');
  else await AsyncStorage.removeItem(DEMO_STORAGE_KEY);
}

/** Test-only: forget the flag and the read of it, as a fresh launch would. */
export function resetDemoModeForTests(): void {
  hydration = null;
  useDemoMode.setState({ active: false, hydrated: false });
}
