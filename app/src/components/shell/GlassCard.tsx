// Card with the iOS 26 Liquid Glass material behind it where the OS has one.
// isLiquidGlassAvailable() checks the system version, the compiler version and
// Info.plist's UIDesignRequiresCompatibility, so below iOS 26 (or with the
// compatibility opt-out set) this is the plain themed Card and nothing else.
//
// Never animate a GlassView's opacity to 0 — the effect stops rendering
// entirely (expo-glass-effect docs).
import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { GlassView, isLiquidGlassAvailable, type GlassStyle } from 'expo-glass-effect';
import { Card, CARD_PADDING_H, CARD_PADDING_V, CARD_RADIUS, type CardTone } from './Card';

export interface GlassCardProps {
  children: ReactNode;
  /** Used for the non-glass fallback only. */
  tone?: CardTone;
  glassEffectStyle?: GlassStyle;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function GlassCard({
  children,
  tone = 'default',
  glassEffectStyle = 'regular',
  style,
  testID,
}: GlassCardProps) {
  if (!isLiquidGlassAvailable()) {
    return (
      <Card tone={tone} style={style} testID={testID}>
        {children}
      </Card>
    );
  }
  return (
    <GlassView glassEffectStyle={glassEffectStyle} style={[styles.glass, style]} testID={testID}>
      {children}
    </GlassView>
  );
}

const styles = StyleSheet.create({
  glass: {
    borderRadius: CARD_RADIUS,
    paddingHorizontal: CARD_PADDING_H,
    paddingVertical: CARD_PADDING_V,
    overflow: 'hidden',
  },
});
