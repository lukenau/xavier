// Pinned above the composer while agents are still working somewhere up the
// transcript: how many, for how long, and what the first was asked. A tap
// scrolls back to their block. Shown only once newer rows have pushed the
// block out of view — when it is the newest thing on screen it speaks for
// itself.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { PRESSED_OPACITY } from '../../shell';
import { formatElapsed } from '../../../chat/transcript';
import { useElapsedSeconds } from './useElapsedSeconds';

export function RunningAgentsStrip({
  count,
  startedAt,
  goals,
  onPress,
}: {
  count: number;
  startedAt: string;
  goals: string[];
  onPress: () => void;
}) {
  const { t } = useTheme();
  const seconds = useElapsedSeconds(true, startedAt);
  const first = goals[0] ?? null;
  const title = `${count} ${count === 1 ? 'agent' : 'agents'} working · ${formatElapsed(seconds)}`;
  return (
    <Pressable
      testID="agents-strip"
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.strip,
        { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.glyph, { color: t('accent') }]}>⑂</Text>
      <View style={styles.text}>
        <Text style={[styles.title, { color: t('accent') }]} numberOfLines={1}>
          {title}
        </Text>
        {first ? (
          <Text style={[styles.goal, { color: t('fg-2') }]} numberOfLines={1}>
            {first}
            {goals.length > 1 ? `  +${goals.length - 1} more` : ''}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.chevron, { color: t('accent') }]}>↑</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 11,
  },
  glyph: { fontFamily: fonts.mono(500), fontSize: 13 },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.mono(500), fontSize: 11.5 },
  goal: { fontFamily: fonts.sans(400), fontSize: 12, marginTop: 1 },
  chevron: { fontFamily: fonts.sans(400), fontSize: 13 },
});
