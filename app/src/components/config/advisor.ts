// Pure logic behind /config/advisor (AdvisorPage.tsx:21-106, 373-418): the
// preset table, the "is the gateway back yet" predicate, the selection
// toggle, and the three result strings. Split out of the screen so it is
// unit-testable without a renderer or a clock.
import type { AdvisorPreset, HealthSummary } from '../../lib/types';

export interface PresetMeta {
  id: AdvisorPreset;
  label: string;
  executor: string;
  advisor: string | null;
  blurb: string;
  badge?: { text: string; tone: 'good' | 'warn' };
}

// Order + copy is the product surface here — keep it in sync with hub-api
// ADVISOR_PRESETS. Quality first (recommended), then Off, then Cost (caution).
export const PRESETS: PresetMeta[] = [
  {
    id: 'quality',
    label: 'Quality',
    executor: 'claude-sonnet-4-6',
    advisor: 'claude-opus-4-8',
    blurb: 'Sonnet does the work, Opus reviews it. Strongest results — the recommended default.',
    badge: { text: 'Recommended', tone: 'good' },
  },
  {
    id: 'off',
    label: 'Off',
    executor: 'claude-sonnet-4-6',
    advisor: null,
    blurb:
      'Advisor disabled — a solo agent on the current default model. Fewest tokens per turn, no second opinion.',
  },
  {
    id: 'cost',
    label: 'Cost',
    executor: 'claude-haiku-4-5',
    advisor: 'claude-opus-4-8',
    blurb: 'Haiku does the work, Opus reviews it. Cheapest — but Haiku can fumble tool-heavy tasks.',
    badge: { text: 'Caution', tone: 'warn' },
  },
];

/** Short model label — drops the "claude-" prefix for the dense summary rows. */
export function shortModel(m: string | null): string {
  if (!m) return '—';
  return m.replace(/^claude-/, '');
}

/** AdvisorPage.tsx:312 — 'custom' reads as "Custom", the rest capitalise. */
export function presetLabel(preset: AdvisorPreset | 'custom'): string {
  return preset === 'custom' ? 'Custom' : preset.charAt(0).toUpperCase() + preset.slice(1);
}

/**
 * The advisor tool only works on the direct Anthropic provider. Only a KNOWN
 * non-anthropic provider blocks the surface — an unreadable config tree can't
 * veto (AdvisorPage.tsx:371).
 */
export function isAdvisorBlocked(provider: string | null): boolean {
  return provider !== null && provider !== 'anthropic';
}

/** The blocked card's body names the provider, spelling OpenRouter properly. */
export function providerLabel(provider: string | null): string {
  return provider === 'openrouter' ? 'OpenRouter' : (provider ?? '');
}

/**
 * waitForGatewayHealthy's per-poll decision (AdvisorPage.tsx:74-75): the
 * gateway row is the first service whose id OR name mentions "gateway"; with
 * no such row, overall green stands in.
 */
export function isGatewayHealthy(h: HealthSummary): boolean {
  const gw = h.services.find((s) => /gateway/i.test(s.id) || /gateway/i.test(s.name));
  return gw ? gw.status === 'up' : h.overall === 'green';
}

/** Tapping a card toggles it; tapping the already-live preset is a no-op
 * (nothing to restart for) — AdvisorPage.tsx:376. */
export function nextSelection(
  prev: AdvisorPreset | null,
  tapped: AdvisorPreset,
  current: AdvisorPreset | 'custom' | null,
): AdvisorPreset | null {
  if (prev === tapped) return null;
  return tapped === current ? null : tapped;
}

/** The preset wrote, the restart did not (WriteResult.status === 'restart_failed'). */
export function restartFailedMessage(label: string, stderr: string | undefined): string {
  const why = (stderr || '').trim().replace(/\s+/g, ' ').slice(0, 140);
  return `${label} written to config, but the gateway restart failed${
    why ? ` (${why})` : ''
  }. Restart it from Ops to make it live.`;
}

export function switchedMessage(label: string): string {
  return `Advisor now ${label} — gateway back online.`;
}

export function notHealthyYetMessage(label: string): string {
  return `${label} applied, but the gateway hasn't reported healthy yet. Give it a moment or check Ops — the preset is written, so it will take once the gateway is up.`;
}

/** waitForGatewayHealthy's timings (AdvisorPage.tsx:67-82). */
export const GATEWAY_WAIT = { headStartMs: 3000, deadlineMs: 32_000, pollMs: 2000 };
