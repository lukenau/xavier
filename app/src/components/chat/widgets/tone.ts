import type { Tone } from '../../../chat/widget';
import type { TokenName } from '../../../theme/tokens.gen';

const TONE: Record<Tone, TokenName> = {
  neutral: 'fg-2',
  up: 'status-up',
  down: 'status-down',
  warn: 'status-warn',
  accent: 'accent',
};

const TONE_SOFT: Record<Tone, TokenName> = {
  neutral: 'bg-2',
  up: 'status-up-soft',
  down: 'status-down-soft',
  warn: 'status-warn-soft',
  accent: 'accent-soft',
};

export function toneToken(tone: Tone): TokenName {
  return TONE[tone];
}

export function toneSoftToken(tone: Tone): TokenName {
  return TONE_SOFT[tone];
}

/** Painted as a shape rather than as text. `neutral` is `fg-2`, a body-text
 * grey, which made an untoned progress bar read as disabled — a bar's default
 * is the brand colour (design review, 2026-09-22). */
export function fillToken(tone: Tone): TokenName {
  return tone === 'neutral' ? 'accent' : TONE[tone];
}
