import { useWhimsy, type WhimsyLevel } from './level';
import { MOMENTS, type MomentId, type MotionName } from './moments';
import { activeOccasion } from './occasions';
import type { HapticName } from './haptics';
import type { PoseId } from './poses';
import type { TokenName } from '../theme/tokens.gen';

export interface ResolvedMoment {
  id: MomentId;
  pose: PoseId;
  motion: MotionName;
  haptic?: HapticName;
  badge?: TokenName;
  occasion?: string;
}

const RANK: Record<WhimsyLevel, number> = { off: 0, calm: 1, full: 2 };

/** base → occasion → level/reduce-motion clamp. `null` = show nothing. */
export function resolveMoment(
  id: MomentId,
  level: WhimsyLevel,
  motionOk: boolean,
  now: Date,
): ResolvedMoment | null {
  const spec = MOMENTS[id];
  if (RANK[level] < RANK[spec.minLevel]) return null;
  const occasion = activeOccasion(id, now);
  return {
    id,
    pose: occasion?.pose ?? spec.pose,
    motion: motionOk ? spec.motion : 'still',
    haptic: 'haptic' in spec ? spec.haptic : undefined,
    badge: 'badge' in spec ? spec.badge : undefined,
    occasion: occasion?.id,
  };
}

export function useMoment(id: MomentId | undefined): ResolvedMoment | null {
  const { level, motion } = useWhimsy();
  if (!id) return null;
  return resolveMoment(id, level, motion, new Date());
}
