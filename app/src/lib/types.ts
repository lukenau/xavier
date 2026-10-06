// VERBATIM COPY of apps/hub/src/lib/types.ts (PWA). Do not edit by hand:
// scripts/check-shared-parity.mjs compares this file to the source and
// fails on any difference beyond the two allowed transforms — import
// paths, and `var(--token)` rewritten to the bare token name for
// src/theme's resolveToken(). Change the PWA first, then re-copy.
// --- end copy header; everything below is verbatim ---
// Wire types for the live hub-api (server/app.py). Shapes mirror the
// server contracts exactly; normalizers in api.ts own any coercion.

export type Status = 'up' | 'degraded' | 'down' | 'disabled';

export interface Service {
  id: string;
  name: string;
  status: Status;
  time_ago: string;
  latency_ms?: number | null;
  last_probe?: string;
  note?: string;
}

export interface HealthSummary {
  updated_at: string | null;
  overall: 'green' | 'amber' | 'red';
  services: Service[];
}

export interface Agent {
  id: string;
  name: string;
  model: string | null;
  status: Status | string;
  last_message_at: string | null;
  messages_today: number;
  avatar_glyph?: string | null;
}

export interface BackupStatus {
  latest?: { ts: string; duration_s?: number; bytes_added?: number; paths?: string[] };
  snapshot_count?: number;
  total_size_gb?: number;
  repo?: string;
  /** The deploying server's own schedule/policy, passed through verbatim when
   * the backup status file carries it (a human string such as a cadence plus
   * timezone). Absent when the deployment does not report one — the app never
   * invents it. */
  schedule?: string | null;
  append_only?: boolean | null;
  snapshots?: { id: string; ts: string; tags?: string[] }[];
  rel_time: string;
}

export interface ActivityEntry {
  id?: string;
  source?: string;
  kind?: 'info' | 'warn' | 'error' | 'neutral' | string;
  text?: string;
  source_label?: string;
  ts: string;
  time_label: string;
}

export interface ScheduledTask {
  id: string;
  label: string;
  cadence: string;
  next_run_at: string | null;
  last_run: { ts: string; ok: boolean; duration_s: number | null } | null;
}

export interface MyPage {
  slug: string;
  title: string;
  mtime: number | null;
  kind: 'brief' | 'page';
  description?: string;
}

export interface MyPagesResponse {
  pages: MyPage[];
}

// --- Feed (GET /api/feed) — agent artifacts, newest first ---------------------
export type FeedKind = 'brief' | 'report' | 'alert' | 'run' | 'status';

export interface FeedItem {
  id: string;
  ts: number; // epoch seconds
  kind: FeedKind;
  title: string;
  summary?: string | null;
  link?: string | null; // absolute or origin-relative URL (briefs)
  page_slug?: string | null;
  status?: string | null; // for kind 'run': ok | failed | silent …
  priority?: 'high' | null;
}

export interface FeedResponse {
  items: FeedItem[];
  status_line: { text: string; ts: number } | null;
  updated_at: string;
}

// --- Vitals (GET /api/vitals) ----------------------------------------------
export interface Vitals {
  agent: {
    id: string;
    name: string;
    status: 'up' | 'down' | 'unknown';
    model: string | null;
    gateway_state: string | null;
    discord_state: string | null;
    busy: boolean;
  };
  containers: { id: string; label: string; status: 'up' | 'down' | 'unknown'; latency_ms: number | null }[];
  activity: { sessions: number | null; turns: number | null; tool_calls: number | null; mcp_calls: number | null };
  spend: { today_usd: number | null; mtd_usd: number | null; cap_usd: number | null };
  cron: { total: number | null; next_label: string | null };
  updated_at: string;
}

// --- Sessions (GET /api/sessions*) ------------------------------------------
export interface AgentSession {
  id: string;
  source: string;
  model: string | null;
  title: string | null;
  message_count: number;
  tool_call_count: number;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  started_at: number | null;
  last_active: number | null;
  preview: string | null;
}

export interface SessionMessage {
  id: string | number;
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_calls: { name: string | null; arguments: string | null }[];
  timestamp: number | string | null;
  finish_reason: string | null;
  reasoning: string | null;
}

// --- Cron (GET /api/cron, /api/cron/logs, /api/cron/costs) --------------------
// Per-run ledger semantics (state.db v0.19.1): cost_usd is null when the ledger's
// cost_status is 'unknown' — render "cost unknown", never $0.00. Weekly sums only
// include known-cost runs; unknown runs ride along in unknown_runs.
export interface CronRunCost {
  at: number; // epoch seconds
  cost_usd: number | null;
  cost_status: string;
  tokens: number;
  model: string | null;
}

