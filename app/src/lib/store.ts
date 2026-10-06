import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';
import { create } from 'zustand';

// Same key the PWA uses (apps/hub/src/store/index.ts), and the same rule:
// 'system' stores nothing, an explicit pick stores 'light'/'dark'.
export const THEME_KEY = 'hub-theme';

export type ThemePref = 'system' | 'light' | 'dark';

interface AppState {
  pref: ThemePref;
  hydrated: boolean;
  setPref: (p: ThemePref) => Promise<void>;
  hydrate: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  pref: 'system',
  hydrated: false,
  setPref: async (p) => {
    set({ pref: p });
    // Drives the native side too: navigation bars, sheets and keyboards read
    // the window's interface style, not our token table. RN 0.86 spells the
    // "follow the OS" reset 'unspecified' (not null, and not 'auto').
    Appearance.setColorScheme(p === 'system' ? 'unspecified' : p);
    if (p === 'system') await AsyncStorage.removeItem(THEME_KEY);
    else await AsyncStorage.setItem(THEME_KEY, p);
  },
  hydrate: async () => {
    const v = await AsyncStorage.getItem(THEME_KEY);
    const pref: ThemePref = v === 'light' || v === 'dark' ? v : 'system';
    Appearance.setColorScheme(pref === 'system' ? 'unspecified' : pref);
    set({ pref, hydrated: true });
  },
}));
