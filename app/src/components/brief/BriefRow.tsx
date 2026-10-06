// One full-bleed row, at one of three densities. Nothing here is a card:
// border, fill and radius say "separate object", and 44 separate objects is the
// thing this screen exists not to be. Hairlines and full-bleed rows are also
// the iOS list idiom (Mail, Reminders) and the only geometry where a swipe
// action feels right (spec §1.3 principle 4).
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, SCREEN_GUTTER } from '../shell';
import { ChipRow, SplitRule } from './Chips';
import { titleLines } from './NowBlock';
import {
  chipsFor,
  firstClause,
  originSymbol,
  rowAccessibilityLabel,
  type BriefItem,
} from './briefModel';

export type RowDensity = 'today' | 'week' | 'background';

/** Background items need nothing, so offering Done/Snooze on them would imply
 * they do. Tapping still opens the sheet (spec §5.4). */
export function isSwipeable(density: RowDensity): boolean {
  return density !== 'background';
}

export interface BriefRowProps {
  item: BriefItem;
  density: RowDensity;
  onPress: () => void;
  failure?: string | null;
  last?: boolean;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
}

export function BriefRow({
  item,
  density,
  onPress,
  failure,
  last,
  accessibilityActions,
  onAccessibilityAction,
}: BriefRowProps) {
  const { t } = useTheme();

  const body =
    density === 'background' ? (
      // The coda: one line, quietest ink on the page. FYI has no owner, so it
      // gets no split rule either. titleLines(1), matching every other title
      // on the screen (H14a) — at AX5 an uncapped single line held almost
      // nothing.
      <Text numberOfLines={titleLines(1)} ellipsizeMode="tail" style={[styles.bgText, { color: t('fg-3') }]}>
        {item.title}
      </Text>
    ) : (
      <>
        <View style={styles.titleRow}>
          <Text
            numberOfLines={titleLines(2)}
            ellipsizeMode="tail"
            style={[
              density === 'today' ? styles.todayTitle : styles.weekTitle,
              { color: t(density === 'today' ? 'fg-0' : 'fg-1') },
            ]}
          >
            {item.title}
          </Text>
          <SymbolView
            name={originSymbol(item.origin)}
            size={13}
            tintColor={t('fg-4')}
            weight="regular"
          />
        </View>
        {density === 'today' ? (
          // titleLines(1), matching the file's own convention (H14b) — was
          // unbounded scaling on a hard-coded single line.
          <Text numberOfLines={titleLines(1)} style={[styles.why, { color: t('fg-2') }]}>
            {item.why}
          </Text>
        ) : (
          // At this distance the reader wants what and roughly when, not the
          // full justification — the sheet has it (spec §5.3).
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.6}
            style={[styles.weekMeta, { color: t('fg-4') }]}
          >
            {firstClause(item.why)}
          </Text>
        )}
        <ChipRow chips={chipsFor(item)} />
      </>
    );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rowAccessibilityLabel(item)}
      accessibilityHint="Opens details"
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        DENSITY[density],
        last ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      {density === 'background' ? null : <SplitRule split={item.split} />}
      {body}
      {failure ? (
        <Text
          accessibilityRole="alert"
          maxFontSizeMultiplier={1.6}
          style={[styles.failure, { color: t('status-down') }]}
        >
          {failure}
        </Text>
      ) : null}
    </Pressable>
  );
}

// minHeight only — every one of these grows with Dynamic Type rather than
// clipping (spec §10). All three clear the 44pt target; ≥48 is the floor.
const DENSITY = StyleSheet.create({
  today: { paddingVertical: 12, minHeight: 64 },
  week: { paddingVertical: 10, minHeight: 56 },
  background: { paddingVertical: 9, minHeight: 48 },
});

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: SCREEN_GUTTER,
    justifyContent: 'center',
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  todayTitle: { flex: 1, minWidth: 0, fontFamily: fonts.sans(580), fontSize: 15 },
  weekTitle: { flex: 1, minWidth: 0, fontFamily: fonts.sans(550), fontSize: 14 },
  why: { fontFamily: fonts.sans(400), fontSize: 12.5, marginTop: 3 },
  weekMeta: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 3 },
  bgText: { fontFamily: fonts.sans(400), fontSize: 12.5 },
  failure: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 5 },
});