export interface CronDayCost {
  cost_usd: number;
  runs: number;
  unknown_runs: number;
}

export interface CronJobCost {
  last_run: CronRunCost | null;
  week: {
    runs: number;
    cost_usd: number;
    unknown_runs: number;
    tokens: number;
    days: Record<string, CronDayCost>; // key: 'YYYY-MM-DD' (America/New_York)
  };
}

export interface CronJob {
  id: string;
  name: string | null;
  schedule: string | null;
  repeat: string | null;
  next_run_at: string | null;
  deliver: string | null;
  mode: 'script' | 'agent';
  script: string | null;
  last_run: string | null;
  state: 'active' | 'paused' | 'completed' | 'disabled';
  active: boolean;
  cost?: CronJobCost | null; // absent when the bridge cost read degrades
}

export interface CronCostsJob extends CronJobCost {
  id: string;
  name: string | null;
  no_agent: boolean;
}

export interface CronCostsReport {
  generated_at: string;
  window_days: number;
  jobs: CronCostsJob[];
  count: number;
}

export interface CronReport {
  generated_at: string;
  jobs: CronJob[];
  count: number;
}

export interface CronRun {
  job_id: string | null;
  name: string | null;
  run_time: string | null;
  mode: string | null;
  status: string | null;
  output: string;
  truncated: boolean;
}

// --- Spend v2 (GET /api/spend/*) ----------------------------------------------
// Windows are calendar-honest: today = since local midnight (America/New_York),
// mtd = since the 1st. range/prev_range carry the resolved dates so every delta
// can be labeled with what it actually compares.
export interface SpendTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface SpendModelRow {
  model: string; // canonical id (vendor prefix stripped, dots→dashes for claude)
  provider: string;
  total_spend: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  sessions: number;
  share_pct: number;
  aliases?: string[]; // raw ids merged into this row
}

export interface SpendSummary {
  total_usd: number;
  window: string;
  range: { start: string; end: string }; // ISO dates/times, local tz
  prev_range: { start: string; end: string } | null;
  delta_pct: number | null;
  prev_total_usd: number | null;
  models: SpendModelRow[];
  by_provider: Record<string, number>;
  tokens: SpendTokens;
  sessions: number;
  cache: {
    read_tokens: number;
    saved_usd: number;
    saved_pct: number;
    would_have_cost_usd: number;
  };
  unpriced: { model: string; input: number; output: number; cache_read: number }[];
  updated_at: string;
}

export interface SpendPoint {
  date: string; // bucket key: hour '2026-07-18T14:00', day '2026-07-18', week = Monday's ISO date
  spend_usd: number;
  per_model: Record<string, number>;
  per_provider: Record<string, number>;
  tokens: { input: number; output: number; cache_read: number };
  sessions: number;
}

export interface SpendTimeseries {
  window: string;
  granularity: 'hour' | 'day' | 'week' | 'month';
  points: SpendPoint[];
}

// --- Recurring spend (GET /api/cost/recurring) -------------------------------
// The flat charges under the estate — VPS, Supermemory, Superhuman, the Claude
// Max plan — prorated onto the SAME window the spend pills resolve, so the card
// tiles the range line above it. Metered spend (OpenRouter, Anthropic API
// credits) is excluded by construction: it is already the hero, and the server
// never folds these totals into it. Ledger: the recurring-costs file
// (server-side, HUB_RECURRING_COSTS).
export interface RecurringItem {
  id: string;
  label: string;
  vendor: string | null;
  category: string | null;
  cadence: 'monthly' | 'annual';
  amount_usd: number; // as billed, at its own cadence
  daily_usd: number;
  monthly_usd: number; // normalized run-rate
  window_usd: number; // this item's share of the selected window
  note: string | null;
}

export interface RecurringCosts {
  window: string;
  range: { start: string; end: string };
  elapsed_days: number;
  items: RecurringItem[];
  total_window_usd: number;
  total_monthly_usd: number;
  excludes: string[];
  updated_on: string | null;
  updated_at: string;
}

// --- Personal finance snapshot (day-to-day spend surface) --------------------
// Written 3x/day by the hermes finance-snapshot.py cron. Amounts render on the
// Hub only (the private surface); positive = spend (outflow). RH agentic account
// is ring-fenced out upstream. See the finance-snapshot design note.
export type FinanceSourceStatus = 'ok' | 'degraded' | 'error';

