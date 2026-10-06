// Query layer + offline persistence for the native Hub. Ports
// apps/hub/src/main.tsx's QueryClient defaults and every read call site's
// staleTime/refetchInterval/retry matrix (PARITY-INVENTORY §3.1,
// docs/inventory/lib.md §4.1) verbatim, plus the RN-specific plumbing the PWA
// gets for free from the browser: AppState→focusManager (replaces
// visibilitychange), NetInfo→onlineManager (replaces navigator.onLine), and
// an AsyncStorage-backed persisted cache standing in for the service worker's
// NetworkFirst 24h offline reads (see "What the SW did that the persister
// cannot" in task-7-report.md — there is no native equivalent for the SW's
// *app-shell* precache/update-prompt machinery, only for its API-read cache).
import { createElement, useEffect, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  QueryClient,
  focusManager,
  onlineManager,
  useQuery,
  defaultShouldDehydrateQuery,
  type Query,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';

// Offline persistence constants, hoisted above the QueryClient so the
// scoped-gcTime block below (and `maxAge` further down) can reference them.
export const OFFLINE_CACHE_KEY = 'hub-query-cache';
export const OFFLINE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The 7 SW-cached endpoint families (11 query-key namespaces — see the
// "Offline persistence" block below for the URL-prefix-match reasoning),
// hoisted here so setQueryDefaults can scope gcTime to exactly these.
export const OFFLINE_CACHED_QUERY_NAMESPACES: ReadonlySet<string> = new Set([
  'health',
  'vitals',
  'sessions',
  'session', // /api/sessions/{id}/messages — prefix-matched by the SW's regex too
  'cron',
  'cron-logs',
  'cron-costs',
  'spend-summary',
  'spend-timeseries',
  'feed',
  'my-pages',
]);

// ===========================================================================
// QueryClient — apps/hub/src/main.tsx:7-15, verbatim. No gcTime override
// here (react-query's own 5-minute default applies globally, exactly as it
// does for the PWA, which never sets gcTime either).
// `refetchOnWindowFocus: true` is already TanStack's default; kept explicit
// here because the PWA states it explicitly and it is the option the
// focusManager wiring below (§ AppState→focusManager) makes meaningful on RN.
// ===========================================================================
const GLOBAL_STALE_TIME_MS = 20_000;
const GLOBAL_RETRY = 1;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: GLOBAL_STALE_TIME_MS,
      refetchOnWindowFocus: true,
      retry: GLOBAL_RETRY,
    },
  },
});

// ===========================================================================
// Scoped gcTime for the 11 persisted namespaces ONLY — a deliberate
// divergence from main.tsx, and deliberately NOT applied via the global
// defaultOptions.queries.gcTime above. PersistQueryClientProvider
// re-persists the whole cache on every QueryCache event, *including*
// 'removed': a query with no active observer is garbage-collected after
// gcTime, and that removal event immediately re-saves the blob without it —
// so with the 5-minute default, anything not actively mounted falls out of
// the persisted cache within 5 minutes, not the persister's 24h `maxAge`,
// defeating the exact parity mechanism this task exists to provide.
// TanStack's own persistence guidance is `gcTime >= maxAge`.
//
// That requirement only applies to what the persister actually writes.
// Applying it globally would hold EVERY query — finance, decisions,
// browser-sessions, config-full, per-path fs-browse/fs-read, session message
// transcripts — in memory for 24h after its last unmount instead of 5
// minutes: a real retention increase on a phone, and exactly the wrong
// namespaces to hold onto (session transcripts and per-path file reads are
// large and high-cardinality — one gc-timer-and-cache-entry per session id /
// per path visited). setQueryDefaults scopes gcTime by queryKey prefix
// match, so `['session', id]` and `['spend-summary', window]` etc. all
// inherit it while everything else keeps the 5-minute default.
//
// The PWA has no equivalent tension at all: its NetworkFirst cache lived at
// the HTTP layer (Workbox's own IndexedDB-backed cache), entirely outside
// the query cache's gc/eviction lifecycle — nothing there ever competed with
// unrelated queries for retention.
// ===========================================================================
for (const namespace of OFFLINE_CACHED_QUERY_NAMESPACES) {
  queryClient.setQueryDefaults([namespace], { gcTime: OFFLINE_CACHE_MAX_AGE_MS });
}

