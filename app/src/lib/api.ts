// Port of apps/hub/src/lib/api.ts (PWA) for the native app. Same function
// names, paths, params, and error handling. Two deliberate departures from
// the PWA, both dictated by the RN runtime rather than by preference:
//
//   1. No mock mode. The PWA's `MODE`/`mock.ts` branch exists because Vite
//      dev builds default to mock; hub-app has no mock.ts (not ported) and
//      always talks to the live hub-api. `api.mode` is dropped with it.
//   2. No WebAuthn. `navigator.credentials.get/create` don't exist in RN, and
//      a native passkey for this RP is impossible in a TestFlight build
//      (docs/research/passkeys.md). The gate is a Secure-Enclave P-256 key
//      instead: `requestActionAssertion` below is the seam, and `gate.ts`
//      registers the real signer into it at app startup (app/_layout.tsx).
//      THE SEAM IS THE ONLY THING THAT CHANGES — this file keeps ownership of
//      the challenge -> sign -> apply sequence for every write, exactly as the
//      PWA's client does, and it FAILS CLOSED: with no signer registered every
//      gated call throws `GateNotWiredError` before the apply is posted.
//      `createPasskey` stays unwired: WebAuthn registration has no native twin
//      at all, and pairing replaces it (apps/hub SecurityPage mints the code).
//
// Demo mode (src/demo/) is not the PWA's mock mode: it is a user-visible mode
// with its own badge, entered on purpose, and it changes only the transport.
// While it is on, `get`/`post` hand the request to the demo's in-memory server
// instead of fetch(), and the signing step asks for Face ID, Touch ID or the
// passcode instead of the Secure Enclave key. Everything else here runs as is.
import type {
  AdvisorPreset,
  AdvisorState,
  AgentSession,
  ApplyErrorCode,
  BackupStatus,
  BrowserSessions,
  ChatModel,
  ConfigFullReport,
  ConnectorsReport,
  CronCostsReport,
  CronReport,
  CronRun,
  DecisionsReport,
  DoctorReport,
  FeedResponse,
  FinanceSnapshot,
  FsBrowseResponse,
  FsReadResponse,
  FsRoot,
  HealthSummary,
  KanbanReport,
  McpReport,
  MemoryReport,
  MyPagesResponse,
  OauthStatus,
  OpenRouterCredits,
  PairingReport,
  PasskeyStatus,
  PluginsReport,
  SessionMessage,
  SkillsReport,
  RecurringCosts,
  SpendSummary,
  SpendTimeseries,
  TmuxHistory,
  TmuxInventory,
  TopicsConfig,
  TopicsReport,
  Vitals,
  WriteRequest,
  WriteResult,
} from './types';
import type {
  Brief,
  BriefAction,
  BriefDismissResult,
  BriefNoteResult,
  BriefRule,
  BriefUsefulResult,
} from './briefTypes';
import type { CalendarResponse } from './calendarTypes';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { validateServerUrl, type ServerUrlCheck } from './serverUrl';
import { DEMO_ORIGIN, demoReady, isDemoActive, useDemoMode } from '../demo/mode';
import { demoFetch } from '../demo/server';
import { demoAuthorize } from '../demo/auth';
import type {
  ApprovalApplyResponse,
  ApprovalDecisionInput,
  ChatAttentionResponse,
  ChatBootstrapResponse,
  ChatSendResponse,
  ChatThreadDetailResponse,
  MarkReadResponse,
  Part,
  Thread,
  ThreadPatchInput,
} from '../chat/types';
import type { ChatCommandsResponse } from '../chat/commands';
import type {
  AutomationJob,
  AutomationsResponse,
  JobDetailResponse,
  PrefsInput,
  RunOpenResponse,
  TimelineResponse,
} from '../automations/types';

const DEFAULT_API_BASE = 'https://hub.example.com';

/** AsyncStorage key holding the user-set server override (Config › Server
 * address, ServerPage.tsx). */
export const API_BASE_STORAGE_KEY = 'hub.apiBase';

/** Where the effective server address came from. 'user' beats 'build' beats
 * the shipped default — the order resolveApiBase() implements and
 * ServerPage.tsx renders so the state is never ambiguous. */
export type ApiBaseSource = 'user' | 'build' | 'default';

/** The user-set override, in memory. Null until loadStoredApiBase() /
 * setUserApiBase() put one there; AsyncStorage is read at startup
 * (app/_layout.tsx), never at import time, so importing this module in a
 * test stays side-effect-free. */
let userApiBase: string | null = null;

/** Effective server base, resolved at call time in this order:
 *
 *   1. the user-set value (Config › Server address) — beats everything,
 *   2. the build-time `expo.extra.apiBase` (app.json; the EAS profile),
 *   3. DEFAULT_API_BASE, what a build with no extra configured talks to.
 */
