// Every pure decision the brief screen makes about its data — buckets, chips,
// symbols, link routing, labels, copy. No React, no I/O.
//
// The wire types live in src/lib/briefTypes.ts (api.ts needs them too) and are
// re-exported here so the screen has one import.
import { SymbolView } from 'expo-symbols';
import {
  BRIEF_BUCKETS,
  type Brief,
  type BriefBucket,
  type BriefDeferred,
  type BriefItem,
} from '../../lib/briefTypes';

export { BRIEF_BUCKETS };
export type { Brief, BriefBucket, BriefDeferred, BriefItem };
export type { BriefAction, BriefReason, BriefDismissResult, BriefUsefulResult } from '../../lib/briefTypes';

/** Items in a bucket, in the order the server sent them. */
export function bucketView(brief: Brief | undefined, bucket: BriefBucket): BriefItem[] {
  return brief?.buckets?.[bucket] ?? [];
}

/** Every shown item, in bucket order. */
export function allItems(brief: Brief | undefined): BriefItem[] {
  return BRIEF_BUCKETS.flatMap((b) => bucketView(brief, b));
}

/**
 * The real inboxes and their health.
 *
 * `stages` is read as a fallback only: a brief generated before the
 * source/stage split published `carry` and `money` INSIDE `sources`, and
 * showing a pipeline stage as an inbox reads as a mailbox nobody can name.
 */
const STAGE_NAMES = new Set(['carry', 'money']);

export function sourceStrip(brief: Brief | undefined): { name: string; status: string }[] {
  const sources = brief?.sources ?? {};
  return Object.keys(sources)
    .filter((name) => !STAGE_NAMES.has(name))
    .map((name) => ({ name, status: sources[name] }));
}

/** Source names whose status is anything but ok. Stages excluded — a degraded
 * carry stage is not an input the user can go and check. */
export function degradedSources(brief: Brief | undefined): string[] {
  return sourceStrip(brief)
    .filter((s) => s.status !== 'ok')
    .map((s) => s.name);
}

/** A source the live probe says is back. `live_sources` is mcp-watch's newest
 * reading, carried by hub-api beside the brief's own snapshot; the snapshot
 * records the run that BUILT the brief and so goes on naming a source hours
 * after the user has reconnected it (a mail source reconnected in the afternoon
 * could still read as down in the next morning's brief). Only the sources
 * an MCP determines get a live opinion, and silence is not health — a source
 * the probe cannot speak for keeps the snapshot's word. */
function liveOk(brief: Brief | undefined, name: string): boolean {
  return (brief?.live_sources ?? {})[name] === 'ok';
}

/** What the brief screen's banner names: inputs this brief went without that
 * are still not answering. A reconnected source drops off within a probe cycle
 * rather than at tomorrow's run, and the Home card names none of them at all —
 * which inputs answered belongs beside the items it affected, not on a door. */
export function unresolvedSources(brief: Brief | undefined): string[] {
  return degradedSources(brief).filter((name) => !liveOk(brief, name));
}

/** Is this item's own input degraded right now? */
export function isStale(brief: Brief | undefined, item: BriefItem): boolean {
  const status = brief?.sources?.[item.origin];
  return status != null && status !== 'ok';
}

const HELD_BACK_COPY: Record<string, string> = {
  AMBIENT: 'ambient',
  DONE: 'already done',
  NOISE: 'noise',
  MERGED: 'merged',
  EVIDENCE: 'no quote to stand on',
  UNDECIDED: 'undecided',
  ROLE: 'duplicate role',
  D1: 'not yours to act on',
  D2: 'nothing to do',
  D4: 'too old',
};

/** '110 held back — 26 nothing to do, 24 already done, 22 no quote to stand on'.
 * Empty string when nothing was held back, so a caller can skip the row. */
export function heldBackSummary(brief: Brief | undefined): string {
  const total = brief?.held_back?.total ?? 0;
  if (total <= 0) return '';
  const by = brief?.held_back?.by_code ?? {};
  const top = Object.entries(by)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([code, n]) => `${n} ${HELD_BACK_COPY[code] ?? code.toLowerCase()}`);
  return top.length ? `${total} held back — ${top.join(', ')}` : `${total} held back`;
}

