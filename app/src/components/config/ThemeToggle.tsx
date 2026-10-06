// 1:1 port of apps/hub/src/components/shell/ThemeToggle.tsx's Segmented +
// caption (the ThemePill half belongs to the Home header, not here).
//
// The PWA's live "resolved" scheme comes from a matchMedia listener; natively
// useTheme() already resolves the pref against useColorScheme(), which RN
// updates on an OS scheme change — same liveness, one less listener.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { ThemePref } from '../../lib/store';
import { PRESSED_OPACITY } from '../shell';

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The caption under the three pills (ThemeToggle.tsx:74-78). */
export function themeCaption(pref: ThemePref, resolved: 'light' | 'dark'): string {
  return pref === 'system'
    ? `following this device · ${resolved} right now`
    : `pinned to ${pref} · this device only`;
}

export function ThemeToggle() {
  const { t, pref, setPref, scheme } = useTheme();

  return (
    <View>
      <View accessibilityRole="radiogroup" accessibilityLabel="Appearance" style={styles.row}>
        {OPTIONS.map((o) => {
          const on = o.value === pref;
          return (
            <Pressable
              key={o.value}
              onPress={() => {
                void setPref(o.value);
              }}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [
                styles.pill,
                {
                  backgroundColor: on ? t('accent-soft') : t('bg-2'),
                  borderColor: on ? t('accent-border') : t('border'),
                },
                pressed && { opacity: PRESSED_OPACITY },
              ]}
            >
              <Text style={[on ? styles.pillLabelOn : styles.pillLabel, { color: on ? t('accent') : t('fg-2') }]}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.caption, { color: t('fg-4') }]}>{themeCaption(pref, scheme)}</Text>
    </View>
  );
}

const PILL_FONT_SIZE = 11;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  pill: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `font-mono text-[11px] uppercase tracking-[0.08em]` — RN letterSpacing is
  // points, so 11 × 0.08.
  pillLabel: {
    fontFamily: fonts.mono(400),
    fontSize: PILL_FONT_SIZE,
    letterSpacing: PILL_FONT_SIZE * 0.08,
    textTransform: 'uppercase',
  },
  pillLabelOn: {
    fontFamily: fonts.mono(600),
    fontSize: PILL_FONT_SIZE,
    letterSpacing: PILL_FONT_SIZE * 0.08,
    textTransform: 'uppercase',
  },
  caption: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 8, paddingHorizontal: 4 },
});