// ===========================================================================
// QUERY_TUNING — one entry per PWA useQuery call site (lib.md §4.1 rows),
// copied number-for-number. Nothing here is invented: `staleTimeOverridden:
// false` / `retryOverridden: false` mark the call sites where the PWA left
// the field unset and the value shown is the global default above, so a
// reader can tell "explicit 20_000" apart from "explicit at the call site."
// `queryKeyExample` is the literal key array from the PWA source — for
// dynamic keys it uses that call site's own literal default/fallback value
// (never a made-up one; each is cited in `source`).
// ===========================================================================
export interface QueryTuning {
  /** Literal (or representative, for dynamic keys) React Query key from the PWA call site. */
  queryKeyExample: QueryKey;
  staleTime: number;
  staleTimeOverridden: boolean;
  refetchInterval: number | false;
  retry: number | false;
  retryOverridden: boolean;
  /** The PWA's `enabled` guard, when the call site has one — documentation only. */
  enabledNote?: string;
  /** PWA file:line this row was copied from. */
  source: string;
  note?: string;
}

export const QUERY_TUNING: Record<string, QueryTuning> = {
  health: {
    queryKeyExample: ['health'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 60_000,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:224',
    note: "Also polled imperatively (not React Query) by AdvisorPage.tsx:67-82's waitForGatewayHealthy during a preset switch — out of scope for QUERY_TUNING.",
  },
  vitals: {
    queryKeyExample: ['vitals'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 60_000,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:225',
  },
  'sessions-home': {
    queryKeyExample: ['sessions'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 60_000,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:226',
    note: "Shared key with sessions-ops (OQ-13 retry mismatch) — whichever observer is mounted refetches on its own interval; both write the same cache entry.",
  },
  'sessions-ops': {
    queryKeyExample: ['sessions'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 30_000,
    retry: GLOBAL_RETRY,
    retryOverridden: false,
    source: 'Ops.tsx:853',
    note: 'Same key as sessions-home. Keeps the global retry:1 default instead of overriding to false — fs-roots/fs-browse/fs-read (below) do too, but sessions-ops is the only one of the four sitting on a key shared with another, differently-tuned call site.',
  },
  'pairing-home': {
    queryKeyExample: ['pairing'],
    staleTime: 120_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:227',
  },
  'pairing-ops': {
    queryKeyExample: ['pairing'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Ops.tsx:852',
    note: 'Refetched via q.refetch() after pairing.approve (Ops.tsx:61).',
  },
  // --- DELIBERATE cache-key collision (parity inventory OQ-13): Home and Ops
  // both use the bare `['cron-logs']` key with different `limit` params baked
  // into their queryFn closures. React Query caches by key only, so whichever
  // observer's queryFn last ran populates the shared entry for both screens.
  // This is a genuine PWA bug, not a native-port oversight — reproduced
  // as-is rather than fixed (e.g. by keying on the limit) per the task brief.
  'cron-logs-home': {
    queryKeyExample: ['cron-logs'],
    staleTime: 120_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:228',
    note: "queryFn is () => api.cronLogs(15). DELIBERATE collision with cron-logs-ops — see the block comment above this table entry (OQ-13).",
  },
  'cron-logs-ops': {
    queryKeyExample: ['cron-logs'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Ops.tsx:855',
    note: "queryFn is () => api.cronLogs(10). DELIBERATE collision with cron-logs-home (OQ-13). Invalidated after cron run/pause/resume (Ops.tsx:344).",
  },
  cron: {
    queryKeyExample: ['cron'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Ops.tsx:854',
    note: 'Invalidated Ops.tsx:343.',
  },
  backups: {
    queryKeyExample: ['backups'],
    staleTime: 300_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:231, Ops.tsx:858',
  },
  'my-pages-home': {
    queryKeyExample: ['my-pages'],
    staleTime: 60_000,
    staleTimeOverridden: true,
    refetchInterval: 120_000,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:232',
  },
  'my-pages-page': {
    queryKeyExample: ['my-pages'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'PagesPage.tsx:44',
  },
  'spend-timeseries-home-today': {
    queryKeyExample: ['spend-timeseries', 'today'],
    staleTime: 120_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:233-238',
  },
  'spend-summary-home-today': {
    queryKeyExample: ['spend-summary', 'today'],
    staleTime: 120_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:239-244',
    note: "Shares the literal key ['spend-summary','today'] with spend-summary-cost whenever Cost.tsx's window state is 'today' (its default) — the same read-both-mounted collision shape as cron-logs, just not called out as OQ-13 in the parity doc.",
  },
  'spend-summary-home-mtd': {
    queryKeyExample: ['spend-summary', 'mtd'],
    staleTime: 300_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:245-250',
  },
  'spend-summary-cost': {
    // Cost.tsx:325 `useState<SpendWindow>('today')` — 'today' is the PWA's own
    // initial value, not invented here; the real runtime key is
    // ['spend-summary', window] for whichever window pill is selected.
    queryKeyExample: ['spend-summary', 'today'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Cost.tsx:329-333',
    note: "queryKey is ['spend-summary', window] where window ∈ {'today','7d','30d','mtd'} (Cost.tsx:23-24, page state, initial 'today').",
  },
  'spend-timeseries-cost': {
    queryKeyExample: ['spend-timeseries', 'today'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Cost.tsx:334-338',
    note: "queryKey is ['spend-timeseries', window], same window state as spend-summary-cost.",
  },
  'openrouter-credits': {
    queryKeyExample: ['openrouter-credits'],
    staleTime: 300_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Cost.tsx:339',
    note: 'null data = hide the card (api.openrouterCredits() 404/405→null).',
  },
  'recurring-costs': {
    queryKeyExample: ['recurring-costs', 'today'],
    staleTime: 300_000,
    staleTimeOverridden: true,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Cost.tsx:378',
    note: 'null data = hide the card (api.recurringCosts() 404/405→null). Keyed by window: the server prorates onto the same span the pills resolve.',
  },
  'cron-costs': {
    queryKeyExample: ['cron-costs'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Cost.tsx:287',
  },
  'decisions-shared': {
    queryKeyExample: ['decisions'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 120_000,
    retry: false,
    retryOverridden: true,
    source: 'Home.tsx:251, Finance.tsx:62',
  },
  'decisions-page': {
    queryKeyExample: ['decisions'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 60_000,
    retry: false,
    retryOverridden: true,
    source: 'Decisions.tsx:58',
    note: 'Invalidated after answerDecision (DecisionCards.tsx:263).',
  },
  finance: {
    queryKeyExample: ['finance'],
    staleTime: 120_000,
    staleTimeOverridden: true,
    refetchInterval: 300_000,
    retry: false,
    retryOverridden: true,
    source: 'Finance.tsx:55-61',
    note: "SyncButton.tsx:23,54 imperatively qc.refetchQueries({queryKey:['finance']}) and reads qc.getQueryData(['finance'])?.asof — not a useQuery call site, so it has no tuning row of its own.",
  },
  feed: {
    queryKeyExample: ['feed'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 120_000,
    retry: false,
    retryOverridden: true,
    source: 'Feed.tsx:121',
  },
  'browser-sessions': {
    queryKeyExample: ['browser-sessions'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 15_000,
    retry: false,
    retryOverridden: true,
    source: 'BrowserCard.tsx:129-134',
    note: 'Fastest poll in the app.',
  },
  kanban: {
    queryKeyExample: ['kanban'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'Ops.tsx:856',
  },
  'tmux-sessions': {
    queryKeyExample: ['tmux-sessions'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: 30_000,
    retry: false,
    retryOverridden: true,
    source: 'Ops.tsx:857',
    note: 'q.refetch() after spawn/kill/resume (Ops.tsx:556,573,601).',
  },
  'tmux-history': {
    queryKeyExample: ['tmux-history'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    enabledNote: 'enabled: resumeOpen — lazy, only fetched while the "resume" panel is open.',
    source: 'Ops.tsx:535',
  },
  'session-messages': {
    // Ops.tsx:143 `['session', session?.id ?? '']` — '' is the PWA's own
    // fallback literal, copied verbatim, not invented.
    queryKeyExample: ['session', ''],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    enabledNote: 'enabled: session !== null',
    source: 'Ops.tsx:142-147',
  },
  skills: {
    queryKeyExample: ['skills'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'SystemPanel.tsx:112,492',
  },
  plugins: {
    queryKeyExample: ['plugins'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'SystemPanel.tsx:249,493',
  },
  memory: {
    queryKeyExample: ['memory'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'SystemPanel.tsx:307 (MemorySection, its own /config/memory page — not part of the skills/plugins/mcp/doctor combined System overview); MemoryPage.tsx:14',
  },
  mcp: {
    queryKeyExample: ['mcp'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'SystemPanel.tsx:358,494',
  },
  doctor: {
    queryKeyExample: ['doctor'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'SystemPanel.tsx:417,495',
  },
  'config-full': {
    queryKeyExample: ['config-full'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'ConfigHome.tsx:39, ConfigSectionPage.tsx:729, AdvisorPage.tsx:347',
    note: 'Invalidated after config.set (ConfigSectionPage.tsx:789) and advisor preset (AdvisorPage.tsx:393).',
  },
  'chat-models': {
    queryKeyExample: ['chat-models'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'ConfigSectionPage.tsx:731',
    note: 'Falls back to the static MODEL_TIERS list when empty (ConfigSectionPage.tsx:750).',
  },
  advisor: {
    queryKeyExample: ['advisor'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'AdvisorPage.tsx:343',
    note: 'Invalidated AdvisorPage.tsx:392,407.',
  },
  'topics-routing': {
    queryKeyExample: ['topics-routing'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'RoutingPage.tsx:242',
    note: 'Invalidated after save (RoutingPage.tsx:274).',
  },
  'passkey-status': {
    queryKeyExample: ['passkey-status'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'SecurityPage.tsx:25',
    note: 'Invalidated after enrol (SecurityPage.tsx:38).',
  },
  connectors: {
    queryKeyExample: ['connectors'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: false,
    retryOverridden: true,
    source: 'ConnectorsPage.tsx:186',
    note: 'Invalidated when a device-code flow reaches connected (ConnectorsPage.tsx:323).',
  },
  'fs-roots': {
    queryKeyExample: ['fs-roots'],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: GLOBAL_RETRY,
    retryOverridden: false,
    source: 'Files.tsx:167',
  },
  'fs-browse': {
    // Files.tsx:168-169 `useState('code')` / `useState('')` — the PWA's own
    // initial state, copied verbatim.
    queryKeyExample: ['fs-browse', 'code', ''],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: GLOBAL_RETRY,
    retryOverridden: false,
    enabledNote: 'enabled: !fileSelection — browse pauses while a file preview is open.',
    source: 'Files.tsx:173-177',
  },
  'fs-read': {
    // No PWA default exists — this key is only ever constructed once a file is
    // selected (Files.tsx:50-53 destructures `selection.root`/`selection.path`
    // with no initial state of its own), so '' here is a placeholder, not a
    // copied literal.
    queryKeyExample: ['fs-read', '', ''],
    staleTime: GLOBAL_STALE_TIME_MS,
    staleTimeOverridden: false,
    refetchInterval: false,
    retry: GLOBAL_RETRY,
    retryOverridden: false,
    source: 'Files.tsx:50-53',
  },
  brief: {
    queryKeyExample: ['brief'],
    staleTime: 300_000,
    staleTimeOverridden: true,
    // The brief changes once a day. A poll would spend battery re-reading a
    // file that is rewritten at 07:20 and never again; pull-to-refresh and the
    // app-foreground refetch (wireFocusManager) are the refresh paths.
    refetchInterval: false,
    retry: GLOBAL_RETRY,
    retryOverridden: false,
    // The ONE entry with no PWA original. The web brief is a server-rendered
    // /my-pages page, not a useQuery call site, and this screen is what
    // replaces it (spec §11) — so the citation is the native call site.
    source: 'BriefScreen.tsx:62',
    note: 'Invalidated after every dismiss/snooze/undo so the two surfaces agree.',
  },
  calendar: {
    queryKeyExample: ['calendar'],
    staleTime: 300_000,
    staleTimeOverridden: true,
    // The snapshot behind it moves at most every half hour (calendar-sync's
    // cron), so a poll would only re-read the same file. Pull-to-refresh and
    // the app-foreground refetch are the refresh paths, as for the brief.
    refetchInterval: false,
    retry: GLOBAL_RETRY,
    retryOverridden: false,
    // No PWA original: the calendar is native-only.
    source: 'useCalendar.ts:9',
    note: 'One key for the whole synced span; Home\'s card and the screen share it.',
  },
};

// ===========================================================================
// usePoll — typed pass-through to useQuery. Call sites pass QUERY_TUNING[id]
// (spread) as `opts` to reproduce a PWA call site exactly, e.g.:
//   usePoll(['health'], api.health, QUERY_TUNING.health)
// It exists as a named seam (so every screen imports polling from
// lib/query, not directly from @tanstack/react-query) rather than to add
// behavior beyond useQuery itself.
// ===========================================================================
export function usePoll<TData>(
  queryKey: QueryKey,
  queryFn: () => Promise<TData>,
  opts?: Omit<UseQueryOptions<TData, Error, TData, QueryKey>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<TData, Error, TData, QueryKey>({
    queryKey,
    queryFn,
    ...opts,
  });
}

// ===========================================================================
// refreshAll — Header.tsx:106-108's `onClick={() => qc.invalidateQueries()}`.
// No filter: invalidates every cached query app-wide (all tabs, not just
// the one on screen), and active observers refetch immediately.
// ===========================================================================
export function refreshAll(client: QueryClient = queryClient) {
  return client.invalidateQueries();
}

// ===========================================================================
// AppState → focusManager (docs/research/network-auth.md §"TanStack Query in
// RN"). RN has no window focus/visibilitychange events; this is the native
// equivalent of the PWA's `refetchOnWindowFocus: true` firing on
// visibilitychange. `active` maps to focused, everything else (background,
// inactive, extension, unknown) maps to unfocused.
// ===========================================================================
export function wireFocusManager(appState: typeof AppState = AppState): () => void {
  const subscription = appState.addEventListener('change', (status: AppStateStatus) => {
    focusManager.setFocused(status === 'active');
  });
  return () => subscription.remove();
}

// ===========================================================================
// NetInfo → onlineManager (same research doc). Note NetInfo reports device
// connectivity (Wi-Fi/cellular up), not tailnet reachability — it will not
// detect "Tailscale is off" while the phone otherwise has network. That
// failure mode is a separate concern (a dedicated health-probe screen state),
// not something onlineManager can see.
//
// Returns an unsubscribe function, symmetric with wireFocusManager, even
// though onlineManager.setEventListener already replaces+cleans up its own
// prior listener on re-call (so nothing leaks today) — a future caller
// wiring both on mount/unmount shouldn't have one teardown path and not the
// other.
//
// Only isConnected is read, so NetInfo's own internet-reachability probe is
// switched off: on iOS it would otherwise send a request to Google every 60 s,
// a third party the privacy docs promise the app never contacts. configure()
// rebuilds NetInfo's state once a listener exists, so it runs once, first.
// ===========================================================================
let reachabilityProbeOff = false;

export function wireOnlineManager(netInfo: typeof NetInfo = NetInfo): () => void {
  if (!reachabilityProbeOff) {
    netInfo.configure({ reachabilityShouldRun: () => false });
    reachabilityProbeOff = true;
  }
  let unsubscribe: (() => void) | undefined;
  onlineManager.setEventListener((setOnline) => {
    unsubscribe = netInfo.addEventListener((state) => setOnline(!!state.isConnected));
    return unsubscribe;
  });
  return () => unsubscribe?.();
}

// ===========================================================================
// Offline persistence — AsyncStorage persister standing in for the PWA
// service worker's NetworkFirst `api-reads` cache (vite.config.ts:54-66 /
// shell.md §5.2): same 24h maxAge, same 7 endpoint families
// (OFFLINE_CACHED_QUERY_NAMESPACES, hoisted above the QueryClient — it also
// drives the scoped gcTime block there). The SW matches by URL prefix
// `/api/(health|vitals|sessions|cron|spend|feed|my-pages)`, which also
// covers `/api/sessions/{id}/messages` (prefix match) and every
// `cron*`/`spend*` query key — reproduced as an explicit query-key namespace
// whitelist since RN has no URL-based cache layer to hook into. Persisted
// only for queries that resolved (status 'success'), same as TanStack's own
// default dehydrate filter.
// ===========================================================================
export function isOfflineCachedQuery(query: Query): boolean {
  const [namespace] = query.queryKey as QueryKey;
  return typeof namespace === 'string' && OFFLINE_CACHED_QUERY_NAMESPACES.has(namespace);
}

/** The exact filter HubQueryProvider hands to PersistQueryClientProvider — exported so tests can
 * exercise the real dehydrate pipeline (persistQueryClientSave/Restore) without rendering. */
export function shouldPersistQuery(query: Query): boolean {
  return defaultShouldDehydrateQuery(query) && isOfflineCachedQuery(query);
}

export const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: OFFLINE_CACHE_KEY,
});

// ===========================================================================
// HubQueryProvider — wire providers export. Wraps children in the persisted
// QueryClientProvider and wires the two RN event sources for the lifetime of
// the provider (there is exactly one, at the app root).
// This file is `.ts`, not `.tsx` (matches the task brief's file list), so the
// element tree is built with createElement rather than JSX syntax.
// ===========================================================================
export function HubQueryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const unwireOnline = wireOnlineManager();
    const unwireFocus = wireFocusManager();
    return () => {
      unwireOnline();
      unwireFocus();
    };
  }, []);

  return createElement(
    PersistQueryClientProvider,
    {
      client: queryClient,
      persistOptions: {
        persister: asyncStoragePersister,
        maxAge: OFFLINE_CACHE_MAX_AGE_MS,
        dehydrateOptions: {
          shouldDehydrateQuery: shouldPersistQuery,
        },
      },
    },
    children,
  );
}
