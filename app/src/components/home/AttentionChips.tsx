// Attention chips (Home.tsx:173-221): compact, tappable, and rendered ONLY
// when something needs eyes. Silence is the healthy state.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import type { BackupStatus, HealthSummary } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { attentionChips } from './homeState';

export function AttentionChips({
  health,
  backups,
  failedRuns,
}: {
  health: HealthSummary | undefined;
  backups: BackupStatus | undefined;
  failedRuns: number;
}) {
  const { t } = useTheme();
  const chips = attentionChips({ health, backups, failedRuns });
  if (chips.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {chips.map((chip) => {
        const body = (
          <View
            style={[
              styles.chip,
              { backgroundColor: t('status-warn-soft'), borderColor: t('status-warn-border') },
            ]}
          >
            <View style={[styles.dot, { backgroundColor: t('status-warn') }]} />
            <Text style={[styles.label, { color: t('status-warn') }]}>
              {chip.label}
              {chip.href ? ' →' : ''}
            </Text>
          </View>
        );
        return chip.href ? (
          <Pressable
            key={chip.label}
            accessibilityRole="link"
            accessibilityLabel={chip.label}
            onPress={() => router.push(chip.href as Href)}
            style={({ pressed }) => (pressed ? { opacity: PRESSED_OPACITY } : null)}
          >
            {body}
          </Pressable>
        ) : (
          <View key={chip.label}>{body}</View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 17,
    borderWidth: 1,
    paddingHorizontal: 12,
    minHeight: 34,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  label: { fontFamily: fonts.mono(400), fontSize: 11 },
});
