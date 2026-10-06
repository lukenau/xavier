// The PWA card idiom: radius 16, `--bg-1` ground, 1px border, 18/14 padding
// (PositionsCard.tsx:65-67 and its 6 siblings — the most common of the four
// paddings in use; Home's 16/13 cards pass their own).
//
// Background and border, and nothing else: no PWA card carries a shadow.
// `--shadow-card` is declared in tokens.css (193/391/540) and consumed
// nowhere, so applying it here would give every card a shadow in light mode
// that the PWA does not have.
import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { haptic, useWhimsy } from '../../whimsy';

export const CARD_RADIUS = 16;
export const CARD_PADDING_H = 18;
export const CARD_PADDING_V = 14;
/** `active:opacity-80` — the app's only press feedback (THEME-08). */
export const PRESSED_OPACITY = 0.8;
const PRESSED_GIVE: ViewStyle = { transform: [{ scale: 0.985 }] };

/**
 * `default` = `--border` (most cards); `strong` = `--border-strong` (BriefCard,
 * XavierCard); `accent` = the `--accent-soft`/`--accent-border` call-to-action
 * card (Home.tsx:119-122).
 */
export type CardTone = 'default' | 'strong' | 'accent';

export interface CardProps {
  children: ReactNode;
  tone?: CardTone;
  /** Present ⇒ the card is a link/button and dims to 0.8 while pressed. */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

export function Card({
  children,
  tone = 'default',
  onPress,
  style,
  accessibilityLabel,
  testID,
}: CardProps) {
  const { t } = useTheme();
  const { level } = useWhimsy();
  const base: ViewStyle = {
    borderRadius: CARD_RADIUS,
    paddingHorizontal: CARD_PADDING_H,
    paddingVertical: CARD_PADDING_V,
    borderWidth: 1,
    backgroundColor: tone === 'accent' ? t('accent-soft') : t('bg-1'),
    borderColor:
      tone === 'accent' ? t('accent-border') : tone === 'strong' ? t('border-strong') : t('border'),
  };

  if (!onPress) {
    return (
      <View style={[base, style]} accessibilityLabel={accessibilityLabel} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => {
        haptic('tap');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={({ pressed }) => [
        base,
        style,
        pressed && { opacity: PRESSED_OPACITY },
        // Native-only whimsy: the card gives a little under the thumb.
        pressed && level !== 'off' && PRESSED_GIVE,
      ]}
    >
      {children}
    </Pressable>
  );
}