export function resolveApiBase(): { base: string; source: ApiBaseSource } {
  if (userApiBase) return { base: userApiBase, source: 'user' };
  const extra = Constants.expoConfig?.extra as { apiBase?: string } | undefined;
  return { base: extra?.apiBase ?? DEFAULT_API_BASE, source: extra?.apiBase ? 'build' : 'default' };
}

/** The raw user-set override (null when there is none) — ServerPage.tsx
 * prefills the field with it; every caller that wants an address should read
 * resolveApiBase() instead. */
export function getUserApiBase(): string | null {
  return userApiBase;
}

/** Every call path is resolved against the CURRENT effective base, not a
 * module-load snapshot — a server change takes effect on the next call
 * without a relaunch. */
function apiPath(path: string): string {
  return `${resolveApiBase().base}/api${path}`;
}

/** The hub host with no path — Task 19's WebView components resolve
 * `/my-pages/...` and `/oura/...` against this, same host `BASE` used to.
 * Live binding: reassigned whenever the effective base changes, so importers
 * (WebView screens, wsClients) pick up a user-set server too. In the demo it
 * is a reserved `.invalid` host, so a URL built from it can never reach the
 * stored server. */
export let HUB_ORIGIN = resolveApiBase().base;

function refreshDerivedBase(): void {
  HUB_ORIGIN = isDemoActive() ? DEMO_ORIGIN : resolveApiBase().base;
}

useDemoMode.subscribe(refreshDerivedBase);

/** Reads the persisted override into effect. A stored value that no longer
 * validates (scheme rules tightened, hand-edited store) is ignored rather
 * than trusted — it fails closed to the build-time base. Idempotent: called
 * once at startup and again whenever ServerPage mounts. */
export async function loadStoredApiBase(): Promise<void> {
  const stored = await AsyncStorage.getItem(API_BASE_STORAGE_KEY);
  if (!stored) return;
  const check = validateServerUrl(stored);
  if (!check.ok) return;
  userApiBase = check.url;
  refreshDerivedBase();
}

/** Validates first, then persists and applies. The returned check is what
 * ServerPage renders: `{ ok: false, error }` becomes the inline message and
 * nothing is stored or applied. */
export async function setUserApiBase(url: string): Promise<ServerUrlCheck> {
  const check = validateServerUrl(url);
  if (!check.ok) return check;
  userApiBase = check.url;
  refreshDerivedBase();
  await AsyncStorage.setItem(API_BASE_STORAGE_KEY, check.url);
  return check;
}

/** Drops the override — the app falls back to the build-time base
 * immediately and after the next relaunch. */
export async function clearUserApiBase(): Promise<void> {
  userApiBase = null;
  refreshDerivedBase();
  await AsyncStorage.removeItem(API_BASE_STORAGE_KEY);
}

/** Uniform error for every hub-api failure: carries HTTP status + server code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** What `get`/`post` read off a response — fetch()'s, or the demo's. */
type Reply = Pick<Response, 'ok' | 'status' | 'json'>;

/** The one door every request goes through. The demo's state is read before
 * anything leaves, so a cold launch in the demo never reaches a server. */
async function send(path: string, init: RequestInit): Promise<Reply> {
  await demoReady();
  if (isDemoActive()) return demoFetch(path, init);
  return fetch(`${apiPath(path)}`, init);
}

async function parseError(res: Reply, path: string): Promise<ApiError> {
  const raw = await res.json().catch(() => null);
  const nested = typeof raw?.detail === 'object' && raw?.detail !== null ? raw.detail : null;
  const message: string =
    nested?.detail ?? (typeof raw?.detail === 'string' ? raw.detail : `${path} → ${res.status}`);
  return new ApiError(res.status, message, nested?.code);
}

