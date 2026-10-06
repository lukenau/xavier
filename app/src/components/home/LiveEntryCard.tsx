// Live's entry point on Home: a door, in Money's shape (MoneyEntryCard).
//
// Live is one page with one entry, opened from the surface the app lands on.
// It is a mode you step into rather than a place you check, so it gets a door
// on Home the way Money does, not a tab of its own.
//
// Deliberately chart-free and state-free: it is a mode, not a report, so it
// renders the same before any session has ever run.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { Card, PRESSED_OPACITY } from '../shell';

export function LiveEntryCard() {
  const { t } = useTheme();

  return (
    <Card
      onPress={() => router.push('/live')}
      accessibilityLabel="Live — hands-free voice with Xavier"
      style={styles.card}
    >
      <View style={styles.row}>
        <SymbolView name="mic.fill" size={18} tintColor={t('accent')} weight="regular" />
        <View style={styles.text}>
          <Text style={[styles.title, { color: t('fg-0') }]}>Live</Text>
          <Text style={[styles.line, { color: t('fg-4') }]} numberOfLines={1} ellipsizeMode="tail">
            hands-free voice · walk around, talk, listen
          </Text>
        </View>
        <SymbolView name="chevron.right" size={15} tintColor={t('fg-4')} weight="regular" />
      </View>
      {/* The card opens the Live page, which resumes the remembered thread.
          This starts a NEW one, for a clean transcript without a trip through
          the page's own controls. */}
      <Pressable
        accessibilityLabel="Start a new Live session"
        accessibilityRole="button"
        onPress={() => router.push('/live?fresh=1')}
        style={({ pressed }) => [styles.newRow, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <SymbolView name="plus.circle" size={14} tintColor={t('accent')} weight="regular" />
        <Text style={[styles.newLabel, { color: t('accent') }]}>new session</Text>
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 13, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(580), fontSize: 15 },
  line: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 2, ...MONO_FEATURES },
  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingTop: 2,
  },
  newLabel: { fontFamily: fonts.sans(580), fontSize: 12.5 },
});