export interface FinanceTxn {
  date: string; // YYYY-MM-DD
  merchant: string; // sanitized (<=40 chars, no URLs/control chars)
  amount: number; // positive = spend
  category: string;
  account_last4: string;
  pending: boolean;
  source: 'copilot' | 'plaid';
}

export interface FinanceCategoryTotal {
  category: string;
  amount: number;
}

export interface FinanceBudgetRow {
  category: string;
  month_to_date: number;
  budget: number;
  window: string;
  source: string;
}

export type FinanceMovementMeaning =
  | 'income' | 'interest' | 'reimbursement' | 'refund' | 'external_in'
  | 'spend' | 'card_payment' | 'debt_payment' | 'transfer' | 'transfer_out'
  | 'invest' | 'divest' | 'conduit_leg' | 'conduit_funding' | 'reversed';

export interface FinanceMovement {
  from: string; // account last4, or "external:<counterparty>"
  to: string;
  amount: number;
  date: string;
  meaning: FinanceMovementMeaning;
  confidence: 'observed' | 'single-sided';
  counterparty: string;
  category: string;
  sources: string[];
  reversal_of?: string;
}

export interface FinanceSnapshot {
  schema_version: number;
  asof: string;
  sources: {
    copilot_mcp: { status: FinanceSourceStatus; asof?: string; detail?: string };
    plaid: { status: FinanceSourceStatus; asof?: string; items_errored?: string[] };
  };
  spend_windows: {
    today: number;
    last_7d: number;
    last_30d: number;
    top_categories: FinanceCategoryTotal[];
  };
  spend: FinanceBudgetRow[];
  // schema_version 3+. The server resolves transactions into directed movements so one
  // movement recorded by both sides counts once. Optional: older snapshots lack it.
  // Institution logo (base64 PNG) + brand colour from Plaid, so an account can be
  // identified by its mark rather than by hue alone.
  institutions?: Record<string, { logo: string | null; color: string | null }>;
  movements?: FinanceMovement[];
  movement_stats?: { total: number; merged: number; single_sided: number; by_meaning: Record<string, number> };
  recent_transactions: FinanceTxn[];
  net_worth?: { total: number; assets: number; liabilities: number; delta_1d: number; delta_30d: number };
  alerts?: { id: string; rule: string; title: string; acked: boolean }[];
}

