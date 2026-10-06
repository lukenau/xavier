// Every string the Ops route derives from a server row, and the two colour
// mappings that go with them — lifted out of the section components so they
// can be tested without a renderer. Each is a 1:1 port of the function of the
// same name in apps/hub/src/routes/Ops.tsx; line refs are to that file.
import { ApiError, ApplyError, GateNotWiredError } from '../../lib/api';
import { fmtTokens, fmtUsd, shortModel } from '../../shared/seriesColors';
import { relTime } from '../../shared/time';
import type { TokenName } from '../../theme/tokens.gen';
import type {
  AgentSession,
  BackupStatus,
  CronJob,
  KanbanReport,
  TmuxPastSession,
  TmuxSession,
} from '../../lib/types';

/** Inline message for a failed write; null = silent (Ops.tsx:42-48).
 *
 * The PWA branches on `ApplyError | WebAuthnError`; natively the second half
 * of that union is `GateNotWiredError`, which api.applyWrite throws from the
 * assertion step AFTER the real /action/challenge POST (api.ts:144-146). It
 * carries the same `code` field, so the `cancelled`-is-silent rule is
 * unchanged — and its default code is `unknown`, so today every gated action
 * surfaces its message rather than failing silently.
 *
 * Ops.tsx:43-48, kept page-local rather than in a shared module the PWA does
 * not have. */
export function writeErrorMessage(err: unknown): string | null {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) {
    return err.code === 'cancelled' ? null : err.message;
  }
  return err instanceof Error ? err.message : 'Write failed.';
}

/** Ops.tsx:128-133 — only `discord` gets the accent pill (OQ-6: live sources
 * are telegram/cli/api_server/cron, so this is reproduced as-is, stale or not). */
export interface BadgeTone {
  bg: TokenName;
  border: TokenName;
  fg: TokenName;
}

export function sourceBadgeTone(source: string): BadgeTone {
  if (source === 'discord') return { bg: 'accent-soft', border: 'accent-border', fg: 'accent' };
  return { bg: 'bg-2', border: 'border', fg: 'fg-3' };
}

/** Ops.tsx:135-139. */
export function sessionMeta(s: AgentSession, now?: number): string {
  const parts = [relTime(s.last_active, now), `${s.message_count} msgs`];
  if (s.estimated_cost_usd != null) parts.push(`$${s.estimated_cost_usd.toFixed(2)}`);
  return parts.join(' · ');
}

/** Ops.tsx:228 — the odd one out: the last VISIBLE row keeps its border while
 * rows are hidden behind "Show all N", so the list reads as continuing. */
export function sessionRowHasBorder(index: number, shownCount: number, total: number): boolean {
  return !(index === shownCount - 1 && total <= 8);
}

/** Ops.tsx:211 — the first 8 unless expanded. */
export const SESSIONS_COLLAPSED_COUNT = 8;

/** Ops.tsx:264-266. */
export function jobDotToken(j: CronJob): TokenName {
  return j.state === 'active' ? 'status-up' : 'fg-4';
}

/** Ops.tsx:268-275 — prefers `schedule`, falls back to `repeat`. */
export function jobMeta(j: CronJob): string {
  const parts: string[] = [];
  const cadence = j.schedule ?? j.repeat;
  if (cadence) parts.push(cadence);
  if (j.next_run_at) parts.push(`next ${j.next_run_at}`);
  if (j.deliver) parts.push(j.deliver);
  return parts.join(' · ');
}

/** Ops.tsx:277-287. "last run: $0.08 · 1.2M tok · deepseek-v4-pro". A ledger
 * cost_status of 'unknown' renders "cost unknown" — never a fake $0.00.
 * Script (no-agent) jobs spend nothing on LLMs and say so plainly. */
export function lastRunCostLine(j: CronJob): string | null {
  if (j.mode === 'script') return 'last run: $0 LLM · no model';
  const c = j.cost?.last_run;
  if (!c) return null;
  const cost = c.cost_usd == null || c.cost_status === 'unknown' ? 'cost unknown' : fmtUsd(c.cost_usd);
  const model = c.model ? shortModel(c.model) : 'no model';
  return `last run: ${cost} · ${fmtTokens(c.tokens)} tok · ${model}`;
}

/** Ops.tsx:289-296. */
export function weekCostLabel(j: CronJob): string | null {
  const w = j.cost?.week;
  if (!w || w.runs === 0) return null;
  const parts = [`${w.runs} run${w.runs === 1 ? '' : 's'}`];
  if (w.cost_usd > 0) parts.push(fmtUsd(w.cost_usd));
  if (w.unknown_runs > 0) parts.push(`${w.unknown_runs} cost unknown`);
  return `7d: ${parts.join(' · ')}`;
}

/** Ops.tsx:678-683 — the tmux row's mono meta line. */
export function shellMeta(
  s: TmuxSession,
  multiHost: boolean,
  hostLabel: (id: string) => string,
  now?: number,
): string {
  return (
    (s.title ? `${s.name} · ` : '') +
    (multiHost ? `${hostLabel(s.host)} · ` : '') +
    `${s.attached ? 'attached' : 'detached'} · ${s.windows}w · ${relTime(s.created, now)}` +
    (s.protected ? ' · protected' : '')
  );
}

/** Ops.tsx:743-747 — the Resume panel's mono meta line. */
export function pastSessionMeta(s: TmuxPastSession, now?: number): string {
  return relTime(s.last_active, now) + (s.cwd ? ` · ${s.cwd}` : '') + (s.live ? ' · running' : '');
}

/** Ops.tsx:700-702 — one line per host reporting ok:false. A sleeping laptop
 * is this state, not an error: the VPS rows keep rendering beside it. */
export function unreachableHostLine(label: string, error: string | null): string {
  return `${label} unreachable — ${error ?? 'no response'}. Asleep?`;
}

/** Ops.tsx:553,597 — hub-tmuxd supplies `attach`; this is the client fallback. */
export function attachSnippet(attach: string | undefined, name: string): string {
  return attach ?? `tmux switch-client -t ${name}`;
}

/** Ops.tsx:801-804 — the Backups card's mono second line. Only what THIS
 * deployment's server reports: repo and size always, the schedule and the
 * append-only policy only when the status payload carries them. A literal
 * schedule+policy used to be appended here, which asserted one deployment's
 * configuration to every user of the app. */
export function backupSubLine(d: BackupStatus): string {
  const parts = [d.repo ?? 'repo unknown'];
  if (d.total_size_gb != null) parts.push(`${d.total_size_gb} GB`);
  if (d.schedule) parts.push(d.schedule);
  if (d.append_only) parts.push('append-only');
  return parts.join(' · ');
}

/** Ops.tsx:518 — the whole Board section is this one line. */
export function boardLine(columns: KanbanReport['columns']): string {
  return columns.map((c) => `${c.status} ${c.count}`).join(' · ');
}

/** True when the host shell manager simply isn't there — hub-tmuxd is an
 *  optional host daemon, so a fresh install (and the demo) answers 503 for
 *  /api/tmux/*. That is a state to explain, not a fault to paint red; only a
 *  non-503 failure keeps the error tone. */
export function isTmuxUnavailable(err: Error | null | undefined): boolean {
  return err instanceof ApiError && err.status === 503;
}

/** True when the shell list is refused only because the terminal is locked:
 *  /api/tmux/* needs the Face ID terminal session (401 terminal_locked), or
 *  nothing is enrolled yet (412). Also a state to explain, not a fault. */
export function isTmuxLocked(err: Error | null | undefined): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 412);
}