export type ChipTone = 'meta' | 'warn';
export interface Chip {
  label: string;
  tone: ChipTone;
}

/**
 * A chip means "unusual". Carried and conflict only — source and origin are
 * text, and a stale source is the banner's job, not a per-row badge. If every
 * row had chips, chips would mean nothing.
 *
 * `carry_days`, never `age_days` (Ruling 76 / spec §12.3).
 */
export function chipsFor(item: BriefItem): Chip[] {
  const chips: Chip[] = [];
  if (item.conflict) chips.push({ label: 'conflict', tone: 'warn' });
  const carried = item.carry_days;
  if (typeof carried === 'number' && carried > 0) {
    chips.push({ label: `carried ${carried}d`, tone: 'meta' });
  }
  return chips;
}

type SymbolName = React.ComponentProps<typeof SymbolView>['name'];

const ORIGIN_SYMBOLS: Record<string, SymbolName> = {
  calendar: 'calendar',
  email: 'envelope',
  imessage: 'message',
  'capture-sync': 'desktopcomputer',
  packages: 'shippingbox',
  oura: 'bed.double',
  finance: 'dollarsign.circle',
};

/** SF Symbol for an origin. An unknown origin gets a circle, never an emoji
 * and never a blank — a missing glyph reads as a broken row. */
export function originSymbol(origin: string): SymbolName {
  return ORIGIN_SYMBOLS[origin] ?? 'circle';
}

/** 'calendar · work'. Origin first because that is what the eye is scanning for. */
export function metaLine(item: BriefItem): string {
  return [item.origin, item.split].filter(Boolean).join(' · ');
}

export type LinkTarget =
  | { kind: 'route'; href: '/oura'; label: string }
  | { kind: 'page'; path: string; label: string }
  | { kind: 'external'; url: string; label: string }
  | { kind: 'app'; url: string; label: string }
  | null;

const GITHUB = /^https:\/\/github\.com\/[^\s]*$/;
const ATLASSIAN = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/[^\s]*$/i;

/**
 * Where "Open in source" goes, or null when nothing resolves.
 *
 * A closed allowlist, mirroring deepLinks.ts's stance: any other https host is
 * NOT opened. The sheet is the primary target for every item regardless — this
 * is only the secondary action, and its absence is a normal state (the
 * generator populates a link for a small minority of items by design).
 */
export function linkTarget(item: BriefItem): LinkTarget {
  const url = (item.url ?? '').trim();
  const jump = (item.jump_url ?? '').trim();
  if (url === '/oura/' || url === '/oura') return { kind: 'route', href: '/oura', label: 'Open Oura' };
  if (url.startsWith('/my-pages/')) return { kind: 'page', path: url, label: 'Open page' };
  // Any OTHER hub-absolute path is a route that left the tree — the closed
  // allowlist returns null, never a dead route push and never an origin
  // fallback (a calendar item carrying '/brief' must not open Calendar).
  if (url.startsWith('/')) return null;
  for (const candidate of [jump, url]) {
    if (GITHUB.test(candidate)) return { kind: 'external', url: candidate, label: 'Open on GitHub' };
    if (ATLASSIAN.test(candidate)) return { kind: 'external', url: candidate, label: 'Open in Jira' };
  }
  if (item.origin === 'email') return { kind: 'app', url: 'message://', label: 'Open Mail' };
  if (item.origin === 'imessage') return { kind: 'app', url: 'sms:', label: 'Open Messages' };
  if (item.origin === 'calendar') return { kind: 'app', url: 'calshow:', label: 'Open Calendar' };
  return null;
}

/** Related items that are actually on screen. A `related` id the brief no
 * longer shows renders as nothing, so it is dropped rather than rendered dead. */
