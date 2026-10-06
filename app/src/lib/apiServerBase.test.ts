// The runtime server-URL setting's resolution order: user-set (Config ›
// Server address) > build-time expo.extra.apiBase > DEFAULT_API_BASE — and
// the fact that every api call path re-resolves at call time, so a change
// takes effect without a relaunch. api.test.ts covers the call surface at
// the default base; this file covers the ORDER.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  API_BASE_STORAGE_KEY,
  HUB_ORIGIN,
  api,
  clearUserApiBase,
  getUserApiBase,
  loadStoredApiBase,
  resolveApiBase,
  setUserApiBase,
} from './api';

const DEFAULT_BASE = 'https://hub.example.com';
const BUILD_BASE = 'https://build.example.com';
const USER_BASE = 'https://mine.example.com';

/** Mutable stand-in for expo-constants' expoConfig. Defined INSIDE the
 * factory (jest hoists it above this file's declarations, so out-of-scope
 * state would be TDZ by the time the factory runs); tests reach it through
 * requireMock. */
jest.mock('expo-constants', () => {
  const state = { extra: undefined as { apiBase?: string } | undefined };
  return {
    __esModule: true,
    state,
    default: {
      get expoConfig() {
        return state.extra ? { extra: state.extra } : undefined;
      },
    },
  };
});

/** This file's own in-memory AsyncStorage, overriding jest.setup.js's shipped
 * mock so the "relaunch" test can inspect the store directly. The Map lives
 * on globalThis for the same hoisting reason as the constants state above,
 * and so it survives jest.resetModules. */
jest.mock('@react-native-async-storage/async-storage', () => {
  const g = globalThis as { __serverUrlTestStore?: Map<string, string> };
  g.__serverUrlTestStore = g.__serverUrlTestStore ?? new Map<string, string>();
  const store = g.__serverUrlTestStore;
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
    },
  };
});

const constantsMock = jest.requireMock('expo-constants') as unknown as {
  state: { extra?: { apiBase?: string } };
};

function setBuildBase(apiBase: string | undefined): void {
  constantsMock.state.extra = apiBase === undefined ? undefined : { apiBase };
}

const store = () => (globalThis as { __serverUrlTestStore?: Map<string, string> }).__serverUrlTestStore!;

beforeEach(async () => {
  setBuildBase(undefined);
  await clearUserApiBase();
  store().clear();
  global.fetch = jest.fn();
});

afterEach(() => {
  // clearAllMocks, not resetAllMocks: reset would strip the implementations
  // jest.fn(impl) in the AsyncStorage factory above carry, and later tests
  // would silently read/write nothing.
  jest.clearAllMocks();
});

describe('resolution order: user-set > build-time extra > shipped default', () => {
  it('falls all the way through to the shipped default when nothing is set', () => {
    expect(resolveApiBase()).toEqual({ base: DEFAULT_BASE, source: 'default' });
    expect(HUB_ORIGIN).toBe(DEFAULT_BASE);
  });

  it('uses expo.extra.apiBase when the build provides one and nothing is user-set', () => {
    setBuildBase(BUILD_BASE);
    expect(resolveApiBase()).toEqual({ base: BUILD_BASE, source: 'build' });
  });

  it('the user-set value wins over the build-time extra', async () => {
    setBuildBase(BUILD_BASE);
    await setUserApiBase(USER_BASE);
    expect(resolveApiBase()).toEqual({ base: USER_BASE, source: 'user' });
    expect(getUserApiBase()).toBe(USER_BASE);
    expect(HUB_ORIGIN).toBe(USER_BASE);
  });

  it('clear reverts to the build-time extra immediately', async () => {
    setBuildBase(BUILD_BASE);
    await setUserApiBase(USER_BASE);
    await clearUserApiBase();
    expect(resolveApiBase()).toEqual({ base: BUILD_BASE, source: 'build' });
    expect(HUB_ORIGIN).toBe(BUILD_BASE);
    expect(getUserApiBase()).toBeNull();
  });
});

describe('persistence', () => {
  it('setUserApiBase stores the normalized url under the storage key', async () => {
    await setUserApiBase(`${USER_BASE}/`);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(API_BASE_STORAGE_KEY, USER_BASE);
    expect(store().get(API_BASE_STORAGE_KEY)).toBe(USER_BASE);
  });

  it('loadStoredApiBase restores the user-set server after a relaunch', async () => {
    await setUserApiBase(USER_BASE);
    // Simulate a relaunch: fresh module registry, fresh in-memory override —
    // only the AsyncStorage store survives.
    jest.resetModules();
    setBuildBase(BUILD_BASE);
    // `require`, not `await import()`: jest runs this project's CommonJS
    // transform without --experimental-vm-modules, so a dynamic import()
    // throws "A dynamic import callback was invoked without
    // --experimental-vm-modules". After jest.resetModules() a plain require
    // re-evaluates the module and gives the same fresh registry (the pattern
    // gate.test.ts uses for exactly this).
    const fresh = require('./api') as typeof import('./api');
    expect(fresh.getUserApiBase()).toBeNull();
    await fresh.loadStoredApiBase();
    expect(fresh.resolveApiBase()).toEqual({ base: USER_BASE, source: 'user' });
  });

  it('clearUserApiBase removes the stored key', async () => {
    await setUserApiBase(USER_BASE);
    await clearUserApiBase();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(API_BASE_STORAGE_KEY);
    expect(store().has(API_BASE_STORAGE_KEY)).toBe(false);
  });

  it('a stored value that no longer validates is ignored, not trusted', async () => {
    store().set(API_BASE_STORAGE_KEY, 'http://not-localhost.example.com');
    await loadStoredApiBase();
    expect(resolveApiBase()).toEqual({ base: DEFAULT_BASE, source: 'default' });
    expect(getUserApiBase()).toBeNull();
  });
});

describe('the user-set server actually re-points the app', () => {
  it('api call paths resolve against the effective base at call time', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
    setBuildBase(BUILD_BASE);
    await setUserApiBase(USER_BASE);
    await api.health();
    expect(global.fetch).toHaveBeenCalledWith(`${USER_BASE}/api/health`, { credentials: 'include' });
  });

  it('after clear, call paths fall back to the build-time base again', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
    setBuildBase(BUILD_BASE);
    await setUserApiBase(USER_BASE);
    await clearUserApiBase();
    await api.health();
    expect(global.fetch).toHaveBeenCalledWith(`${BUILD_BASE}/api/health`, { credentials: 'include' });
  });
});

describe('setUserApiBase validates before it persists', () => {
  it('an invalid URL is rejected with the reason and nothing changes', async () => {
    setBuildBase(BUILD_BASE);
    const check = await setUserApiBase('http://hub.example.com');
    expect(check.ok).toBe(false);
    expect(getUserApiBase()).toBeNull();
    expect(resolveApiBase()).toEqual({ base: BUILD_BASE, source: 'build' });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(store().has(API_BASE_STORAGE_KEY)).toBe(false);
  });
});
