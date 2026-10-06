// The Now treatment: typographic, on the page ground, with no border, fill or
// radius. It is the single most urgent sentence in the user's day, so it is the one
// thing on the screen that reads as prose rather than as a list row.
//
// When Now holds eight items it stacks eight of these. It still reads as a
// different KIND of object from the rows below, so Now never degrades into
// "the section that happens to be first" (spec §5.1).
import { PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, SCREEN_GUTTER } from '../shell';
import { ChipRow } from './Chips';
import {
  chipsFor,
  metaLine,
  originSymbol,
  rowAccessibilityLabel,
  type BriefItem,
} from './briefModel';

/** 2 lines normally, 3 once the text is large enough that two would truncate
 * something that matters (spec §10). */
export function titleLines(base: number, scale: number = PixelRatio.getFontScale()): number {
  return scale > 1.3 ? base + 1 : base;
}

export function NowBlock({
  item,
  onPress,
  failure,
  last,
  accessibilityActions,
  onAccessibilityAction,
}: {
  item: BriefItem;
  onPress: () => void;
  /** One line under the title when the last action on this row failed. */
  failure?: string | null;
  last?: boolean;
  /** Rotor entries. They belong HERE, on the element that carries the label
   * and the button role — VoiceOver focuses this, not the swipe wrapper. */
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
}) {
  const { t } = useTheme();
  const quote = item.evidence[0];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rowAccessibilityLabel(item)}
      accessibilityHint="Opens details"
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      onPress={onPress}
      style={({ pressed }) => [
        styles.block,
        last ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text numberOfLines={titleLines(3)} style={[styles.title, { color: t('fg-0') }]}>
        {item.title}
      </Text>
      {item.why ? (
        <Text numberOfLines={titleLines(2)} style={[styles.why, { color: t('fg-2') }]}>
          {item.why}
        </Text>
      ) : null}
      {/* Evidence is shown HERE and only here — the rows below send you to the
          sheet for it. A quote is what makes the Now item believable. */}
      {quote ? (
        <View style={[styles.quote, { borderLeftColor: t('border') }]}>
          <Text numberOfLines={titleLines(3)} style={[styles.quoteText, { color: t('fg-3') }]}>
            {quote}
          </Text>
        </View>
      ) : null}
      <ChipRow chips={chipsFor(item)} />
      {failure ? (
        <Text
          accessibilityRole="alert"
          maxFontSizeMultiplier={1.6}
          style={[styles.failure, { color: t('status-down') }]}
        >
          {failure}
        </Text>
      ) : null}
      <View style={styles.metaRow}>
        <SymbolView name={originSymbol(item.origin)} size={13} tintColor={t('fg-4')} weight="regular" />
        <Text maxFontSizeMultiplier={1.6} style={[styles.meta, { color: t('fg-4') }]}>
          {metaLine(item)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    paddingHorizontal: SCREEN_GUTTER,
    paddingVertical: 16,
    // minHeight only, never a fixed height — Dynamic Type has to be able to
    // grow this to any size (spec §10).
    minHeight: 64,
  },
  title: { fontFamily: fonts.sans(620), fontSize: 18, letterSpacing: -0.36 },
  why: { fontFamily: fonts.sans(400), fontSize: 14, marginTop: 5 },
  quote: { borderLeftWidth: 2, paddingLeft: 10, marginTop: 8 },
  quoteText: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 17 },
  failure: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  meta: { fontFamily: fonts.mono(400), fontSize: 11 },
});
