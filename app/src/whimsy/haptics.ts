// The app's haptic vocabulary. Call sites name the feeling, not the engine
// call, so the whole app's touch can be retuned here.
import * as Haptics from 'expo-haptics';
import { useWhimsyStore, type WhimsyLevel } from './level';

export type HapticName = 'tap' | 'select' | 'success' | 'warn' | 'error' | 'flourish';

// Calm keeps only the feedback that carries meaning.
const MIN_LEVEL: Record<HapticName, WhimsyLevel> = {
  tap: 'full',
  select: 'full',
  flourish: 'full',
  success: 'calm',
  warn: 'calm',
  error: 'calm',
};

const RANK: Record<WhimsyLevel, number> = { off: 0, calm: 1, full: 2 };

export function hapticAllowed(name: HapticName, level: WhimsyLevel): boolean {
  return RANK[level] >= RANK[MIN_LEVEL[name]];
}

const PLAY: Record<HapticName, () => Promise<void>> = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  select: () => Haptics.selectionAsync(),
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  warn: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  // A butler's "ta-da": two soft taps and a firm one.
  flourish: async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    await new Promise((r) => setTimeout(r, 70));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    await new Promise((r) => setTimeout(r, 90));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
  },
};

/** Fire-and-forget; a device without a Taptic Engine just stays still. */
export function haptic(name: HapticName): void {
  if (!hapticAllowed(name, useWhimsyStore.getState().level)) return;
  PLAY[name]().catch(() => undefined);
}
