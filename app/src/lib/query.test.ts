jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

import { createElement } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TestRenderer, { act } from 'react-test-renderer';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
  useQuery,
} from '@tanstack/react-query';
import { persistQueryClientSave, persistQueryClientRestore } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  QUERY_TUNING,
  usePoll,
  refreshAll,
  queryClient,
  wireFocusManager,
  wireOnlineManager,
  asyncStoragePersister,
  shouldPersistQuery,
  OFFLINE_CACHED_QUERY_NAMESPACES,
  OFFLINE_CACHE_MAX_AGE_MS,
} from './query';

// Every read that actually goes through React Query in the PWA (PARITY-INVENTORY
// §3.1), reduced to its query-key namespace. Excludes surfaces §3.1 documents as
// NOT React Query: connectorOauthStatus (raw 3s setInterval poll), /terminal/token
// (cookie, no query), /my-pages/{slug} (iframe navigation), /oura/ (static page).
const SECTION_3_1_QUERY_NAMESPACES = [
  'health',
  'vitals',
  'sessions',
  'session', // /api/sessions/{id}/messages
  'pairing',
  'cron',
  'cron-logs',
  'cron-costs',
  'recurring-costs', // added with the Cost tab's fixed-spend foot card
  'kanban',
  'backups',
  'my-pages',
  'feed',
  'decisions',
  'spend-summary',
  'spend-timeseries',
  'openrouter-credits',
  'browser-sessions',
  'finance',
  'config-full',
  'advisor',
  'chat-models',
  'topics-routing',
  'connectors',
  'passkey-status',
  'skills',
  'plugins',
  'mcp',
  'doctor',
  'memory',
  'tmux-sessions',
  'tmux-history',
  'fs-roots',
  'fs-browse',
  'fs-read',
  // Native-only: the daily brief has no PWA useQuery call site to be a twin of
  // (the web brief is a server-rendered page), so it is listed here as an
  // addition to §3.1 rather than a row copied out of it.
  'brief',
  // Native-only as well: the calendar is a surface the PWA never had.
  'calendar',
];

describe('QUERY_TUNING coverage (PARITY-INVENTORY §3.1)', () => {
  const coveredNamespaces = new Set(Object.values(QUERY_TUNING).map((t) => t.queryKeyExample[0]));

  test.each(SECTION_3_1_QUERY_NAMESPACES)('%s has at least one QUERY_TUNING entry', (namespace) => {
    expect(coveredNamespaces.has(namespace)).toBe(true);
  });

  test('no stray namespaces beyond §3.1 (catches typos in the table)', () => {
    expect([...coveredNamespaces].sort()).toEqual([...SECTION_3_1_QUERY_NAMESPACES].sort());
  });

  test.each(Object.entries(QUERY_TUNING))('%s cites a real PWA file:line source and a real queryKeyExample', (_id, tuning) => {
    // A malformed or invented citation (typo'd filename, missing line number,
    // a bare description with no file:line at all) must fail this, not just
    // "source is a non-empty string" — that padded 50 tests without asserting
    // anything a bad citation couldn't sail through.
    expect(tuning.source).toMatch(/\.tsx?:\d+(-\d+)?/);
    expect(Array.isArray(tuning.queryKeyExample)).toBe(true);
    expect(tuning.queryKeyExample.length).toBeGreaterThan(0);
  });

  test.each(Object.entries(QUERY_TUNING).filter(([, t]) => !t.staleTimeOverridden))(
    '%s: staleTimeOverridden:false carries the exact 20_000ms global default (main.tsx:9)',
    (_id, tuning) => {
      expect(tuning.staleTime).toBe(20_000);
    },
  );

  test.each(Object.entries(QUERY_TUNING).filter(([, t]) => !t.retryOverridden))(
    '%s: retryOverridden:false carries the exact retry:1 global default (main.tsx:11)',
    (_id, tuning) => {
      expect(tuning.retry).toBe(1);
    },
  );

  test('the cron-logs collision: both entries share the literal key but different limits/tuning', () => {
    const home = QUERY_TUNING['cron-logs-home'];
    const ops = QUERY_TUNING['cron-logs-ops'];
    expect(home.queryKeyExample).toEqual(['cron-logs']);
    expect(ops.queryKeyExample).toEqual(['cron-logs']);
    // Same array key (JSON-stable — this is what makes it a real cache collision).
    expect(JSON.stringify(home.queryKeyExample)).toBe(JSON.stringify(ops.queryKeyExample));
    expect(home.staleTime).not.toBe(ops.staleTime);
    expect(home.note).toMatch(/DELIBERATE/);
    expect(ops.note).toMatch(/DELIBERATE/);
  });
});

