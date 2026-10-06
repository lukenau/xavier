// XavierCard's derivations (XavierCard.tsx:9-54,114-141). Pure — no
// react-native import — because the card itself draws a Skia ring and a test
// that imported it would drag the native canvas in.
import type { AgentSession, CronRun, PairingReport, Vitals } from '../../lib/types';
import type { TokenName } from '../../theme/tokens.gen';
import { relTime } from '../../shared/time';

const FAILED = /(fail|error)/i;

/** XavierCard.tsx:9-12 — a DIFFERENT shortModel from seriesColors.ts's. */
export function shortModel(model: string | null): string {
  if (!model) return '';
  return model.replace('claude-', '').replace('openai/', '');
}

export function isFailedRun(run: CronRun): boolean {
  return Boolean(run.status && FAILED.test(run.status));
}

export function failedRunCount(runs: CronRun[] | undefined): number {
  return runs?.filter(isFailedRun).length ?? 0;
}

/** A failure anywhere in the fetched window beats a newer silent success. */
export function pickLastRun(runs: CronRun[] | undefined): CronRun | undefined {
  return runs?.find(isFailedRun) ?? runs?.find((r) => r.status) ?? runs?.[0];
}

/** Any value but exactly 'connected' is down — including null (inventory OQ-4). */
export function discordDown(vitals: Vitals | undefined): boolean {
  return vitals != null && vitals.agent.discord_state !== 'connected';
}

export interface XavierState {
  status: 'up' | 'down' | 'unknown';
  busy: boolean;
  /** Gateway down = red (Xavier is off). Discord down = amber (runs, can't hear the user). */
  ring: TokenName;
  presence: string;
  name: string;
  todayLine: string;
  lastRun: CronRun | undefined;
  lastRunFailed: boolean;
  needsYou: number;
  needsYouDetail: string;
}

export function xavierState(
  vitals: Vitals | undefined,
  sessions: AgentSession[] | undefined,
  pairing: PairingReport | undefined,
  runs: CronRun[] | undefined,
  now = Date.now(),
): XavierState {
  const status = vitals?.agent.status ?? 'unknown';
  const busy = vitals?.agent.busy ?? false;
  const discord = discordDown(vitals);
  const latest = sessions?.[0];
  const lastRun = pickLastRun(runs);
  const failCount = failedRunCount(runs);
  const pendingPairs = pairing?.pending_count ?? 0;

  const ring: TokenName =
    status === 'down'
      ? 'status-down'
      : discord
        ? 'status-warn'
        : status === 'up'
          ? 'status-up'
          : 'status-warn';

  const presence =
    status === 'down'
      ? 'gateway unreachable'
      : discord
        ? 'Discord disconnected — gateway up'
        : busy
          ? 'working right now'
          : latest
            ? `active ${relTime(latest.last_active, now)} · ${latest.source}${latest.model ? ` · ${shortModel(latest.model)}` : ''}`
            : 'idle · no recent sessions';

  const a = vitals?.activity;
  const spendToday = vitals?.spend.today_usd;
  const todayLine =
    `${a?.sessions ?? '–'} sessions · ${a?.turns ?? '–'} turns · ${a?.tool_calls ?? '–'} tools` +
    (spendToday != null ? ` · $${spendToday.toFixed(2)}` : '');

  return {
    status,
    busy,
    ring,
    presence,
    name: vitals?.agent.name ?? 'Xavier',
    todayLine,
    lastRun,
    lastRunFailed: lastRun ? isFailedRun(lastRun) : false,
    needsYou: pendingPairs + failCount,
    needsYouDetail:
      pendingPairs > 0 && failCount > 0
        ? 'pairing + failed runs →'
        : pendingPairs > 0
          ? 'pairing approval →'
          : 'failed cron runs →',
  };
}

// --- liveness ring geometry (XavierCard.tsx:7,68-79 / theme.md §5.3) -------

/** 46px avatar, ring span `inset-[-4px]`, annulus 2.5px→2px in the CSS mask. */
export const AVATAR_SIZE = 46;
export const RING_INSET = 4;
export const RING_SIZE = AVATAR_SIZE + RING_INSET * 2;
export const RING_STROKE = 2.5;
/** `animation: ring-rotate 2.4s linear infinite` (globals.css:47-49). */
export const RING_SPIN_MS = 2400;
/** `pulse-up 2.4s cubic-bezier(0.4,0,0.2,1) infinite` (globals.css:40-43). */
export const PULSE_MS = 2400;

/**
 * `conic-gradient(from 0deg, transparent 8%, <ring> 42%, transparent 78%)` as
 * Skia sweep-gradient stops: the two flat runs (0→8%, 78→100%) have to be
 * spelled out, because a sweep gradient interpolates between neighbours and
 * CSS holds the first/last colour to the edges.
 */
export const RING_STOPS = [0, 0.08, 0.42, 0.78, 1];

/**
 * The transparent end of the ring gradient. Skia's native colour parser is not
 * guaranteed to know the CSS keyword `transparent`, so an alpha-0 form of the
 * ring's own colour is used whenever the token is a plain `#rrggbb` — which
 * every ring token is, in both schemes (pinned by a test). The keyword is the
 * fallback for a token that is ever changed to a non-hex form.
 */
export function ringFade(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}00` : 'transparent';
}

export function ringColors(color: string): string[] {
  const fade = ringFade(color);
  return [fade, fade, color, fade, fade];
}
