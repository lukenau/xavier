// Wire types for GET /api/brief and the two write endpoints.
//
// NOT in types.ts, which is a VERBATIM COPY of the PWA's and is enforced
// byte-for-byte by scripts/check-shared-parity.mjs: the daily brief has no PWA
// twin to copy from — this native screen is what replaces the /my-pages HTML
// page (spec §11) — so a shared file of its own is the only place the contract
// can live without breaking that guard.
//
// Field-by-field against brief_triage's _emit()/assemble() and the two keys
// hub-api's `brief` handler adds at serve time (served_date, hidden_count).

export type BriefBucket = 'now' | 'today' | 'week' | 'background';

export const BRIEF_BUCKETS: readonly BriefBucket[] = ['now', 'today', 'week', 'background'];

export interface BriefItem {
  /** 12 hex — the dismiss key. */
  item_id: string;
  /** Source ref (`cal:2026-09-16-…`), debug only. */
  id: string;
  title: string;
  /** Derived server-side (Rulings 71/93/95) — RENDER VERBATIM, never re-word. */
  why: string;
  /** What the sheet shows under the title. Capped and redacted by the generator. */
  detail?: string;
  /** 1–3 quotes. */
  evidence: string[];
  /** 'O1'…'O6'. */
  gate: string;
  /** Display name: 'Calendar', 'Superhuman'. */
  source: string;
  origin: string;
  kind: string;
  split: 'work' | 'personal' | string;
  /** ISO instant or 'YYYY-MM-DD'. */
  when: string;
  /** Age of the THING (Ruling 76). */
  age_days: number | null;
  carried_from: string;
  /** Days the brief has been carrying it (Ruling 76). This is the chip, never age_days. */
  carry_days: number | null;
  /**
   * '' | '/oura/' | '/my-pages/…', or an https URL: _link() folds
   * the candidate's `source_url` in here when there is no hub path, so this
   * field is NOT always a path. There is no separate `source_url` on an
   * emitted item — the spec's §3 listing of one is stale.
   */
  url: string;
  jump_url: string;
  /** item_ids. The generator filters these to shown items, but /api/brief then
   * drops dismissed ones, so they can still dangle by the time the app reads. */
  related: string[];
  conflict: boolean;
  /** Per-item HMAC write proof (Ruling 57), 24 hex. Absent on a brief generated
   * before that landed — every write surface must degrade, never post without it. */
  token?: string;
}

export interface BriefDeferred {
  item_id: string;
  title: string;
  reason: string;
  code: string;
  origin: string;
  /** _attribution(): without these the held-back list is N titles in no order. */
  when?: string;
  source?: string;
  /** DONE deferrals only — what closed it, in the model's own words. */
  closure?: string;
}

export interface Brief {
  date: string;
  generated_at: string;
  buckets: Record<BriefBucket, BriefItem[]>;
  deferred: BriefDeferred[];
  held_back: { total: number; by_code: Record<string, number> };
  /** Legacy duplicate the web page still reads — DO NOT read it here. */
  ambient_held_back?: number;
  carried: { count: number; candidates: number; from_date: string | null };
  /** The nine real inboxes. */
  sources: Record<string, string>;
  /** Pipeline stages (carry, money) — health, not inboxes. Never shown as sources. */
  stages?: Record<string, string>;
  provenance: {
    git_sha: string;
    deployed_at: string;
    finished: boolean;
    candidates_sha256: string;
  };
  gather_warnings?: { _warnings?: Record<string, string[]> };
  triage?: Record<string, unknown>;
  /** What the server actually served — differs from `date` when it fell back. */
  served_date?: string;
  /** mcp-watch's newest probe, per source: 'ok' | 'down'. Only the sources an
   * MCP determines appear; absent means "no live opinion", not healthy. */
  live_sources?: Record<string, string>;
  hidden_count?: number;
}

/** The three "why" chips UndoRow offers after a Done (Ruling 146) — a
 * dismissal in the pipeline's own words, not the user's. Codes, and what triage
 * (load_exemplars) reads them as: not-mine → D1/D4, done → DONE, noise →
 * D2/NOISE. */
export type BriefReason = 'not-mine' | 'done' | 'noise';

/** What POST /api/briefing/dismiss.json accepts. `undo` clears both stores. */
export type BriefAction =
  | 'dismiss'
  | 'snooze:1d'
  | 'snooze:3d'
  | 'snooze:1w'
  | 'undo'
  | `reason:${BriefReason}`;

export interface BriefDismissResult {
  ok: true;
  item_id: string;
  action: string;
  /** ISO instant, on a snooze only. */
  until?: string;
}

export interface BriefUsefulResult {
  ok: true;
  item_id: string;
  signal: 'useful';
  /** The ledger already had this (brief, item) — a double tap must not weight twice. */
  already?: boolean;
}

export interface BriefNoteResult {
  ok: true;
  item_id: string;
  signal: 'note';
}

/** One of the user's standing rules — his own sentence, read back into every
 * morning's prompt (Ruling 146). */
export interface BriefRule {
  id: string;
  text: string;
  ts: string;
}
