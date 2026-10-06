// What the Automations screens decide about a job or a run, kept out of the
// components so it can be tested without a renderer. Which job a run belongs
// to is never decided here: the server keys every run by the job that wrote
// it, and these functions only sort and label what arrives.
import type { TokenName } from '../theme/tokens.gen';
import type { AutomationJob, JobItem, QuietCount, RunSummary } from './types';

export type CategoryFilter = 'all' | 'ops' | 'money' | 'personal' | 'background';

export const CATEGORY_FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ops', label: 'Ops' },
  { id: 'money', label: 'Money' },
  { id: 'personal', label: 'Personal' },
  { id: 'background', label: 'Background' },
];

export interface JobSections {
  needsYou: AutomationJob[];
  fresh: AutomationJob[];
  /** Seen, but still true: an alert he has opened that no run has cleared. */
  stillOpen: AutomationJob[];
  upToDate: AutomationJob[];
  quiet: AutomationJob[];
}

/** The server puts each job in exactly one section, so the four lists always
 * add up to the jobs shown. A category filter narrows all four; something that
 * needs the user is never filtered out of view by being a background job. */
export function groupJobs(jobs: AutomationJob[], filter: CategoryFilter): JobSections {
  const out: JobSections = { needsYou: [], fresh: [], stillOpen: [], upToDate: [], quiet: [] };
  for (const job of jobs) {
    if (job.section === 'needs_you') {
      out.needsYou.push(job);
      continue;
    }
    if (filter !== 'all' && job.category !== filter) continue;
    else if (job.section === 'new') out.fresh.push(job);
    else if (job.section === 'earlier' && job.standing) out.stillOpen.push(job);
    else if (job.section === 'earlier') out.upToDate.push(job);
    else out.quiet.push(job);
  }
  return out;
}

/** How many jobs must be failing one way before they are shown as one row. */
export const CLUSTER_MIN = 3;
/** How many rows Up to date shows before the rest fold. */
export const EARLIER_SHOWN = 8;

export type NeedsYouEntry =
  | { kind: 'job'; job: AutomationJob }
  | { kind: 'cluster'; key: string; jobs: AutomationJob[]; preview: string };

/** Ten jobs that failed the same way are one problem, not ten. Jobs whose
 * latest run failed with the same output are gathered into one entry, placed
 * where the first of them stood; everything else keeps its own row and order. */
