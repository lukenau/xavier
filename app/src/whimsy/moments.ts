// The registry. A screen names what is happening; this table decides how it
// feels. New page → reuse a moment or add a line; new kind of touch → a new
// field here and a consumer in the shared components.
import type { HapticName } from './haptics';
import type { WhimsyLevel } from './level';
import type { PoseId } from './poses';
import type { TokenName } from '../theme/tokens.gen';

// What the LED tile does once it has faded in: a gold scan band while he
// works, a sheen on success, a glitch on error, a border pulse when he needs
// you. `still` = entrance only.
export type MotionName = 'scan' | 'sheen' | 'glitch' | 'pulse' | 'still';

export interface MomentSpec {
  pose: PoseId;
  /** The tile's effect after its entrance. */
  motion: MotionName;
  /** Status dot on the tile's rim. */
  badge?: TokenName;
  /** Played once when the moment first appears. */
  haptic?: HapticName;
  /** Lowest level at which the pose is shown at all. */
  minLevel: Exclude<WhimsyLevel, 'off'>;
}

export const MOMENTS = {
  // Generic states — StatePanel falls back to these by tone.
  empty: { pose: 'tray-empty', motion: 'still', minLevel: 'calm' },
  loading: { pose: 'sniffing', motion: 'scan', minLevel: 'full' },
  error: { pose: 'oops', motion: 'glitch', badge: 'status-down', haptic: 'error', minLevel: 'calm' },
  success: { pose: 'triumph', motion: 'sheen', haptic: 'success', minLevel: 'calm' },
  'not-found': { pose: 'tilt', motion: 'still', minLevel: 'calm' },

  // Named moments screens can ask for directly.
  welcome: { pose: 'bow', motion: 'sheen', minLevel: 'calm' },
  'chat.empty': { pose: 'bow', motion: 'still', minLevel: 'calm' },
  'chat.working': { pose: 'ledger', motion: 'scan', minLevel: 'full' },
  'needs-you': { pose: 'ears-up', motion: 'pulse', haptic: 'warn', minLevel: 'calm' },
  delivery: { pose: 'tray-offer', motion: 'sheen', minLevel: 'calm' },
  offline: { pose: 'asleep', motion: 'still', minLevel: 'calm' },
  'all-clear': { pose: 'tray-empty', motion: 'still', minLevel: 'calm' },
} satisfies Record<string, MomentSpec>;

export type MomentId = keyof typeof MOMENTS;
