// The end of the page: what was held back, what built this, and the one way
// the user can teach it something for tomorrow.
//
// The held-back line is pressable because "110 held back" is the one number on
// this screen that invites a "by what?"; "teach the brief" is pressable for
// the same reason a settings entry is — the terminus text itself is not, it
// is provenance for when something looks wrong.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, SCREEN_GUTTER } from '../shell';
import { heldBackSummary, terminusLine, type Brief } from './briefModel';

export function Terminus({
  brief,
  onHeldBack,
  onTeach,
}: {
  brief: Brief | undefined;
  onHeldBack: () => void;
  /** Opens RulesSheet (Ruling 146) — the user's standing rules, in his own words. */
  onTeach: () => void;
}) {
  const { t } = useTheme();
  const held = heldBackSummary(brief);
  const line = terminusLine(brief);

  return (
    <View style={styles.wrap}>
      {held ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={held}
          accessibilityHint="Shows everything the gate held back"
          onPress={onHeldBack}
          style={({ pressed }) => [styles.heldHit, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text maxFontSizeMultiplier={1.6} style={[styles.held, { color: t('fg-3') }]}>
            {held}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="teach the brief"
        accessibilityHint="Add or remove your own standing rules"
        onPress={onTeach}
        style={({ pressed }) => [styles.teachHit, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text maxFontSizeMultiplier={1.6} style={[styles.teach, { color: t('accent') }]}>
          teach the brief →
        </Text>
      </Pressable>
      {line ? (
        <Text maxFontSizeMultiplier={1.6} style={[styles.terminus, { color: t('fg-4') }]}>
          {line}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: SCREEN_GUTTER, paddingTop: 22 },
  heldHit: { minHeight: 44, justifyContent: 'center' },
  held: { fontFamily: fonts.mono(400), fontSize: 11 },
  teachHit: { minHeight: 44, justifyContent: 'center' },
  teach: { fontFamily: fonts.mono(400), fontSize: 11 },
  terminus: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 6 },
});