export function clusterFailures(jobs: AutomationJob[]): NeedsYouEntry[] {
  const groups = new Map<string, AutomationJob[]>();
  for (const job of jobs) {
    const key = job.latest?.severity === 'failed' ? job.latest.fingerprint : undefined;
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const out: NeedsYouEntry[] = [];
  const placed = new Set<string>();
  for (const job of jobs) {
    const key = job.latest?.severity === 'failed' ? job.latest.fingerprint : undefined;
    const group = key ? groups.get(key) : undefined;
    if (!key || !group || group.length < CLUSTER_MIN) {
      out.push({ kind: 'job', job });
    } else if (!placed.has(key)) {
      placed.add(key);
      out.push({ kind: 'cluster', key, jobs: group, preview: job.latest?.preview ?? '' });
    }
  }
  return out;
}

export type PillTone = 'warn' | 'down' | 'petrol' | 'accent' | 'plain';

export interface Pill {
  label: string;
  tone: PillTone;
}

export const PILL_TOKENS: Record<PillTone, { fg: TokenName; bg: TokenName; border: TokenName }> = {
  warn: { fg: 'status-warn', bg: 'status-warn-soft', border: 'status-warn-border' },
  down: { fg: 'status-down', bg: 'status-down-soft', border: 'status-down-border' },
  petrol: { fg: 'petrol', bg: 'petrol-soft', border: 'petrol-border' },
  accent: { fg: 'accent', bg: 'accent-soft', border: 'accent-border' },
  plain: { fg: 'fg-3', bg: 'bg-2', border: 'border' },
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function severityPill(run: RunSummary): Pill | null {
  if (run.severity === 'failed') return { label: 'Failed', tone: 'down' };
  if (run.severity === 'alert') return { label: 'Alert', tone: 'down' };
  if (run.severity === 'warn') {
    return { label: run.items > 0 ? plural(run.items, 'issue', 'issues') : 'Warning', tone: 'warn' };
  }
  return null;
}

/** A run in its job's history: what it said, measured against the report
 * before it. "3 new lines" is a diff, never a count of unread anything. */
export function runPills(run: RunSummary): Pill[] {
  const pills: Pill[] = [];
  const severity = severityPill(run);
  if (severity) pills.push(severity);
  if (run.unchanged && run.streak > 1) pills.push({ label: `Same for ${run.streak} runs`, tone: 'plain' });
  else if (run.new_lines > 0) pills.push({ label: plural(run.new_lines, 'new line', 'new lines'), tone: 'accent' });
  if (run.replies > 0) pills.push({ label: plural(run.replies, 'reply', 'replies'), tone: 'petrol' });
  return pills;
}

/** A job in the inbox: where it stands now. Its last alert shows only while
 * it is still true — a later clean run turns it into "Cleared" — and the only
 * count is how many of its reports he has not read. */
export function jobPills(job: AutomationJob): Pill[] {
  const pills: Pill[] = [];
  const latest = job.latest;
  const severity = latest ? severityPill(latest) : null;
  if (severity && job.standing !== false) pills.push(severity);
  else if (severity) pills.push({ label: 'Cleared', tone: 'plain' });
  if (latest && latest.unchanged && latest.streak > 1 && job.standing !== false) {
    pills.push({ label: `Same for ${latest.streak} runs`, tone: 'plain' });
  }
  if (job.unread > 0) pills.push({ label: `${job.unread} unread`, tone: 'accent' });
  if (latest && latest.replies > 0) pills.push({ label: plural(latest.replies, 'reply', 'replies'), tone: 'petrol' });
  if (job.state === 'paused') pills.push({ label: 'Paused', tone: 'plain' });
  if (job.state === 'removed' || job.state === 'completed') pills.push({ label: 'Ended', tone: 'plain' });
  if (job.snoozed_until) pills.push({ label: 'Snoozed', tone: 'plain' });
  if (job.notify === 'quiet') pills.push({ label: 'Quiet', tone: 'plain' });
  if (job.notify === 'muted') pills.push({ label: 'Muted', tone: 'plain' });
  if (job.origin_thread) pills.push({ label: 'Set up in a chat', tone: 'plain' });
  return pills;
}

/** The row's dot: what is wrong, else whether there is something unread. */
export function dotTone(severity: string, needsAttention: boolean, unread: boolean): TokenName {
  if (needsAttention) return severity === 'warn' ? 'status-warn' : 'status-down';
  return unread ? 'accent' : 'fg-4';
}

export function jobDot(job: AutomationJob): TokenName {
  return dotTone(job.latest?.severity ?? 'info', job.needs_you, job.unread > 0);
}

export function runDot(run: RunSummary): TokenName {
  const attention = !run.read && (run.severity === 'warn' || run.severity === 'alert' || run.severity === 'failed');
  return dotTone(run.severity, attention, !run.read && !run.unchanged);
}

/** What a job with nothing to show says under its name. */
export function quietLine(job: AutomationJob): string {
  if (job.latest) return job.latest.preview;
  const { runs, silent } = job.counts_30d;
  if (runs === 0) return job.state === 'active' ? 'Has not run yet' : 'No runs on record';
  if (silent === runs) return `${plural(runs, 'run', 'runs')} in 30 days, nothing to report`;
  return `${plural(runs, 'run', 'runs')} in 30 days`;
}

export function scheduleLine(job: AutomationJob): string {
  return [job.schedule, job.mode === 'script' ? 'script' : 'agent', job.state !== 'active' ? job.state : null]
    .filter(Boolean)
    .join(' · ');
}

const DELIVER_NAMES: Record<string, string> = {
  hub: 'Hub',
  discord: 'Discord',
  telegram: 'Telegram',
  local: 'Nowhere, output is kept on file',
  origin: 'The chat it was set up in',
};

/** "discord:1534…,hub:ops" as the places it names. */
export function deliverLabel(deliver: string | null): string {
  const seen: string[] = [];
  for (const target of (deliver ?? '').split(',')) {
    const platform = target.trim().split(':')[0];
    if (!platform) continue;
    const name = DELIVER_NAMES[platform] ?? platform;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen.join(', ') || 'Nowhere';
}

export function countsLine(job: AutomationJob): string {
  const c = job.counts_30d;
  const parts = [plural(c.runs, 'run', 'runs'), `${c.reported} reported`, `${c.silent} silent`];
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  return parts.join(' · ');
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** `day` is the server's calendar day, so it is compared as a calendar day —
 * never through a UTC instant, which would move it across midnight. */
export function dayLabel(day: string, now: Date = new Date()): string {
  const that = parseDay(day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return that.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function shortDate(iso: string): string {
  const when = new Date(iso);
  if (!Number.isFinite(when.getTime())) return '';
  return when.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function timeOf(iso: string): string {
  const when = new Date(iso);
  if (!Number.isFinite(when.getTime())) return '';
  return when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const QUIET_NAMED = 3;

/** One line for every run that day that had nothing to say. */
export function quietSummary(quiet: QuietCount[]): string {
  if (quiet.length === 0) return '';
  const named = quiet.slice(0, QUIET_NAMED).map((q) => (q.count > 1 ? `${q.name} ×${q.count}` : q.name));
  const rest = quiet.length - QUIET_NAMED;
  if (rest > 0) named.push(`${rest} more`);
  return named.join(' · ');
}

export function quietTotal(quiet: QuietCount[]): number {
  return quiet.reduce((sum, q) => sum + q.count, 0);
}

export function spanLabel(item: Extract<JobItem, { kind: 'span' }>): string {
  const what =
    item.span === 'silent'
      ? plural(item.count, 'silent run', 'silent runs')
      : `${plural(item.count, 'run', 'runs')}, same output`;
  const from = shortDate(item.from);
  const to = shortDate(item.to);
  return from === to ? `${what} · ${to}` : `${what} · ${from} – ${to}`;
}

/** Openers under a run. Each fills the composer for him to send, so none is
 * an action on its own; running the job again is the job page's gated button. */
export function quickAsks(run: Pick<RunSummary, 'severity'>): string[] {
  if (run.severity === 'failed') return ['Why did this fail?', 'What would fix it?'];
  if (run.severity === 'alert' || run.severity === 'warn') {
    return ['What should I do about this?', 'Why is this happening?'];
  }
  return ['Summarize this', 'Anything I need to do?'];
}

export const SNOOZE_CHOICES: { label: string; hours: number }[] = [
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 168 },
];

export const NOTIFY_CHOICES: { id: 'push' | 'quiet' | 'muted'; label: string; detail: string }[] = [
  { id: 'push', label: 'Push', detail: 'Notifies you when it reports something new' },
  { id: 'quiet', label: 'Quiet', detail: 'No notification, still shows as new' },
  { id: 'muted', label: 'Muted', detail: 'No notification, never shows as new' },
];