export function resolveRelated(brief: Brief | undefined, item: BriefItem): BriefItem[] {
  if (!item.related?.length) return [];
  const byId = new Map(allItems(brief).map((i) => [i.item_id, i]));
  return item.related
    .filter((id) => id !== item.item_id)
    .map((id) => byId.get(id))
    .filter((i): i is BriefItem => i !== undefined);
}

export type SnoozeSpan = '1d' | '3d' | '1w';

export const SNOOZE_DAYS: Record<SnoozeSpan, number> = { '1d': 1, '3d': 3, '1w': 7 };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** 'YYYY-MM-DD' parsed as a LOCAL date (never UTC — a brief's date is a day,
 * not an instant). Shared by dateLine and cardDateLine so there is one date
 * parser, not two. */
function parseBriefDate(date: string): Date | null {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/**
 * When a snooze brings an item back, said the way a person would.
 *
 * Local-calendar arithmetic on purpose: a snooze is "days from today" in the
 * reader's own day, and adding 86_400_000 ms across a DST boundary lands on
 * the wrong date. `today` is a local Date; the return day is the same clock
 * time N days later.
 */
export function snoozeLabel(span: SnoozeSpan, today: Date = new Date()): string {
  const days = SNOOZE_DAYS[span];
  const then = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  if (days === 1) return `tomorrow (${DAY_NAMES[then.getDay()]})`;
  if (days <= 6) return `${DAY_NAMES[then.getDay()]} (${days} days)`;
  return `${MONTH_NAMES[then.getMonth()]} ${then.getDate()}`;
}

/** The server's `until` is what UndoRow should say when it has one; the local
 * computation above is the fallback for the optimistic window before it lands. */
export function untilLabel(until: string | undefined, span: SnoozeSpan, today?: Date): string {
  if (!until) return snoozeLabel(span, today);
  const when = new Date(until);
  if (Number.isNaN(when.getTime())) return snoozeLabel(span, today);
  const base = today ?? new Date();
  // Calendar days between two LOCAL midnights, never a millisecond division of
  // the raw instants: the server's `until` carries a time of day, and
  // (noon Sat − midnight Wed) / 86.4e6 rounds to 4, not 3.
  const days = Math.round(
    (new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime() -
      new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 1) return `tomorrow (${DAY_NAMES[when.getDay()]})`;
  if (days <= 6) return `${DAY_NAMES[when.getDay()]} (${days} days)`;
  return `${MONTH_NAMES[when.getMonth()]} ${when.getDate()}`;
}

/** No item in any bucket. NOT an error — see emptyCopy. */
export function isEmpty(brief: Brief | undefined): boolean {
  return allItems(brief).length === 0;
}

export interface EmptyCopy {
  title: string;
  detail: string;
  tone: 'calm' | 'degraded';
}

/**
 * An empty brief is a GOOD outcome — unless the inputs are missing, in which
 * case saying "nothing needs you" is a lie. The two cases get different copy
 * and the degraded one never claims the day is clear.
 */
export function emptyCopy(brief: Brief | undefined): EmptyCopy {
  const degraded = degradedSources(brief);
  if (degraded.length === 0) {
    return { title: 'Your day is clear.', detail: 'Nothing made it through the gate today.', tone: 'calm' };
  }
  return {
    title: 'Most of your inputs are missing',
    detail: `${degraded.join(', ')} ${degraded.length === 1 ? 'is' : 'are'} not reporting, so this is not a quiet day — it is an incomplete one.`,
    tone: 'degraded',
  };
}

/** Per-bucket copy for an empty section. Background returns null: an empty FYI
 * list is noise, so that section is omitted entirely. */
export function bucketEmptyCopy(bucket: BriefBucket): string | null {
  if (bucket === 'now') return 'Nothing needs you this minute.';
  if (bucket === 'today') return 'Nothing has to move today.';
  if (bucket === 'week') return 'Nothing dated this week.';
  return null;
}

export const BUCKET_LABELS: Record<BriefBucket, string> = {
  now: 'NOW',
  today: 'TODAY',
  week: 'THIS WEEK',
  background: 'BACKGROUND',
};

/** 'Tue Sep 16'. The date line, not a timestamp. */
export function dateLine(date: string): string {
  const local = parseBriefDate(date);
  if (!local) return date;
  return `${DAY_NAMES[local.getDay()]} ${MONTH_NAMES[local.getMonth()]} ${local.getDate()}`;
}

/**
 * 'Monday, Sep 22 · Daily brief' — the home card's title (Ruling 145,
 * amended). Full weekday, abbreviated month + day, then the label — the day
 * and what this is, and NOTHING derived from an item: the card used to lead
 * with the Now item's own title, which the user twice asked to be replaced with
 * something generic. A date that will not parse falls back to the bare label
 * rather than leaking the raw string onto the card.
 */
export function cardDateLine(date: string): string {
  const local = parseBriefDate(date);
  if (!local) return 'Daily brief';
  return `${DAY_NAMES_FULL[local.getDay()]}, ${MONTH_NAMES[local.getMonth()]} ${local.getDate()} · Daily brief`;
}

/** Set only when the server fell back to an older day — then it is the whole
 * story and the header has to say so. */
export function staleServedLabel(brief: Brief | undefined): string | null {
  const served = brief?.served_date;
  if (!served || !brief?.date || served === brief.date) return null;
  return `showing ${dateLine(served)} — today's brief hasn't landed`;
}

/** 'Generated 07:20 · build 0fb5735'. The terminus, in machine voice. */
export function terminusLine(brief: Brief | undefined): string {
  if (!brief) return '';
  const at = new Date(brief.generated_at);
  const clock = Number.isNaN(at.getTime())
    ? brief.generated_at
    : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const parts = [`Generated ${clock}`];
  if (brief.provenance?.git_sha) parts.push(`build ${brief.provenance.git_sha}`);
  if (!brief.provenance?.finished) parts.push('run did not finish');
  return parts.join(' · ');
}

/** The week row's meta: the why cut to its first clause, plus any chips. At
 * that distance the reader wants what and roughly when, not the justification. */
const CLAUSE_MIN = 6;

export function firstClause(why: string): string {
  const text = (why ?? '').trim();
  if (!text) return '';
  const cut = text.search(/[—;.]|\s-\s/);
  // A cut that would leave a stub ("due", "you") is worse than the whole line,
  // so a break inside the first few characters is ignored.
  const head = cut >= CLAUSE_MIN ? text.slice(0, cut) : text;
  return head.trim().replace(/[,\s]+$/, '');
}

/** VoiceOver reads one sentence per row; the rotor carries the actions. */
export function rowAccessibilityLabel(item: BriefItem): string {
  const parts = [item.title, item.why, item.source].filter(Boolean);
  const carried = item.carry_days;
  if (typeof carried === 'number' && carried > 0) {
    parts.push(`carried ${carried} ${carried === 1 ? 'day' : 'days'}`);
  }
  if (item.conflict) parts.push('conflicts with another item');
  return parts.join('. ');
}

/**
 * Whether a write can be attempted at all. A brief minted before the generator
 * emitted tokens carries none, and posting without one 403s — so the surface
 * hides its actions instead of offering a button that always fails.
 */
export function canWrite(item: BriefItem): boolean {
  return typeof item.token === 'string' && item.token.length > 0;
}

export type BriefWriteFailure = 'expired' | 'offline' | 'network' | 'untokened';

/** One line under the title when an action failed. Says what happened to the
 * action, never a raw status code. */
export function writeFailureCopy(kind: BriefWriteFailure): string {
  if (kind === 'expired') return "Couldn't dismiss — this brief expired. Pull to refresh.";
  if (kind === 'offline') return 'Dismissals are offline right now.';
  if (kind === 'untokened') return "This brief predates dismissals — pull to refresh.";
  return 'No connection — nothing was sent.';
}

/** Map an ApiError status onto the copy above. 403 and 503 are distinct
 * outcomes and must never collapse into one "failed" message. */
export function failureKind(status: number | undefined): BriefWriteFailure {
  if (status === 403) return 'expired';
  if (status === 503) return 'offline';
  return 'network';
}
