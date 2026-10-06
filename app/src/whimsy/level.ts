// How much Xavier the app shows. Full is the default; Calm keeps him to the
// moments that matter (empty, success, error); Off is the app as it was.
// The OS reduce-motion switch clamps motion independently of the level.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { useReducedMotion } from '../components/shell/motion';

export const WHIMSY_KEY = 'hub-whimsy';

export type WhimsyLevel = 'off' | 'calm' | 'full';

const LEVELS: WhimsyLevel[] = ['off', 'calm', 'full'];

interface WhimsyState {
  level: WhimsyLevel;
  setLevel: (l: WhimsyLevel) => Promise<void>;
  hydrate: () => Promise<void>;
}

export const useWhimsyStore = create<WhimsyState>((set) => ({
  level: 'full',
  setLevel: async (level) => {
    set({ level });
    await AsyncStorage.setItem(WHIMSY_KEY, level);
  },
  hydrate: async () => {
    const v = await AsyncStorage.getItem(WHIMSY_KEY);
    if (v && (LEVELS as string[]).includes(v)) set({ level: v as WhimsyLevel });
  },
}));

export interface Whimsy {
  level: WhimsyLevel;
  /** Decorative motion (idle float, entrances, wiggles) may run. */
  motion: boolean;
}

export function useWhimsy(): Whimsy {
  const level = useWhimsyStore((s) => s.level);
  const reduced = useReducedMotion();
  return { level, motion: level !== 'off' && !reduced };
}