// Polls `condition` under `act()` until it's true, rather than assuming a
// fixed number of microtask ticks flushed a real async hook's state. A bare
// `await Promise.resolve()` (or two) races the query's actual settle time:
// idle-machine runs win that race every time, but under full-suite load
// (1,400+ tests, parallel workers) it flakes — the exact shape of the bug
// this helper exists to rule out, not paper over with a longer fixed wait.
async function waitFor(condition: () => boolean, { timeoutMs = 5000, intervalMs = 10 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not satisfied within ${timeoutMs}ms`);
    }
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
  }
}

describe('usePoll: real useQuery wiring, not a mock of our own hook', () => {
  function TestHarness({ onRender }: { onRender: (state: ReturnType<typeof useQuery>) => void }) {
    const result = usePoll(['test-poll'], () => Promise.resolve('ok'), QUERY_TUNING.health);
    onRender(result);
    return null;
  }

  test('resolves real data through the real QueryClient, with QUERY_TUNING options applied', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let latest: ReturnType<typeof useQuery> | undefined;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = TestRenderer.create(
          createElement(
            QueryClientProvider,
            { client },
            createElement(TestHarness, { onRender: (r) => (latest = r) }),
          ),
        );
      });

      // Wait for the actual condition — not a fixed number of ticks — so
      // this doesn't flake under full-suite load (see waitFor above).
      await waitFor(() => latest?.status === 'success');

      expect(latest?.status).toBe('success');
      expect(latest?.data).toBe('ok');

      // The query was registered under exactly the key/options usePoll was given.
      // `retry` lives on the shared Query cache entry; `staleTime` is an
      // observer-level concept in TanStack v5 (each observer on a key can set
      // its own — the mechanism the cron-logs collision above depends on), so
      // it's read off the live QueryObserver, not the Query itself.
      const query = client.getQueryCache().find({ queryKey: ['test-poll'] });
      expect(query).toBeDefined();
      expect((query!.options as { retry?: number | false }).retry).toBe(QUERY_TUNING.health.retry);
      expect(query!.observers[0]?.options.staleTime).toBe(QUERY_TUNING.health.staleTime);
      // Guards the other half of the same bug class that field-renaming
      // (staleTimeMs/refetchIntervalMs vs. real react-query option names)
      // already caused once: a rename of only refetchInterval would still
      // leave the staleTime assertion above green.
      expect(query!.observers[0]?.options.refetchInterval).toBe(QUERY_TUNING.health.refetchInterval);
    } finally {
      // QUERY_TUNING.health carries a 60s refetchInterval — unmount + clear so
      // the scheduled background refetch timer doesn't leak past this test.
      act(() => renderer?.unmount());
      client.clear();
    }
  });
});

describe('refreshAll', () => {
  test('invalidates every cached query, app-wide, with no key filter (Header.tsx:106-108 parity)', async () => {
    const client = new QueryClient();
    try {
      client.setQueryData(['health'], { ok: true });
      client.setQueryData(['config-full'], { sections: [] }); // a different "tab"'s query
      expect(client.getQueryState(['health'])?.isInvalidated).toBeFalsy();
      expect(client.getQueryState(['config-full'])?.isInvalidated).toBeFalsy();

      await refreshAll(client);

      expect(client.getQueryState(['health'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['config-full'])?.isInvalidated).toBe(true);
    } finally {
      // Every Query schedules a 5-minute gcTime setTimeout on creation
      // (removable.ts); clear() destroys each query and cancels it. Without
      // this, the test process hangs (visible only with real timers/no
      // --forceExit) until those timers fire.
      client.clear();
    }
  });

  test('defaults to the module-level singleton queryClient when called with no argument', async () => {
    try {
      queryClient.setQueryData(['vitals'], { agent: {} });
      await refreshAll();
      expect(queryClient.getQueryState(['vitals'])?.isInvalidated).toBe(true);
    } finally {
      queryClient.clear();
    }
  });
});

describe('offline persistence: AsyncStorage persister round-trip', () => {
  test('persistClient/restoreClient round-trips a seeded cache entry through the real persister', async () => {
    const seeded = {
      timestamp: Date.now(),
      buster: '',
      clientState: { queries: [{ queryKey: ['health'], queryHash: '["health"]', state: { data: { ok: true } } }], mutations: [] },
    };

    await asyncStoragePersister.persistClient(seeded as never);
    const restored = await asyncStoragePersister.restoreClient();

    expect(restored).toEqual(seeded);
  });

  test('shouldPersistQuery keeps exactly the 7 SW-cached endpoint families, drops everything else', () => {
    // Independently transcribed from the SW's own matcher
    // (`^/api/(health|vitals|sessions|cron|spend|feed|my-pages)`,
    // vite.config.ts:54-66 / shell.md §5.2) — deliberately NOT read off
    // OFFLINE_CACHED_QUERY_NAMESPACES, so a bug that empties or shrinks that
    // set can't pass by asserting against itself.
    const expectedOfflineNamespaces = [
      'health',
      'vitals',
      'sessions',
      'session', // /api/sessions/{id}/messages — prefix-matched by the SW regex too
      'cron',
      'cron-logs',
      'cron-costs',
      'spend-summary',
      'spend-timeseries',
      'feed',
      'my-pages',
    ];
    const asQuery = (key: string) => ({ queryKey: [key], state: { status: 'success' } }) as never;

    for (const ns of expectedOfflineNamespaces) {
      expect(shouldPersistQuery(asQuery(ns))).toBe(true);
    }
    for (const ns of ['finance', 'decisions', 'browser-sessions', 'config-full']) {
      expect(shouldPersistQuery(asQuery(ns))).toBe(false);
    }
    // The exported set matches this independent list exactly — catches drift
    // between the set and the filter function that reads it.
    expect([...OFFLINE_CACHED_QUERY_NAMESPACES].sort()).toEqual([...expectedOfflineNamespaces].sort());
  });

  test('shouldPersistQuery excludes non-success queries even in a cached family (matches TanStack default filter)', () => {
    const pending = { queryKey: ['health'], state: { status: 'pending' } } as never;
    expect(shouldPersistQuery(pending)).toBe(false);
  });

  test('end-to-end: persistQueryClientSave/Restore only carries offline-family queries into a fresh client', async () => {
    const source = new QueryClient();
    const target = new QueryClient();
    try {
      // prefetchQuery (not setQueryData) so the query really goes through
      // 'success' status — the real condition defaultShouldDehydrateQuery checks.
      await source.prefetchQuery({ queryKey: ['health'], queryFn: () => Promise.resolve({ ok: true, updated_at: 't0' }) });
      await source.prefetchQuery({ queryKey: ['finance'], queryFn: () => Promise.resolve({ balance: 0 }) }); // not in the offline whitelist

      await persistQueryClientSave({
        queryClient: source,
        persister: asyncStoragePersister,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      });

      await persistQueryClientRestore({
        queryClient: target,
        persister: asyncStoragePersister,
        maxAge: OFFLINE_CACHE_MAX_AGE_MS,
      });

      expect(target.getQueryData(['health'])).toEqual({ ok: true, updated_at: 't0' });
      expect(target.getQueryData(['finance'])).toBeUndefined();
    } finally {
      source.clear();
      target.clear();
    }
  });

  test('OFFLINE_CACHE_MAX_AGE_MS is exactly 24h, matching vite.config.ts maxAgeSeconds:86400', () => {
    expect(OFFLINE_CACHE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('gcTime scoped to the 11 persisted namespaces on the real queryClient singleton', () => {
  // These tests exercise the exported `queryClient` itself — not a locally
  // reconstructed QueryClient with the fix hand-copied into it. A test that
  // only proves react-query *can* hold a query for 24h when told to isn't a
  // guard on the app being wired correctly; it's the same bug class already
  // hit once with the silently-no-op'd staleTimeMs/refetchIntervalMs field
  // names — a green test that doesn't touch the production object at all.

  const UNPERSISTED_NAMESPACES = ['finance', 'decisions', 'browser-sessions', 'config-full', 'fs-browse', 'fs-read'];
  const REACT_QUERY_BUILTIN_GC_TIME_MS = 5 * 60 * 1000; // removable.ts's own fallback when nothing overrides it

  test('setQueryDefaults registers gcTime=24h for exactly the 11 persisted namespaces, and nothing else, on queryClient', () => {
    for (const namespace of OFFLINE_CACHED_QUERY_NAMESPACES) {
      expect(queryClient.getQueryDefaults([namespace]).gcTime).toBe(OFFLINE_CACHE_MAX_AGE_MS);
    }
    for (const namespace of UNPERSISTED_NAMESPACES) {
      expect(queryClient.getQueryDefaults([namespace]).gcTime).toBeUndefined();
    }
  });

  test('a real query built on queryClient for a persisted namespace carries gcTime=24h; an unpersisted one keeps react-query\'s 5-minute built-in default', async () => {
    try {
      await queryClient.prefetchQuery({ queryKey: ['health'], queryFn: () => Promise.resolve({ ok: true }) });
      await queryClient.prefetchQuery({ queryKey: ['finance'], queryFn: () => Promise.resolve({ balance: 0 }) });

      const health = queryClient.getQueryCache().find({ queryKey: ['health'] });
      const finance = queryClient.getQueryCache().find({ queryKey: ['finance'] });
      // `query.gcTime` (Removable's resolved field, folded in by
      // updateGcTime during setOptions) is the effective value — NOT
      // `query.options.gcTime`, which stays `undefined` whenever nothing
      // in the defaults chain set it explicitly (react-query's 5-minute
      // fallback lives only on the resolved field, never copied back).
      expect(health!.gcTime).toBe(OFFLINE_CACHE_MAX_AGE_MS);
      expect(finance!.gcTime).toBe(REACT_QUERY_BUILTIN_GC_TIME_MS);
    } finally {
      queryClient.clear();
    }
  });

  // PersistQueryClientProvider re-persists on every QueryCache event,
  // including 'removed'. If gcTime were left at react-query's 5-minute
  // default (as apps/hub/src/main.tsx never sets it — the PWA has no
  // equivalent because its cache lived outside the query cache entirely),
  // an unobserved query would be garbage-collected long before the
  // persister's 24h maxAge, and that removal event would immediately
  // re-save the blob WITHOUT it — the 24h offline guarantee silently
  // collapsing to "whatever still had an observer at the last cache
  // event." This test proves the fix, on queryClient itself, actually
  // holds a persisted-namespace query past the point the bug would have
  // discarded it, and that the data still round-trips through
  // persist/restore afterwards.
  test('surviving 10 minutes unobserved (past the old 5-minute gcTime default) still round-trips through persist/restore', async () => {
    jest.useFakeTimers();
    try {
      await queryClient.prefetchQuery({ queryKey: ['health'], queryFn: () => Promise.resolve({ ok: true }) });
      // No useQuery ever mounts against this client — this is exactly the
      // "cached but nothing currently has it on screen" case the 24h
      // offline guarantee is supposed to cover.
      expect(queryClient.getQueryCache().find({ queryKey: ['health'] })).toBeDefined();

      jest.advanceTimersByTime(10 * 60 * 1000); // past the OLD/unpersisted 5-minute default gcTime

      expect(queryClient.getQueryCache().find({ queryKey: ['health'] })).toBeDefined();
    } finally {
      jest.useRealTimers();
    }

    // Simulated restart: a fresh, dedicated persister (not the shared
    // module-level asyncStoragePersister, to avoid its internal
    // asyncThrottle state interacting with the fake timers above) persists
    // the still-present query and restores it into a brand-new client.
    const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: 'test-gc-survival' });
    const restored = new QueryClient();
    try {
      await persistQueryClientSave({
        queryClient,
        persister,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      });
      await persistQueryClientRestore({ queryClient: restored, persister, maxAge: OFFLINE_CACHE_MAX_AGE_MS });

      expect(restored.getQueryData(['health'])).toEqual({ ok: true });
    } finally {
      queryClient.clear();
      restored.clear();
    }
  });
});

describe('AppState → focusManager wiring', () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  test('wireFocusManager subscribes to the real AppState "change" event', () => {
    const unsubscribe = wireFocusManager();
    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    unsubscribe();
  });

  test('a simulated AppState change to "active" focuses the real focusManager', () => {
    wireFocusManager();
    const handler = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)![1];

    handler('background');
    expect(focusManager.isFocused()).toBe(false);

    handler('active');
    expect(focusManager.isFocused()).toBe(true);
  });

  test('inactive (iOS transitional state) is treated as unfocused, not active', () => {
    wireFocusManager();
    const handler = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)![1];
    handler('inactive');
    expect(focusManager.isFocused()).toBe(false);
  });

  test('unsubscribe calls the underlying subscription.remove()', () => {
    const removeSpy = jest.fn();
    (AppState.addEventListener as jest.Mock).mockReturnValueOnce({ remove: removeSpy });
    const unsubscribe = wireFocusManager();
    unsubscribe();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('NetInfo → onlineManager wiring', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  test('wireOnlineManager subscribes to the real (mocked) NetInfo.addEventListener immediately', () => {
    wireOnlineManager();
    expect(NetInfo.addEventListener).toHaveBeenCalledWith(expect.any(Function));
  });

  test("NetInfo's reachability probe (a request to Google every 60 s) is off before the first subscription", () => {
    wireOnlineManager();
    const configure = NetInfo.configure as jest.Mock;
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0][0].reachabilityShouldRun()).toBe(false);
    const firstSubscribe = (NetInfo.addEventListener as jest.Mock).mock.invocationCallOrder[0];
    expect(configure.mock.invocationCallOrder[0]).toBeLessThan(firstSubscribe);
  });

  test('a simulated NetInfo state change flips the real onlineManager', () => {
    wireOnlineManager();
    const handler = (NetInfo.addEventListener as jest.Mock).mock.calls.at(-1)![0];

    handler({ isConnected: false });
    expect(onlineManager.isOnline()).toBe(false);

    handler({ isConnected: true });
    expect(onlineManager.isOnline()).toBe(true);
  });

  test('isConnected: null (unknown) is treated as offline, not silently ignored', () => {
    wireOnlineManager();
    const handler = (NetInfo.addEventListener as jest.Mock).mock.calls.at(-1)![0];
    handler({ isConnected: null });
    expect(onlineManager.isOnline()).toBe(false);
  });
});
