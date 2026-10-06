// Every pure decision Home's small cards make: staleness, chip conditions,
// stakes counting, the brief's "did today's land" test, the two date/time
// formatters. Kept free of react-native / expo imports (the T15 geometry.ts
// pattern) so the logic that decides what the user is TOLD is testable under
// plain jest, with no native module in the tree.
//
// Ports: Header.tsx:13-19,32-40 (staleness + dot), Home.tsx:103-145
// (DecisionsBanner), :35-44 (BriefCard), :173-197 (AttentionChips),
// PagesShelf.tsx:9-15 (fmtWhen), DecisionCards.tsx:26-29 (stakesOf).
import type { AgentSession, BackupStatus, Decision, HealthSummary, MyPage } from '../../lib/types';
import type { TokenName } from '../../theme/tokens.gen';

/** Header.tsx:13 — a health feed older than this is not trusted to say anything. */
export const STALE_AFTER_S = 15 * 60;

/** Header.tsx:15-19. Seconds since the feed was written; null if unparseable. */
export function healthStaleness(health: HealthSummary | undefined, now = Date.now()): number | null {
  if (!health?.updated_at) return null;
  const age = (now - new Date(health.updated_at).getTime()) / 1000;
  return Number.isNaN(age) ? null : age;
}

export interface HealthDot {
  token: TokenName;
  stale: boolean;
  /** `aria-label` in the PWA; `accessibilityLabel` here (Header.tsx:67). */
  label: string;
  /** `--glow-up` rides the dot only for a fresh green feed (Header.tsx:71). */
  glow: boolean;
}

/** Header.tsx:32-40,67,71. `null` age counts as stale — no data is not "green". */
export function healthDot(health: HealthSummary | undefined, now = Date.now()): HealthDot {
  const age = healthStaleness(health, now);
  const stale = age === null || age > STALE_AFTER_S;
  const overall = health?.overall ?? 'green';
  const token: TokenName = stale
    ? 'fg-4'
    : overall === 'green'
      ? 'status-up'
      : overall === 'amber'
        ? 'status-warn'
        : 'status-down';
  return {
    token,
    stale,
    label: stale ? 'health feed stale' : `health ${overall}`,
    glow: !stale && overall === 'green',
  };
}

/**
 * The blur radius out of a `<x> <y> <blur> <color>` shadow token, so the
 * wordmark's glow follows `--glow-text` instead of a copied number. `none`
 * (the light-scheme value) and anything unparseable return null, which the
 * header reads as "no shadow" — RN's Text has no boxShadow, only the three
 * textShadow* props, so the token has to be taken apart by hand.
 */
export function shadowBlurRadius(token: string): number | null {
  // `<x> <y> <blur>` with the unit optional on each — the token table spells
  // a zero-length as a bare `0` (`0 0 10px …`, `0 0 0 2.5px …`).
  const match = /^\s*-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+([\d.]+)(?:px)?(?=\s|$)/.exec(token);
  return match ? Number(match[1]) : null;
}

