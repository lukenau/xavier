// The degraded-source line. One row, above everything, in machine voice.
//
// This exists so an incomplete brief can never be mistaken for a quiet day —
// which is exactly what the old page did when a source fell over.
import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { SCREEN_GUTTER } from '../shell';
import { unresolvedSources, type Brief } from './briefModel';

export function sourceBannerText(names: string[]): string {
  if (names.length === 0) return '';
  const list = names.join(', ');
  return names.length === 1
    ? `${list} isn’t reporting — this brief is incomplete`
    : `${list} aren’t reporting — this brief is incomplete`;
}

export function SourceBanner({ brief }: { brief: Brief | undefined }) {
  const { t } = useTheme();
  const names = unresolvedSources(brief);
  if (names.length === 0) return null;
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.banner,
        { backgroundColor: t('bg-1'), borderTopColor: t('border'), borderBottomColor: t('border') },
      ]}
    >
      <SymbolView
        name="exclamationmark.triangle"
        size={13}
        tintColor={t('status-warn')}
        weight="regular"
      />
      <Text maxFontSizeMultiplier={1.6} style={[styles.text, { color: t('status-warn') }]}>
        {sourceBannerText(names)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: SCREEN_GUTTER,
    paddingVertical: 10,
    // A top hairline too (Minor 6): the header above is transparent, so
    // without one the bg-1 block started abruptly with no separation.
    borderTopWidth: 1,
    borderBottomWidth: 1,
    minHeight: 40,
  },
  text: { flex: 1, minWidth: 0, fontFamily: fonts.mono(400), fontSize: 11, lineHeight: 15 },
});
