// The chip row, and the leading split rule both row densities share.
//
// A chip means "unusual" — carried and conflict only. Source and origin are
// text, not pills; a stale source is the banner's job. If every row had chips,
// chips would mean nothing (spec §1.3 principle 3).
import { StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { Chip } from './briefModel';

export function ChipRow({ chips }: { chips: Chip[] }) {
  const { t } = useTheme();
  if (chips.length === 0) return null;
  return (
    <View style={styles.row}>
      {chips.map((chip) => (
        <Text
          key={chip.label}
          maxFontSizeMultiplier={1.6}
          style={[
            styles.chip,
            {
              color: t(chip.tone === 'warn' ? 'status-warn' : 'fg-4'),
              borderColor: t(chip.tone === 'warn' ? 'status-warn-soft' : 'border'),
            },
          ]}
        >
          {chip.label}
        </Text>
      ))}
    </View>
  );
}

/** 3px of colour at x=0 — the cheapest possible encoding of a true binary.
 * No chip, no label, no extra object (spec §5.2). */
export function SplitRule({ split }: { split: string }) {
  const { t } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.split, { backgroundColor: t(split === 'personal' ? 'accent-deep' : 'petrol') }]}
    />
  );
}

export const SPLIT_RULE_WIDTH = 3;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 5 },
  chip: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 0.2,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  split: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: SPLIT_RULE_WIDTH,
  },
});
