// The undo line, in the row's own slot.
//
// Why here and not in the shell's Toast: Toast is `pointerEvents="none"` — it
// is the PWA's fixed overlay — so it cannot host a button. Undo needs one, and
// putting it in the slot the row just vacated also keeps the list from jumping
// (spec §8.1, §11.3).
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, SCREEN_GUTTER } from '../shell';
import type { BriefReason } from '../../lib/briefTypes';

/** The three "why" chips (Ruling 146) — the user's tap becomes the pipeline's own
 * words, not his: `not-mine` reads as D1/D4, `done` as DONE, `noise` as
 * D2/NOISE to tomorrow's gate (see load_exemplars). */
const REASON_CHIPS: { code: BriefReason; label: string }[] = [
  { code: 'not-mine', label: 'not mine' },
  { code: 'done', label: 'already done' },
  { code: 'noise', label: 'not important' },
];

export interface UndoRowReason {
  explained: boolean;
  onExplain: (code: BriefReason) => void;
}

export function UndoRow({
  label,
  onUndo,
  last,
  reason,
}: {
  label: string;
  onUndo: () => void;
  last?: boolean;
  /** Present only on a Done row — a snooze is "not now", not "not mine", so
   * it gets no chips (Ruling 146). */
  reason?: UndoRowReason;
}) {
  const { t } = useTheme();
  return (
    <View
      // Announced without stealing focus — the row under the reader's finger
      // just changed out from under them.
      accessibilityLiveRegion="polite"
      style={[
        styles.wrap,
        last ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
      ]}
    >
      <View style={styles.row}>
        <SymbolView name="checkmark" size={13} tintColor={t('fg-4')} weight="regular" />
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={1.6}
          style={[styles.label, { color: t('fg-3') }]}
        >
          {label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo"
          onPress={onUndo}
          style={({ pressed }) => [styles.undoHit, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.undo, { color: t('accent') }]}>Undo</Text>
        </Pressable>
      </View>
      {reason ? (
        reason.explained ? (
          <Text maxFontSizeMultiplier={1.6} style={[styles.reasonLine, { color: t('fg-4') }]}>
            Noted
          </Text>
        ) : (
          <View style={styles.reasonRow}>
            <Text maxFontSizeMultiplier={1.6} style={[styles.reasonLine, { color: t('fg-4') }]}>
              why?
            </Text>
            {REASON_CHIPS.map(({ code, label: chipLabel }) => (
              <Pressable
                key={code}
                accessibilityRole="button"
                accessibilityLabel={chipLabel}
                hitSlop={8}
                onPress={() => reason.onExplain(code)}
                style={({ pressed }) => [styles.reasonChip, pressed && { opacity: PRESSED_OPACITY }]}
              >
                <Text maxFontSizeMultiplier={1.6} style={[styles.reasonChipText, { color: t('accent') }]}>
                  · {chipLabel}
                </Text>
              </Pressable>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: SCREEN_GUTTER, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48 },
  label: { flex: 1, minWidth: 0, fontFamily: fonts.mono(400), fontSize: 11 },
  undoHit: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  undo: { fontFamily: fonts.sans(550), fontSize: 14 },
  reasonRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 1 },
  reasonLine: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  reasonChip: { minHeight: 32, justifyContent: 'center', paddingVertical: 4, paddingHorizontal: 2 },
  reasonChipText: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
