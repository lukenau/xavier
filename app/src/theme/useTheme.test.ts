import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';
import { dark, light } from './tokens.gen';
import { resolveScheme, resolveToken } from './useTheme';
import { THEME_KEY, useAppStore } from '../lib/store';

beforeEach(async () => {
  await AsyncStorage.clear();
  useAppStore.setState({ pref: 'system', hydrated: false });
});

describe('resolveScheme', () => {
  test('an explicit pick wins over the OS in both directions', () => {
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });

  test('system follows the OS, defaulting to dark when the OS reports nothing', () => {
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', null)).toBe('dark');
    // RN 0.86's useColorScheme() says 'unspecified', not null, when unset.
    expect(resolveScheme('system', 'unspecified')).toBe('dark');
  });
});

describe('native appearance override', () => {
  test('an explicit pick pins the window, system releases it', async () => {
    const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
    try {
      await useAppStore.getState().setPref('light');
      expect(spy).toHaveBeenLastCalledWith('light');
      // 'unspecified' is RN 0.86's reset value; null throws at the type level
      // and 'auto' is not in the union.
      await useAppStore.getState().setPref('system');
      expect(spy).toHaveBeenLastCalledWith('unspecified');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveToken', () => {
  test('returns the value for the active scheme', () => {
    expect(resolveToken('dark', 'accent')).toBe(dark.accent);
    expect(resolveToken('light', 'accent')).toBe(light.accent);
    expect(resolveToken('dark', 'bg-0')).not.toBe(resolveToken('light', 'bg-0'));
  });

  test('resolves var() references against the same scheme', () => {
    // tokens.css keeps 4 composite tokens that reference other tokens.
    expect(dark['glow-accent']).toContain('var(--accent-glow)');
    expect(resolveToken('dark', 'glow-accent')).toBe(
      dark['glow-accent'].replace('var(--accent-glow)', dark['accent-glow']),
    );
    expect(resolveToken('light', 'chrome-veil')).toContain(light['bg-0']);
  });

  test('leaves no unresolved var() in any token of either scheme', () => {
    for (const scheme of ['dark', 'light'] as const) {
      for (const name of Object.keys(dark) as (keyof typeof dark)[]) {
        expect(resolveToken(scheme, name)).not.toContain('var(--');
      }
    }
  });
});

describe('theme preference persistence', () => {
  test('an explicit pick round-trips through storage', async () => {
    await useAppStore.getState().setPref('light');
    expect(await AsyncStorage.getItem(THEME_KEY)).toBe('light');

    useAppStore.setState({ pref: 'system' });
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().pref).toBe('light');
  });

  test('system clears the key rather than storing "system" (PWA parity)', async () => {
    await useAppStore.getState().setPref('dark');
    await useAppStore.getState().setPref('system');
    expect(await AsyncStorage.getItem(THEME_KEY)).toBeNull();
  });

  test('hydrate falls back to system on an absent or junk value', async () => {
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().pref).toBe('system');
    expect(useAppStore.getState().hydrated).toBe(true);

    await AsyncStorage.setItem(THEME_KEY, 'chartreuse');
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().pref).toBe('system');
  });
});