async function get<T>(path: string): Promise<T> {
  const res = await send(path, { credentials: 'include' });
  if (!res.ok) throw await parseError(res, `GET ${path}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await send(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res, `POST ${path}`);
  return res.json() as Promise<T>;
}

/** The default `GateNotWiredError` copy. Exported because it is the string
 * every write surface renders on the no-signer path, and their tests assert it
 * rather than re-typing it. */
export const GATE_NOT_WIRED_MESSAGE =
  'Face ID is unavailable, so nothing was sent. Restart Hub, then pair this iPhone in Config › Security.';

/** The gate refusing to act because no signer is installed — NOT "this iPhone
 * is not paired" (gate.ts throws its own GateError for that, after the signer
 * has run). Reaching this means `installGateSigner()` never ran, which is a
 * startup bug rather than anything the user did.
 *
 * Shaped like the PWA's WebAuthnError (code + message) so screens that branch
 * on `err.code` (e.g. `=== 'cancelled'`) work on it unchanged.
 *
 * The default message is what a user sees when the signer is missing, so it
 * says the two things that are true and actionable: nothing was sent, and the
 * two ways out (a restart re-runs `installGateSigner`; pairing is what makes
 * the gate usable at all). Every throw site that means something more specific
 * passes its own `message` instead. */
export class GateNotWiredError extends Error {
  constructor(
    public code: ApplyErrorCode = 'unknown',
    message = GATE_NOT_WIRED_MESSAGE,
  ) {
    super(message);
  }
}

export interface AssertionChallenge {
  challenge: string;
  rp_id: string;
  user_verification: 'required' | 'preferred';
  allowed_credentials: { id: string; type: 'public-key' }[];
  timeout_ms: number;
}

export class ApplyError extends Error {
  constructor(
    public code: ApplyErrorCode,
    public detail?: string,
  ) {
    super(detail ?? code);
  }
}

/** The native app's proof, verified by server/devicekeys.py:
 * ECDSA-P256-SHA256 (X9.62 DER, base64) by the enrolled Secure-Enclave key over
 * `base64url_decode(challenge_b64)` — the same 32 canonical bytes a WebAuthn
 * authenticator signs. `challenge_b64` is echoed back byte-for-byte because it
 * is the server's challenge-cache key; it is NOT re-encoded. */
export interface DeviceKeyAssertion {
  key_id: string;
  challenge_b64: string;
  signature_b64: string;
}

/** What the signer hands back, spread verbatim into the apply body. The server's
 * GatedRequest takes EXACTLY ONE proof — `assertion` (the PWA's WebAuthn one) or
 * `devicekey_assertion` — so this is an object, not a bare payload: the field
 * name is part of the contract and belongs with the value that satisfies it. */
export interface GateProof {
  devicekey_assertion: DeviceKeyAssertion;
}

export type GateSigner = (challenge: AssertionChallenge) => Promise<GateProof>;

let gateSigner: GateSigner | null = null;

/** Arms the write gate. Called once at startup by app/_layout.tsx with
 * gate.ts's Secure-Enclave signer. Until it is, every gated call below throws
 * `GateNotWiredError` at the signing step — after the challenge POST and
 * before the apply POST — so an unarmed client cannot write.
 *
 * Registering the SAME signer again is a no-op, because React re-runs mount
 * effects (StrictMode, fast refresh) and that is not a mistake. Registering a
 * DIFFERENT one throws: last-write-wins would let a second call site silently
 * decide what authorizes every write in the app, and there is no legitimate
 * reason to hot-swap the thing that holds the gate. Fail at startup, loudly,
 * where it is a red screen rather than a quiet downgrade. */
export function registerGateSigner(signer: GateSigner): void {
  if (gateSigner && gateSigner !== signer) {
    throw new Error('registerGateSigner: the write gate already has a different signer');
  }
  gateSigner = signer;
}

async function requestActionAssertion(challenge: AssertionChallenge): Promise<GateProof> {
  if (isDemoActive()) {
    // The paired Enclave key is never touched in the demo, and its server
    // ignores the proof; the owner's Face ID or passcode is the gate.
    const outcome = await demoAuthorize();
    if (!outcome.ok) throw new ApplyError(outcome.code, outcome.message);
    return { devicekey_assertion: { key_id: 'demo', challenge_b64: challenge.challenge, signature_b64: '' } };
  }
  if (!gateSigner) throw new GateNotWiredError();
  return gateSigner(challenge);
}

async function createPasskey(_options: Record<string, unknown>): Promise<unknown> {
  // Not "not wired yet": WebAuthn registration has no native twin for this RP
  // and never will (docs/research/passkeys.md). Pairing a device key replaces
  // it, so nothing in the app calls this — it exists for shape parity only.
  throw new GateNotWiredError(
    'unknown',
    'Passkeys cannot be enrolled from the app. Pair this iPhone in Config › Security instead.',
  );
}

function toApplyCode(err: ApiError): ApplyErrorCode {
  if (err.code === 'no_passkey') return 'no_passkey';
  // hub-api's _require_enrolled fails closed with 412 no_devicekey when nothing
  // is paired. Folded into no_passkey rather than given a code of its own:
  // ApplyErrorCode lives in the byte-locked types.ts copy, and "no credential
  // enrolled, go to Security" is the same sentence either way. Without this the
  // 412 below would read as challenge_expired ("that took too long"), which is
  // the one thing it is not.
  if (err.code === 'no_devicekey') return 'no_passkey';
  if (err.code === 'challenge_expired' || err.status === 412) return 'challenge_expired';
  if (err.code === 'assertion_invalid' || err.status === 403) return 'assertion_invalid';
  if (err.code === 'bridge_error' || err.status === 502) return 'bridge_error';
  if (err.status === 400) return 'bad_request';
  if (err.status === 405) return 'phase_2_pending';
  return 'unknown';
}

/** A fresh id for chat/routes.py's `/send` (`^[A-Za-z0-9_-]{1,128}$`, matched
 * exactly by this alphabet). The caller keeps it: a retry of the SAME send
 * reuses it verbatim, which is what makes `insert_message`'s dedup index
 * actually protect a flaky connection instead of double-sending. No native
 * UUID here — RN's global has no `crypto.randomUUID`, and pulling in
 * `expo-crypto` for one id would be a native dependency this OTA-only build
 * can't take. */
export function newClientMsgId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export const api = {
  // --- glanceable reads (file-backed, poll freely) --------------------------
  health: async (): Promise<HealthSummary> => get('/health'),
  backups: async (): Promise<BackupStatus> => get('/backups'),
  myPages: async (): Promise<MyPagesResponse> => get('/my-pages'),
  feed: async (): Promise<FeedResponse> => get('/feed'),
  vitals: async (): Promise<Vitals> => get('/vitals'),

  // --- agent history (gateway-backed) ----------------------------------------
  sessions: async (): Promise<AgentSession[]> => (await get<{ data: AgentSession[] }>('/sessions')).data,
  sessionMessages: async (id: string): Promise<SessionMessage[]> =>
    (await get<{ data: SessionMessage[] }>(`/sessions/${encodeURIComponent(id)}/messages`)).data,
  /** One session record — the model a chat thread's gateway session is
   * answering on comes from here (`threads.hermes_session_id` is the join). */
  session: async (id: string): Promise<AgentSession> =>
    (await get<{ session: AgentSession }>(`/sessions/${encodeURIComponent(id)}`)).session,

  // --- ops (bridge-backed: docker exec per call — poll ≥30s) ------------------
  cron: async (): Promise<CronReport> => get('/cron'),
  cronLogs: async (limit = 30): Promise<CronRun[]> => (await get<{ runs: CronRun[] }>(`/cron/logs?limit=${limit}`)).runs,
  cronCosts: async (): Promise<CronCostsReport> => get('/cron/costs'),
  kanban: async (): Promise<KanbanReport> => get('/kanban'),
  skills: async (): Promise<SkillsReport> => get('/skills'),
  plugins: async (): Promise<PluginsReport> => get('/plugins'),
  mcp: async (): Promise<McpReport> => get('/mcp'),
  memory: async (): Promise<MemoryReport> => get('/memory'),
  doctor: async (): Promise<DoctorReport> => get('/doctor'),
  pairing: async (): Promise<PairingReport> => get('/pairing'),

  // --- spend v2 -----------------------------------------------------------------
  // Pills are pure calendar windows: today (since local midnight) | 7d | 30d | mtd.
  // The server resolves them to explicit ranges and returns those dates.
  spendSummary: async (window = 'mtd'): Promise<SpendSummary> => get(`/spend/summary?window=${window}`),
  spendTimeseries: async (window = '7d'): Promise<SpendTimeseries> => get(`/spend/timeseries?window=${window}`),
  browserSessions: async (): Promise<BrowserSessions | null> => {
    try {
      const raw = await get<BrowserSessions>('/browser/sessions');
      // Normalize at the boundary: an older backend has no `pages`/`current_url`
      // (deploy skew) — fill defaults so no card ever crashes on their absence.
      return {
        ...raw,
        running: (raw.running ?? []).map((r) => ({ ...r, pages: r.pages ?? [], current_url: r.current_url ?? null })),
        recent: (raw.recent ?? []).map((r) => ({ ...r, pages: r.pages ?? [], duration_s: r.duration_s ?? null })),
      };
    } catch (err) {
      // 404 = key not plumbed; 502 = Browserbase unreachable — hide either way.
      if (err instanceof ApiError) return null;
      throw err;
    }
  },
  openrouterCredits: async (): Promise<OpenRouterCredits | null> => {
    try {
      return await get<OpenRouterCredits>('/cost/openrouter');
    } catch (err) {
      // 404 = key not plumbed into hub-api yet; render nothing rather than an error.
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  },
  recurringCosts: async (window = 'mtd'): Promise<RecurringCosts | null> => {
    try {
      return await get<RecurringCosts>(`/cost/recurring?window=${encodeURIComponent(window)}`);
    } catch (err) {
      // 404 = endpoint not deployed yet; the rest of the tab still renders.
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  },

  // --- config ---------------------------------------------------------------------
  configFull: async (): Promise<ConfigFullReport> => get('/config/full'),
  advisor: async (): Promise<AdvisorState> => get('/advisor'),

  // --- connectors --------------------------------------------------------------------
  connectors: async (): Promise<ConnectorsReport> => get('/connectors'),
  /** Face-ID-gated login start — SAME challenge → assertion → apply shape as
   * applyWrite. Whoever approves the device code picks the account the agent
   * logs into, so only this client gets the poll token that reads the code. */
  connectorConnect: async (provider: string): Promise<{ stage: string; poll_token: string }> => {
    const path = `/connectors/${encodeURIComponent(provider)}`;
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>(`${path}/challenge`, {});
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post(`${path}/connect`, { ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },
  connectorOauthStatus: async (provider: string, pollToken: string): Promise<OauthStatus> =>
    post(`/connectors/${encodeURIComponent(provider)}/oauth-status`, { poll_token: pollToken }),

  // --- models (config picker; endpoint keeps its legacy /chat/models path) -------
  chatModels: async (): Promise<ChatModel[]> => (await get<{ data: ChatModel[] }>('/chat/models')).data,

  // --- finance (day-to-day spend; 404 = snapshot not written yet → cards self-hide) ---
  finance: async (): Promise<FinanceSnapshot | null> => {
    try {
      return await get<FinanceSnapshot>('/finance');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  // --- WebAuthn: passkeys + the generalized write gate --------------------------------
  passkeyStatus: async (): Promise<PasskeyStatus> => get('/passkey/status'),

  enrollPasskey: async (label: string): Promise<{ ok: boolean; count: number }> => {
    const options = await post<Record<string, unknown>>('/passkey/register/options', {});
    const credential = await createPasskey(options);
    return post('/passkey/register/verify', { credential, label });
  },

  /** Pair this device's Secure-Enclave key. Carries no proof of its own — the
   * app holds no credential yet — and is authorized instead by the one-time
   * enrol code the PWA's Security page minted seconds earlier behind a real
   * passkey ceremony. `spki_der_b64` is base64 X.509 SubjectPublicKeyInfo DER;
   * `key_id` comes back server-derived (sha256 of that DER) and is the only
   * place the app can learn it — /api/devicekey/status discloses no ids. */
  registerDeviceKey: async (
    code: string,
    spkiDerB64: string,
    label: string,
  ): Promise<{ ok: boolean; key_id: string; count: number }> =>
    post('/devicekey/register', { code, spki_der_b64: spkiDerB64, label }),

  /** Face-ID-gated write: challenge → platform assertion → apply. */
  applyWrite: async (request: WriteRequest): Promise<WriteResult> => {
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/action/challenge', { request });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post<WriteResult>('/action/apply', { request, ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },

  applyAdvisorPreset: async (preset: AdvisorPreset): Promise<WriteResult> =>
    api.applyWrite({ action: 'advisor.preset', preset }),

  // --- Host tmux sessions (hub-tmuxd; spawn/kill go through applyWrite) -----------
  tmuxSessions: async (): Promise<TmuxInventory> => get('/tmux/sessions'),

  /** Recent Claude Code transcripts per host — the pool `tmux.spawn { resume }` draws from. */
  tmuxHistory: async (): Promise<TmuxHistory> => get('/tmux/history'),

  // --- Telegram topic routing (config + drift; Face-ID-gated save) ----------------
  topicsConfig: async (): Promise<TopicsReport> => get('/config/topics'),

  /** Face-ID-gated routing save — SAME challenge → assertion → apply shape as
   * applyWrite, against the /config/topics gate. The write only marks
   * pending_sync; the host applier makes it live within ~10 min. */
  saveTopicRouting: async (config: TopicsConfig): Promise<{ status: string; pending_sync: boolean }> => {
    const payload = { config: { chat_id: config.chat_id, topics: config.topics, routes: config.routes } };
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/config/topics/challenge', payload);
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post('/config/topics', { ...payload, ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },

  /** Register this phone for the brief's morning notification. Device-key
   * gated in the same challenge -> assertion -> apply shape as saveTopicRouting:
   * the challenge is bound to the token itself, so a proof cannot be replayed
   * to register a different device. */
  registerPushDevice: async (token: string, label: string): Promise<{ status: string; devices: number }> => {
    const payload = { token, label };
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/push/challenge', payload);
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post('/push/register', { ...payload, ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },

  // --- Calendar ---------------------------------------------------------------
  //
  // A date range out of the snapshot calendar-sync keeps. Read-only, so ungated.
  calendar: async (from: string, to: string): Promise<CalendarResponse> =>
    get(`/calendar?from=${from}&to=${to}`),

  /** Ask the host to sync this week and next now. Ungated, like the read:
   * a repeat while one is pending changes nothing (hub_calendar.py). */
  syncCalendar: async (): Promise<{ requested_at: string; already: boolean }> => post('/calendar/sync', {}),

  // --- Daily brief (the native surface that replaces the /my-pages HTML) ------
  //
  // The three calls are NOT Face-ID-gated, and that is deliberate rather than an
  // omission: Ruling 57 makes the write proof a per-item HMAC the generator
  // mints (`item.token`), because a background-capable app cannot present Face
  // ID for a swipe. Server-side `_require_brief_token` 403s a wrong token and
  // 503s when the key file is missing, so there is no ungated path — the gate
  // just is not the Secure-Enclave one.
  brief: async (date?: string): Promise<Brief> =>
    get(date ? `/brief?date=${encodeURIComponent(date)}` : '/brief'),

  /** Dismiss, snooze or undo one item. Throws ApiError(403) on a stale token and
   * ApiError(503) when the dismiss key is unprovisioned — the caller must tell
   * those apart, so neither is normalized away here. */
  dismissBriefItem: async (
    itemId: string,
    action: BriefAction,
    token: string,
    date: string,
  ): Promise<BriefDismissResult> =>
    post('/briefing/dismiss.json', { item_id: itemId, action, token, date }),

  /** The positive half of the signal. Idempotent server-side: a second tap comes
   * back `already: true` rather than weighting the exemplar twice. */
  markBriefItemUseful: async (
    itemId: string,
    token: string,
    date: string,
  ): Promise<BriefUsefulResult> => post('/briefing/useful.json', { item_id: itemId, token, date }),

  /** "Tell the brief about this" (Ruling 146) — a one-line note on a past
   * item, token-gated like useful. Notes are not deduped server-side, so this
   * may be called more than once for the same item. */
  noteBriefItem: async (
    itemId: string,
    token: string,
    date: string,
    note: string,
  ): Promise<BriefNoteResult> =>
    post('/briefing/note.json', { item_id: itemId, token, date, note }),

  /** the user's standing rules (Ruling 146) — read-only, tailnet-gated like
   * /api/brief; no Face ID needed to just look. */
  briefingRules: async (): Promise<{ rules: BriefRule[] }> => get('/briefing/rules.json'),

  /** Add one rule. Same device-key/WebAuthn challenge → assertion → apply
   * shape as saveTopicRouting — the rules store is not per-item, so the
   * per-item brief token does not apply here. */
  addBriefingRule: async (text: string): Promise<{ rules: BriefRule[] }> => {
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/briefing/rules.json/challenge', { text });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post('/briefing/rules.json', { text, ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },

  /** Remove one rule, by id. Same gate as addBriefingRule. */
  removeBriefingRule: async (id: string): Promise<{ rules: BriefRule[] }> => {
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/briefing/rules.json/challenge', { remove: id });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post('/briefing/rules.json', { remove: id, ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },

  // --- Decision Inbox (pending decisions; Face-ID-gated answer) --------------------
  decisions: async (): Promise<DecisionsReport> => get('/decisions'),

  /** Face-ID-gated decision answer — SAME challenge → assertion → apply shape as
   * saveTopicRouting. Reserved option_key "dismiss" marks the card dismissed;
   * option_key null + note = note-only answer.
   *
   * Every card answers here, an automation's iMessage draft (`draft_id` on the
   * card; options once / deny / dismiss) included: approving one sends a
   * message, so the server takes the verified answer and only then applies it
   * to the draft's own first-answer-wins approval. There is no ungated route. */
  answerDecision: async (
    id: string,
    optionKey: string | null,
    note: string | null,
  ): Promise<{ status: string; answered_at: string; draft?: { draft_id: number; status: string } }> => {
    const payload = { option_key: optionKey, note: note?.trim() || null };
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>(`/decisions/${encodeURIComponent(id)}/challenge`, payload);
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post(`/decisions/${encodeURIComponent(id)}/answer`, { ...payload, ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },

  /** Terminal unlock: challenge → Face ID → session cookie (path=/terminal). */
  terminalUnlock: async (): Promise<boolean> => {
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/terminal/challenge', {});
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      await post('/terminal/session', { ...proof });
      return true;
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },
  terminalLogout: async (): Promise<void> => {
    await post('/terminal/logout', {});
  },

  /** Chat unlock: challenge → Face ID → session cookie (path=/api/chat).
   * Same shape as terminalUnlock — a distinct cookie, minted against a
   * distinct purpose ("chat" — chat/session.py rejects a proof minted under
   * any other purpose, terminal's "terminal" included). */
  chatUnlock: async (): Promise<boolean> => {
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/chat/challenge', {});
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      await post('/chat/session', { ...proof });
      return true;
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },
  /** Revokes server-side immediately (chat/session.py's `_chat_session_drop`) —
   * unlike terminalLogout, a captured chat cookie stops working on its very
   * next presentation rather than surviving to its TTL. */
  chatLogout: async (): Promise<void> => {
    await post('/chat/logout', {});
  },

  // --- chat (server/chat/{routes,approval}.py) -----------------------------------
  /** Cold-start payload: every thread's summary + read cursor. Also the pull-
   * to-refresh call — chat/routes.py's `/chat/threads` runs the identical
   * query and the two have no reason yet to diverge (its own docstring). */
  chatBootstrap: async (): Promise<ChatBootstrapResponse> => get('/chat/bootstrap'),

  /** One thread's metadata + message history (durable transcript, not the
   * replay-only event log). `after_seq=0` reads everything this route keeps. */
  /** Start a conversation. The id is minted server-side (chat/routes.py) so a
   * client can never pick one and collide with a delivery target like `ops`. */
  chatCreateThread: async (title?: string): Promise<{ thread: Thread }> =>
    post('/chat/threads', { title: title ?? null }),

  chatThreadDetail: async (threadId: string, afterSeq = 0): Promise<ChatThreadDetailResponse> =>
    get(`/chat/threads/${encodeURIComponent(threadId)}?after_seq=${afterSeq}`),

  /** Advances the thread's read cursor. Cookie-gated only — never Face ID
   * (chat/routes.py: hub-owned, cheap, reversible). */
  chatMarkRead: async (threadId: string, seq: number): Promise<MarkReadResponse> =>
    post(`/chat/threads/${encodeURIComponent(threadId)}/read`, { seq }),

  /** Pin / rename / archive, the thread menu's three actions. Cookie-gated
   * like chatMarkRead — Hub-owned, cheap and reversible. POST rather than
   * PATCH because hub-api 405s every method but GET and POST before a route
   * sees it (app.py's `reject_non_get_outside_auth`). */
  chatPatchThread: async (threadId: string, patch: ThreadPatchInput): Promise<{ thread: Thread }> =>
    post(`/chat/threads/${encodeURIComponent(threadId)}/patch`, patch),

  /** Stop the turn in flight. The gateway's own `/stop` command does the work:
   * it carries `busy_policy: interrupt_then_dispatch`, so a running turn is
   * interrupted and then the command runs. Cookie-gated — stopping is cheap,
   * reversible and the user's own. */
  chatStopThread: async (threadId: string): Promise<{ status: string; thread_id: string }> =>
    post(`/chat/threads/${encodeURIComponent(threadId)}/stop`, {}),

  /** Answer the question the agent is parked on. NOT a chat message: the
   * gateway's clarify call is blocked on an event waiting for this id, and
   * resolving it hands the answer back as the tool's own result. Sending it
   * through `chatSend` instead would start a second turn and leave the first
   * parked until it timed out. */
  chatAnswerClarify: async (
    clarifyId: string,
    threadId: string,
    response: string,
  ): Promise<{ status: string; clarify_id: string }> =>
    post(`/chat/clarify/${encodeURIComponent(clarifyId)}`, { thread_id: threadId, response }),

  /** A human-typed message. Cookie-gated only, same as chatMarkRead — never
   * Face ID (chat/routes.py's module docstring: a plain send is not the
   * estate-wide-consequence write `/api/chat/approval/*` guards). `clientMsgId`
   * is the caller's own (see `newClientMsgId`) so a retry after a dropped
   * connection can reuse it verbatim and land on the same server-side row
   * instead of sending the user's words twice. */
  /** Whether the user is looking at the app. Drives whether a finished reply
   * notifies him; failure is silent because a missed report only means the
   * server falls back to its own staleness rule. */
  /** The child's own transcript — text, reasoning and tool calls — read back
   * out of the gateway's state. Only a subagent this thread actually ran can
   * be asked for; anything else is a 404 from hub-api, not a gateway call. */
  chatSubagentTranscript: (
    threadId: string,
    childSessionId: string,
  ): Promise<{ child_session_id: string; parts: Part[]; truncated: boolean }> =>
    get(`/chat/threads/${encodeURIComponent(threadId)}/subagent/${encodeURIComponent(childSessionId)}`),

  /** Tick a checklist item. The state is written into the widget itself, so it
   * is what every client reads back, and Xavier is told with the next message
   * rather than woken for a checkbox. */
  chatTickChecklist: (
    threadId: string,
    body: { message_id: string; part_index: number; item_index: number; state: string },
  ): Promise<{ status: string; label: string; state: string }> =>
    post(`/chat/threads/${encodeURIComponent(threadId)}/checklist`, body),

  chatPresence: (state: 'active' | 'background'): Promise<{ in_app: boolean }> =>
    post('/chat/presence', { state }),

  /** An attachment, stored before the message that carries it — the send
   * takes ids, not bytes (chat/routes.py `media_ids`). */
  chatUploadMedia: (
    threadId: string,
    body: { mime: string; data_b64: string; width: number | null; height: number | null },
  ): Promise<{ status: string; media_id: string; size_bytes: number }> =>
    post(`/chat/threads/${encodeURIComponent(threadId)}/media`, body),

  chatSend: async (
    threadId: string,
    text: string,
    clientMsgId: string,
    /** The composer's Queue / Steer / Redirect chip. Omitted means "leave the
     * gateway's own busy-input setting alone". */
    mode?: 'queue' | 'steer' | 'redirect',
    mediaIds?: string[],
  ): Promise<ChatSendResponse> =>
    post(`/chat/threads/${encodeURIComponent(threadId)}/send`, {
      text,
      client_msg_id: clientMsgId,
      ...(mode ? { mode } : {}),
      ...(mediaIds && mediaIds.length > 0 ? { media_ids: mediaIds } : {}),
    }),

  /** The `/` picker's catalog (VERDICT-V2 §4.6.2/§4.6.3, chat/routes.py's
   * `/chat/commands`). Cookie-gated like every other chat read. `source`
   * tells the caller nothing actionable today (both `"live"` and
   * `"bootstrap"` render identically) — it's here for the day a live push
   * lands and someone wants to confirm it did. */
  chatCommands: async (): Promise<ChatCommandsResponse> => get('/chat/commands'),

  // --- automations (server/chat/automations.py) ----------------------------------
  // Under /chat so the chat session cookie (path=/api/chat) rides along: a
  // run's output is the same material a chat thread holds.
  automations: async (): Promise<AutomationsResponse> => get('/chat/automations'),

  /** The tab badge's count. Outside /chat on purpose: it needs no cookie. */
  automationsBadge: async (): Promise<{ needs_you: number }> => get('/automations/badge'),

  automationsTimeline: async (before?: string | null): Promise<TimelineResponse> =>
    get(`/chat/automations/timeline${before ? `?before=${encodeURIComponent(before)}` : ''}`),

  automationJob: async (jobId: string): Promise<JobDetailResponse> =>
    get(`/chat/automations/jobs/${encodeURIComponent(jobId)}`),

  /** Opening a run reads it and makes sure the thread under it exists, which
   * is why this is a POST. */
  automationOpenRun: async (runId: string): Promise<RunOpenResponse> =>
    post(`/chat/automations/runs/${encodeURIComponent(runId)}/open`, {}),

  automationPrefs: async (jobId: string, prefs: PrefsInput): Promise<{ job: AutomationJob }> =>
    post(`/chat/automations/jobs/${encodeURIComponent(jobId)}/prefs`, prefs),

  automationMarkRead: async (jobId: string): Promise<{ job: AutomationJob }> =>
    post(`/chat/automations/jobs/${encodeURIComponent(jobId)}/read`, {}),

  automationsReadAll: async (): Promise<{ counts: AutomationsResponse['counts'] }> =>
    post('/chat/automations/read-all', {}),

  /** Everything waiting on the user, across every thread, newest first
   * (chat/routes.py's `/chat/attention`). The bootstrap read carries only the
   * rows of the threads it loaded, so this is the one call that can answer
   * "what needs me" without opening each thread in turn. */
  chatAttention: async (): Promise<ChatAttentionResponse> => get('/chat/attention'),

  /** Face-ID-gated approval batch — SAME challenge → assertion → apply shape
   * as answerDecision/saveTopicRouting, against chat/approval.py's T3 gate.
   * `decisions` is exactly the list rendered on one card: no `all: true`
   * shortcut exists on the wire (module docstring §(e)), and this client
   * never invents one. */
  chatApprovalApply: async (decisions: ApprovalDecisionInput[]): Promise<ApprovalApplyResponse> => {
    let challenge: AssertionChallenge;
    try {
      challenge = await post<AssertionChallenge>('/chat/approval/challenge', { decisions });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
    const proof = await requestActionAssertion(challenge);
    try {
      return await post<ApprovalApplyResponse>('/chat/approval/apply', { decisions, ...proof });
    } catch (err) {
      if (err instanceof ApiError) throw new ApplyError(toApplyCode(err), err.message);
      throw err;
    }
  },

  // --- files -----------------------------------------------------------------------------
  fsRoots: async (): Promise<FsRoot[]> => get('/files/roots'),
  fsBrowse: async (root: string, path: string): Promise<FsBrowseResponse> =>
    get(`/files/browse?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  fsRead: async (root: string, path: string): Promise<FsReadResponse> =>
    get(`/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
};
