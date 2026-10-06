// The sticky section header. Label left, count right, nothing else — there is
// no total counter and no segmented filter anywhere on this screen: the buckets
// ARE the structure (spec §1.4, §8.4).
//
// Glass where iOS has it, a bg-0 fill where it does not. Never animate a
// GlassView's opacity — the effect stops rendering entirely (GlassCard.tsx) —
// so these heads change nothing on scroll; they simply stick.
import { StyleSheet, Text, View } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { SCREEN_GUTTER } from '../shell';
import { BUCKET_LABELS, type BriefBucket } from './briefModel';

// The answer cannot change within a process — hoisted so it isn't recomputed
// on every head, on every render (Minor 2).
const HAS_GLASS = isLiquidGlassAvailable();

/** The one place `accent` is spent in the list (spec §1.3 principle 2). */
export function BucketHead({ bucket, count }: { bucket: BriefBucket; count: number }) {
  const { t } = useTheme();
  const isNow = bucket === 'now';

  const content = (
    <View style={styles.row}>
      <Text
        accessibilityRole="header"
        maxFontSizeMultiplier={1.6}
        // A sighted reader gets "TODAY 18"; without this a VoiceOver user
        // only ever heard "TODAY" — the count Text below is hidden from
        // accessibility entirely (Minor 3).
        accessibilityLabel={count > 0 ? `${BUCKET_LABELS[bucket]}, ${count} items` : BUCKET_LABELS[bucket]}
        style={[styles.label, { color: t(isNow ? 'accent' : 'fg-3') }]}
      >
        {BUCKET_LABELS[bucket]}
      </Text>
      {count > 0 ? (
        <Text
          maxFontSizeMultiplier={1.6}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.count, { color: t('fg-4') }]}
        >
          {count}
        </Text>
      ) : null}
    </View>
  );

  // The accent rule above Now is the screen's only coloured line.
  const topRule = isNow ? { borderTopWidth: 1, borderTopColor: t('accent-border') } : null;
  const bottomRule = { borderBottomWidth: 1, borderBottomColor: t('border') };

  if (HAS_GLASS) {
    return (
      <GlassView glassEffectStyle="regular" style={[styles.glass, topRule, bottomRule]}>
        {content}
      </GlassView>
    );
  }
  // Without GlassView's material to separate a head from the rows scrolling
  // beneath it, bg-0 (the same colour as the page and the swipe-row faces)
  // left nothing marking the boundary — raise it and give it its own edge
  // (H15).
  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: t('surface-raised') },
        topRule ?? { borderTopWidth: 1, borderTopColor: t('border') },
        bottomRule,
      ]}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  glass: { overflow: 'hidden' },
  fill: {},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SCREEN_GUTTER,
    paddingTop: 16,
    paddingBottom: 8,
    // minHeight only — a fixed height would clip at AX5 (spec §10).
    minHeight: 34,
  },
  label: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  count: { fontFamily: fonts.mono(400), fontSize: 10, ...MONO_FEATURES },
});