// --- OpenRouter account (GET /api/cost/openrouter) ------------------------------
export interface OpenRouterActivityRow {
  model: string;
  usage: number; // USD, account-side truth (catches aux calls state.db never sees)
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface OpenRouterKeyRow {
  name: string; // logical name from cost-watch.sh KEYS (hermes, capture-sync, ...)
  label: string | null; // OpenRouter's own masked key label
  usage: number | null; // that key's cumulative spend (USD)
  // Per-window spend, differenced from cumulative snapshots at LOCAL window
  // boundaries (OpenRouter's own meters are UTC and disagree with the page).
  windows: Record<string, { usd: number; since: string } | null>;
  delta_since_last: number | null; // ~one day's spend at the daily cron cadence
  ts: string | null;
}

export interface OpenRouterCredits {
  total_credits: number;
  total_usage: number;
  balance: number; // total_credits - total_usage (prepaid remaining)
  usage_daily?: number | null; // OpenRouter's own calendar meters (UTC)
  usage_monthly?: number | null;
  keys?: OpenRouterKeyRow[]; // per-key totals from the cost-watch snapshot trail
  activity?: OpenRouterActivityRow[] | null; // needs OPENROUTER_MGMT_KEY
  updated_at: string;
}

// --- Browser (GET /api/browser/sessions — Browserbase proxy) --------------------
export interface BrowserSessionLive {
  id: string;
  started_at: string | null;
  region: string | null;
  live_url: string | null;
  current_url: string | null;
  pages: string[];
}

export interface BrowserSessionRecent {
  id: string;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  pages: string[]; // main-frame navigation itinerary (phone-native "replay")
}

export interface BrowserSessions {
  running: BrowserSessionLive[];
  recent: BrowserSessionRecent[];
  updated_at: string;
}

// --- System reads (skills / plugins / mcp / memory / doctor / pairing) --------
export interface SkillRow {
  name: string;
  category: string | null;
  source: string;
  trust: string;
  status: string;
}

export interface SkillsReport {
  total: number;
  enabled: number | null;
  disabled: number | null;
  builtin: number | null;
  hub: number | null;
  local: number | null;
  categories: { name: string; count: number }[];
  skills: SkillRow[];
}

export interface PluginRow {
  name: string;
  status: string | null;
  version: string | null;
  description: string | null;
  source: string | null;
  enabled: boolean;
}

export interface PluginsReport {
  total: number;
  enabled: number;
  plugins: PluginRow[];
}

export interface McpServer {
  name: string;
  transport: string | null;
  tools: string | null;
  status: string | null;
  enabled: boolean;
}

export interface McpReport {
  count: number;
  enabled: number;
  servers: McpServer[];
}

export interface MemoryReport {
  built_in: string | null;
  provider: string | null;
  plugins: { name: string; note: string | null }[];
}

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorReport {
  sections: { name: string; checks: { status: DoctorStatus; label: string }[] }[];
  summary: { pass: number; warn: number; fail: number; total: number; ok: boolean };
}

export interface PairingReport {
  pending: { platform: string; code: string; user_id: string; user_name: string | null; age: string | null }[];
  approved: { platform: string; user_id: string; user_name: string | null }[];
  pending_count: number;
  approved_count: number;
}

// --- Kanban (GET /api/kanban) --------------------------------------------------
export interface KanbanReport {
  columns: { status: string; count: number }[];
  total: number;
  by_assignee: Record<string, number>;
  oldest_ready_age_seconds: number | null;
  tasks: { id: string; title: string; status: string; assignee: string | null; priority: string | null; created_at: string | null }[];
}

// --- Config (GET /api/config/full, /api/advisor) --------------------------------
export interface ConfigFullLeaf {
  key: string;
  label: string;
  value: unknown;
  type: 'bool' | 'int' | 'float' | 'dict' | 'list' | 'str';
  writable: boolean;
  sensitive: boolean;
  set: boolean;
}

export interface ConfigFullSection {
  id: string;
  label: string;
  leaves: ConfigFullLeaf[];
}

export interface ConfigFullReport {
  generated_at: string;
  section_count: number;
  leaf_count: number;
  sections: ConfigFullSection[];
}

export type AdvisorPreset = 'off' | 'quality' | 'cost';

export interface AdvisorState {
  preset: AdvisorPreset | 'custom';
  executor: string | null;
  advisor_enabled: boolean | null;
  advisor_model: string | null;
}

// --- Connectors (GET /api/connectors) --------------------------------------------
export interface ConnectorProvider {
  id: string;
  name: string;
  flow: 'oauth-loopback' | 'api-key' | 'device-code' | 'oauth';
  connect: 'native' | 'terminal' | 'api-key';
  connected: boolean;
  credentials: { index: string | null; label: string | null; type: string | null; active: boolean }[];
  connect_cmd: string;
}

export interface ConnectorsReport {
  providers: ConnectorProvider[];
  mcp: { name: string; connected: boolean; transport: string | null; status: string | null; reauth_cmd: string }[];
}

export interface OauthStatus {
  stage: 'pending' | 'connected' | 'failed';
  url: string | null;
  code: string | null;
  error?: string | null;
}

// --- Models (GET /api/chat/models — config picker source) ---------------------
export interface ChatModel {
  id: string;
  label: string;
}

// --- Host tmux sessions (hub-tmuxd; GET /api/tmux/sessions) ----------------------
export interface TmuxSession {
  name: string;
  created: number | null;
  attached: boolean;
  windows: number;
  protected: boolean;
  host: string;
  /** Claude Code's own session title (same string the Claude mobile app lists); null until the first prompt. */
  title: string | null;
  session_id: string | null;
}

export interface TmuxHost {
  id: string;
  label: string;
  ok: boolean;
  error: string | null;
}

/** A past Claude Code transcript on a host (GET /api/tmux/history) — resumable via tmux.spawn { resume }. */
export interface TmuxPastSession {
  host: string;
  session_id: string;
  title: string | null;
  cwd: string | null;
  last_active: number | null;
  /** Already running in a tmux pane; resuming it again would fork the transcript. */
  live: boolean;
}

export interface TmuxHistory {
  sessions: TmuxPastSession[];
  hosts: TmuxHost[];
}

export interface TmuxInventory {
  sessions: TmuxSession[];
  hosts: TmuxHost[];
}

// --- WebAuthn write gate (POST /api/action/*) -----------------------------------
export interface WriteRequest {
  action:
    | 'config.set'
    | 'cron.pause'
    | 'cron.resume'
    | 'cron.remove'
    | 'cron.run'
    | 'cron.create'
    | 'cron.edit'
    | 'pairing.approve'
    | 'pairing.revoke'
    | 'gateway.restart'
    | 'gateway.drain'
    | 'advisor.preset'
    | 'tmux.spawn'
    | 'tmux.kill'
    // Native-app pairing: mints the one-time enrol code the iPhone app posts to
    // /api/devicekey/register. Server-side it never reaches the bridge and is
    // reserved to a real passkey assertion (app.py _DEVICEKEY_ADMIN_ACTIONS).
    | 'devicekey.enroll_code';
  key?: string;
  value?: string;
  job_id?: string;
  accept_hooks?: boolean;
  schedule?: string;
  prompt?: string;
  name?: string;
  deliver?: string;
  repeat?: string;
  workdir?: string;
  script?: string;
  skills?: string[];
  no_agent?: boolean;
  platform?: string;
  code?: string;
  user_id?: string;
  preset?: AdvisorPreset;
  host?: string;
  resume?: string;
  cwd?: string;
}

export interface WriteResult {
  status: 'applied' | 'error' | 'restart_failed';
  code?: number;
  stdout?: string;
  stderr?: string;
  applied_at: string;
  preset?: string;
  keys_written?: string[];
  restarted?: boolean;
  restart_code?: number;
  restart_stderr?: string;
}

/** POST /api/action/apply { action: 'devicekey.enroll_code' } answers with this
 * instead of a WriteResult: the one-time code that pairs the native app's
 * Secure-Enclave key. Single-use, attempt-capped, `ttl_s` seconds to live. */
export interface DeviceEnrolCode {
  code: string;
  ttl_s: number;
  expires_at: string;
}

export interface PasskeyStatus {
  registered: boolean;
  count: number;
  rp_id: string;
  credentials: { label: string; created_at: string | null }[];
}

// --- Telegram topic routing (GET/POST /api/config/topics) ------------------------
export interface TopicsConfig {
  chat_id: string;
  topics: Record<string, number>;
  routes: Record<string, string>;
  pending_sync?: boolean;
  updated_at?: string;
}

export interface TopicsRouteRow {
  name: string;
  target: string;
  expected_deliver: string;
  pseudo: boolean;
  live_deliver: string | null;
  drift: boolean | null;
}

export interface TopicsReport {
  config: TopicsConfig;
  routes: TopicsRouteRow[];
  pending_sync: boolean;
  live_snapshot_at: string | null;
}

// --- Decision Inbox (GET /api/decisions; POST /api/decisions/{id}/{challenge,answer}) ---
export interface DecisionOption {
  key: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface DecisionAnswer {
  option_key: string | null;
  note: string | null;
  ts: string;
}

export interface Decision {
  id: string;
  title: string;
  summary: string;
  context_md?: string;
  options: DecisionOption[];
  evidence_url?: string | null;
  source: string;
  created: string;
  expires?: string | null;
  status: 'open' | 'answered' | 'dismissed';
  answer?: DecisionAnswer | null;
  // Stakes grouping (queue writer): required | tradeoff | frozen | info.
  category?: 'required' | 'tradeoff' | 'frozen' | 'info' | string;
  domain?: 'finance' | 'ops' | 'memory' | string;
  // Present on an automation's iMessage-draft card. Answered through the same
  // Face-ID gate as every card (api.answerDecision); the server applies the
  // verified answer to the draft's own approval CAS.
  draft_id?: number;
  // Full sentence ("Blocks: …" / "Nothing blocked — …") — render verbatim,
  // never badge on mere presence.
  blocking?: string | null;
}

export interface DecisionsReport {
  open: Decision[];
  answered: Decision[];
  errors: string[];
  updated_at: string;
}

export type ApplyErrorCode =
  | 'cancelled'
  | 'no_passkey'
  | 'challenge_expired'
  | 'assertion_invalid'
  | 'phase_2_pending'
  | 'bad_request'
  | 'bridge_error'
  | 'network'
  | 'unknown';

// --- Files (GET /files/*) --------------------------------------------------------
export type FsEntryKind = 'dir' | 'file' | 'other' | 'unknown';

export interface FsRoot {
  id: string;
  label: string;
  path: string;
  exists: boolean;
}

export interface FsEntry {
  name: string;
  kind: FsEntryKind;
  size: number | null;
  modified: number | null;
}

export interface FsBrowseResponse {
  root: string;
  root_label: string;
  path: string;
  parent: string | null;
  entries: FsEntry[];
  truncated: boolean;
}

export interface FsReadResponse {
  root: string;
  path: string;
  size: number;
  text: string;
}
