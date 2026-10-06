// Easter eggs: hidden triggers that briefly override a pose. Each egg is a
// counter on a target plus what it does when it fires.
import { useCallback, useRef, useState } from 'react';
import { haptic } from './haptics';
import type { PoseId } from './poses';

export interface Egg {
  id: string;
  taps: number;
  /** Taps must land within this window. */
  windowMs: number;
  pose: PoseId;
  holdMs: number;
}

export const EGGS = {
  // Pet Xavier five times and he rings the bell for you.
  'pet-xavier': { id: 'pet-xavier', taps: 5, windowMs: 2000, pose: 'triumph', holdMs: 2600 },
} satisfies Record<string, Egg>;

export type EggId = keyof typeof EGGS;

/** Returns an onPress to attach to the target and the pose the egg is showing, if any. */
export function useEgg(id: EggId): { onTap: () => void; pose: PoseId | undefined } {
  const egg: Egg = EGGS[id];
  const taps = useRef<number[]>([]);
  const [pose, setPose] = useState<PoseId | undefined>();

  const onTap = useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current.filter((ts) => now - ts < egg.windowMs), now];
    if (taps.current.length < egg.taps) {
      haptic('tap');
      return;
    }
    taps.current = [];
    haptic('flourish');
    setPose(egg.pose);
    setTimeout(() => setPose(undefined), egg.holdMs);
  }, [egg]);

  return { onTap, pose };
}