/** Header.tsx:87 — `weekday: short, month: short, day: numeric` in the device locale. */
export function formatHeaderDate(now: Date): string {
  return now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Home.tsx:58 / PagesShelf.tsx:13 — the app's one clock format: 12-hour `h:mm AM`. */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// --- DecisionsBanner (Home.tsx:103-145) ------------------------------------

const STAKES = ['required', 'tradeoff', 'info', 'frozen'] as const;
export type Stakes = (typeof STAKES)[number];

/** DecisionCards.tsx:26-29 — missing/unknown category folds into "needs your answer". */
export function stakesOf(d: Decision): Stakes {
  return (STAKES as readonly string[]).includes(d.category ?? '') ? (d.category as Stakes) : 'required';
}

export interface DecisionsBannerView {
  /** "2 need your answer · 5 your call" — stakes-honest, never a flat count. */
  headline: string;
  /** Titles of the `required` cards, first two, `· …` past that; '' when none. */
  subline: string;
}

export function decisionsBannerView(decisions: Decision[]): DecisionsBannerView | null {
  if (decisions.length === 0) return null;
  const c = { required: 0, tradeoff: 0, info: 0, frozen: 0 };
  for (const d of decisions) c[stakesOf(d)] += 1;
  const parts: string[] = [];
  if (c.required) parts.push(`${c.required} need${c.required === 1 ? 's' : ''} your answer`);
  if (c.tradeoff) parts.push(`${c.tradeoff} your call`);
  if (c.info) parts.push(`${c.info} for later`);
  if (c.frozen) parts.push(`${c.frozen} frozen`);
  const titles = decisions.filter((d) => stakesOf(d) === 'required').map((d) => d.title);
  return {
    headline: parts.join(' · '),
    subline: titles.length > 0 ? titles.slice(0, 2).join(' · ') + (titles.length > 2 ? ' · …' : '') : '',
  };
}

// --- BriefCard (Home.tsx:35-72) --------------------------------------------

export interface BriefCardView {
  brief: MyPage;
  /** Home.tsx:38 — UTC slug vs LOCAL hour, reproduced as-is (inventory OQ-1). */
  missingToday: boolean;
  subline: string;
}

export function briefCardView(pages: MyPage[] | undefined, now = new Date()): BriefCardView | null {
  const brief = pages?.find((p) => p.kind === 'brief');
  if (!brief) return null;
  const todaySlug = `briefing-${now.toISOString().slice(0, 10)}`;
  const missingToday = brief.slug !== todaySlug && now.getHours() >= 8;
  const subline = missingToday
    ? `latest is ${brief.slug.replace('briefing-', '')} — today's brief hasn't landed`
    : brief.mtime
      ? `generated ${formatClock(brief.mtime * 1000)}`
      : 'daily brief';
  return { brief, missingToday, subline };
}

// --- PagesShelf (PagesShelf.tsx:9-15) --------------------------------------

/** Under a day old → the clock; older → `Mon D`; no mtime → ''. */
export function fmtWhen(mtime: number | null, now = Date.now()): string {
  if (!mtime) return '';
  const ms = mtime * 1000;
  const days = (now - ms) / 86_400_000;
  if (days < 1) return formatClock(ms);
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// --- DiscordRow (Home.tsx:74-101) ------------------------------------------

export function discordSession(sessions: AgentSession[] | undefined): AgentSession | undefined {
  return sessions?.find((s) => s.source === 'discord');
}

// --- AttentionChips (Home.tsx:173-221) -------------------------------------

export interface AttentionChip {
  label: string;
  /** Absent = not a link (the backup chip has nowhere useful to go). */
  href?: string;
}

export interface AttentionInput {
  health: HealthSummary | undefined;
  backups: BackupStatus | undefined;
  failedRuns: number;
  now?: number;
}

/**
 * Silence is the healthy state — an empty array renders nothing at all.
 * Note the deliberate mismatch with `healthDot`: a null age is NOT a chip
 * here (no data ≠ stale data), while the header dot goes grey (inventory
 * OQ-5, preserved).
 */
export function attentionChips({ health, backups, failedRuns, now = Date.now() }: AttentionInput): AttentionChip[] {
  const chips: AttentionChip[] = [];
  const age = healthStaleness(health, now);
  const stale = age !== null && age > STALE_AFTER_S;
  if (failedRuns > 0) {
    chips.push({ label: `${failedRuns} failed run${failedRuns === 1 ? '' : 's'}`, href: '/feed' });
  }
  if (stale && age !== null) {
    const span = age > 86400 ? `${Math.floor(age / 86400)}d` : `${Math.floor(age / 3600)}h`;
    chips.push({ label: `health feed stale ${span}`, href: '/ops' });
  }
  if (health && !stale) {
    // services/rel_time are typed required but a truncated summary must not
    // crash Home — degrade to "no down-chips" instead.
    const down = (health.services ?? []).filter((s) => s.status === 'down');
    if (down.length > 0) chips.push({ label: `down: ${down.map((s) => s.name).join(', ')}`, href: '/ops' });
  }
  if (backups?.latest?.ts) {
    const backupAge = (now - new Date(backups.latest.ts).getTime()) / 1000;
    if (backupAge > 48 * 3600) chips.push({ label: `last backup ${backups.rel_time ?? 'unknown'}` });
  }
  return chips;
}
