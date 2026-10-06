// Shared chrome for the Config menu and its section pages — the native twin
// of apps/hub/src/routes/config/parts.tsx plus the one piece of page furniture
// every config page also imports: the fixed-position action bar the PWA
// re-implements four times.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, SCREEN_TAB_BAR_CLEARANCE } from '../shell';

/** parts.tsx:8-14 — the 16px row chevron. */
export function ChevronRight({ size = 16 }: { size?: number } = {}) {
  const { t } = useTheme();
  return <SymbolView name="chevron.right" size={size} tintColor={t('fg-3')} weight="semibold" />;
}

/** parts.tsx:16-23 — arrow-up-right, the "leaves the app" glyph. */
export function ExternalArrow() {
  const { t } = useTheme();
  return <SymbolView name="arrow.up.right" size={16} tintColor={t('fg-3')} weight="semibold" />;
}

/**
 * parts.tsx:26-38's "‹ Config" back-link, at the top of every config sub-page.
 *
 * `dismissTo` rather than `back()`: the PWA link is `href="/config"`, and a
 * SummaryLinkRow can push /config/g/misc on top of another group page, so
 * "back" and "Config" are not the same screen. dismissTo pops the stack to
 * /config when it is below, and replaces when it somehow is not.
 */
export function BackLink() {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.dismissTo('/config')}
      accessibilityRole="button"
      accessibilityLabel="Config"
      style={({ pressed }) => [styles.backLink, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <SymbolView name="chevron.left" size={15} tintColor={t('accent')} weight="semibold" />
      <Text style={[styles.backLinkLabel, { color: t('accent') }]}>Config</Text>
    </Pressable>
  );
}

/** Config's own way back, now that it is reached from Home rather than a tab. */
export function HomeLink() {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.dismissTo('/')}
      accessibilityRole="button"
      accessibilityLabel="Home"
      style={({ pressed }) => [styles.backLink, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <SymbolView name="chevron.left" size={15} tintColor={t('accent')} weight="semibold" />
      <Text style={[styles.backLinkLabel, { color: t('accent') }]}>Home</Text>
    </Pressable>
  );
}

/** Padlock — the Terminal Face-ID lock glyph (ConfigSectionPage.tsx:292-310).
 * Editable rows tint it accent (tappable); read-only sensitive rows keep the
 * muted glyph. */
export function FaceIdLock({ active = false }: { active?: boolean } = {}) {
  const { t } = useTheme();
  return (
    <SymbolView
      name="lock"
      size={13}
      tintColor={active ? t('accent') : t('fg-4')}
      weight="medium"
      accessibilityLabel={active ? 'Tap to edit with Face ID' : 'Read-only'}
    />
  );
}

/** The 14-radius `--bg-1` panel the config pages group rows into. Padding is
 * per call site: 16/14 (System, Advisor, Memory) or 16/4 (Connectors, whose
 * rows carry their own vertical padding). */
export function ConfigCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }, style]}>{children}</View>
  );
}

/** A row's 1px bottom rule, dropped on the last row (every list in this tree). */
export function useRowBorder(isLast: boolean): ViewStyle {
  const { t } = useTheme();
  return isLast ? {} : { borderBottomWidth: 1, borderBottomColor: t('border') };
}

// ── The fixed bottom action bar ─────────────────────────────────────────────
// ReviewBar (ConfigSectionPage.tsx:632-692), ConfirmBar + SwitchingBar
// (AdvisorPage.tsx:197-282) and SaveBar (RoutingPage.tsx:156-212) are the same
// box with different contents: centred, max 420 wide, 18px gutter, floating
// `calc(var(--safe-bottom) + 86px + 12px)` above the bottom edge.
//
// The 86px in that formula is tab-bar clearance, and on a pushed native screen
// the tab bar is hidden (task-8 report, "paddingBottom on pushed routes"), so
// the bar sits at `insets.bottom + 12` instead.

export const ACTION_BAR_MAX_WIDTH = 420;
export const ACTION_BAR_GAP = 12;

/**
 * What a screen must add to its own bottom padding while a bar is up, so the
 * last row is still reachable above it. The PWA got this for free from
 * `<main>`'s `safe-bottom + 92` tab clearance; `Screen` drops that to 16 on a
 * pushed route, so the clearance is re-applied here — the same 92px, for the
 * bar that replaced the tab bar it was measured against.
 */
export function useActionBarClearance(active: boolean): ViewStyle | undefined {
  const insets = useSafeAreaInsets();
  return active ? { paddingBottom: insets.bottom + SCREEN_TAB_BAR_CLEARANCE } : undefined;
}

export function ActionBar({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'accent' }) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.barAnchor, { bottom: insets.bottom + ACTION_BAR_GAP }]}>
      <View
        style={[
          styles.bar,
          {
            backgroundColor: t('bg-2'),
            borderColor: tone === 'accent' ? t('accent-border') : t('border-strong'),
            boxShadow: t('shadow-pop'),
          },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

/** The bar's "Cancel" text button (disabled, dimmed, while applying). */
export function BarCancel({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.barCancel, pressed && !disabled && { opacity: PRESSED_OPACITY }]}
    >
      <Text style={[styles.barCancelLabel, { color: t('fg-3'), opacity: disabled ? 0.5 : 1 }]}>Cancel</Text>
    </Pressable>
  );
}

/** The bar's padlock + label primary button. */
export function GateButton({ label, busy, onPress }: { label: string; busy: boolean; onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      style={({ pressed }) => [
        styles.gateButton,
        { backgroundColor: t('accent-soft'), borderColor: t('accent-border'), opacity: busy ? 0.65 : 1 },
        pressed && !busy && { opacity: PRESSED_OPACITY },
      ]}
    >
      <SymbolView name="lock" size={15} tintColor={t('accent')} weight="medium" />
      <Text style={[styles.gateButtonLabel, { color: t('accent') }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 3, marginBottom: 10, alignSelf: 'flex-start' },
  backLinkLabel: { fontFamily: fonts.sans(500), fontSize: 13 },
  card: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1 },
  barAnchor: { position: 'absolute', left: 0, right: 0, zIndex: 20, alignItems: 'center', paddingHorizontal: 18 },
  bar: {
    width: '100%',
    maxWidth: ACTION_BAR_MAX_WIDTH,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  barCancel: { flexShrink: 0, minHeight: 44, justifyContent: 'center', paddingLeft: 8 },
  barCancelLabel: { fontFamily: fonts.sans(400), fontSize: 12 },
  gateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 11,
  },
  gateButtonLabel: { fontFamily: fonts.sans(600), fontSize: 13.5 },
});
