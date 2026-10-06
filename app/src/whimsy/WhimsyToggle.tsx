// Settings control, styled to sit under ThemeToggle as its sibling.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { haptic } from './haptics';
import { useWhimsyStore, type WhimsyLevel } from './level';

const OPTIONS: { value: WhimsyLevel; label: string; caption: string }[] = [
  { value: 'off', label: 'Off', caption: 'Xavier stays out of sight' },
  { value: 'calm', label: 'Calm', caption: 'Xavier appears when it matters' },
  { value: 'full', label: 'Full', caption: 'Xavier everywhere, at your service' },
];

export function WhimsyToggle() {
  const { t } = useTheme();
  const level = useWhimsyStore((s) => s.level);
  const setLevel = useWhimsyStore((s) => s.setLevel);
  const current = OPTIONS.find((o) => o.value === level) ?? OPTIONS[2];

  return (
    <View>
      <View accessibilityRole="radiogroup" accessibilityLabel="Xavier" style={styles.row}>
        {OPTIONS.map((o) => {
          const on = o.value === level;
          return (
            <Pressable
              key={o.value}
              onPress={() => {
                void setLevel(o.value).then(() => haptic('select'));
              }}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [
                styles.pill,
                {
                  backgroundColor: on ? t('accent-soft') : t('bg-2'),
                  borderColor: on ? t('accent-border') : t('border'),
                },
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text style={[on ? styles.labelOn : styles.label, { color: on ? t('accent') : t('fg-2') }]}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.caption, { color: t('fg-4') }]}>{current.caption}</Text>
    </View>
  );
}

const PILL_FONT_SIZE = 11;
const label = {
  fontSize: PILL_FONT_SIZE,
  letterSpacing: PILL_FONT_SIZE * 0.08,
  textTransform: 'uppercase' as const,
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  pill: { flex: 1, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  label: { ...label, fontFamily: fonts.mono(400) },
  labelOn: { ...label, fontFamily: fonts.mono(600) },
  caption: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 8, paddingHorizontal: 4 },
});
