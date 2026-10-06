// 1:1 port of apps/hub/src/components/home/SectionHead.tsx (26 call sites).
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

/** `font-mono text-[10px] uppercase tracking-[0.14em]` — the card-eyebrow voice. */
export const EYEBROW_FONT_SIZE = 10;
/** RN letterSpacing is points, not em: 10px × 0.14em. */
export const EYEBROW_LETTER_SPACING = EYEBROW_FONT_SIZE * 0.14;

/**
 * The type the PWA's header row *inherits* onto everything inside it, action
 * slot included (`SectionHead.tsx:9` — the span carries font-mono, uppercase
 * and the tracking; the pill actions override only `font-size`).
 *
 * RN has no text inheritance across a View, so a non-string `action` must
 * spread this into its own `<Text>` to match:
 *
 *   <Pressable onPress={…}>
 *     <Text style={[SECTION_HEAD_TEXT_STYLE, { fontSize: 12, color: t('fg-1') }]}>B2 console</Text>
 *   </Pressable>
 *
 * A string `action` gets it applied for free.
 */
export const SECTION_HEAD_TEXT_STYLE: TextStyle = {
  fontFamily: fonts.mono(400),
  fontSize: EYEBROW_FONT_SIZE,
  letterSpacing: EYEBROW_LETTER_SPACING,
  textTransform: 'uppercase',
};

export interface SectionHeadProps {
  label: string;
  count?: string;
  /** A string is styled like `count`; an element supplies its own text styles. */
  action?: ReactNode;
}

export function SectionHead({ label, count, action }: SectionHeadProps) {
  const { t } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: t('fg-3') }]}>{label}</Text>
      <View style={styles.right}>
        {count ? <Text style={[styles.label, { color: t('fg-4') }]}>{count}</Text> : null}
        {typeof action === 'string' || typeof action === 'number' ? (
          <Text style={[styles.label, { color: t('fg-4') }]}>{action}</Text>
        ) : (
          action
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // pt-2 pb-3 px-1
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 12,
    paddingHorizontal: 4,
  },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: SECTION_HEAD_TEXT_STYLE,
});
