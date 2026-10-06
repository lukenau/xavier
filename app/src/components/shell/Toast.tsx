// The PWA's transient write-result toast. Four copies exist in apps/hub with
// two distinct styles (PARITY-INVENTORY OQ-18); both are reproduced rather
// than normalized, selected by `variant`:
//
//   variant      timings (ok/err)  ok text/border            err text/border
//   'decision'   3600 / 6000 ms    --status-up/--accent-border  --status-warn/--status-warn-soft
//   'config'     3200 / 5000 ms    --ok/--accent-border         --danger/--status-down-border-strong
//
// 'decision' is DecisionCards.tsx:49-73 (also copied verbatim into
// RoutingPage.tsx:214 and AdvisorPage.tsx:284); 'config' is
// ConfigSectionPage.tsx:694-718, the drifted one.
//
// Render it as a SIBLING of <Screen> inside a fragment — it is the PWA's
// `position: fixed` z-30 overlay, so it must not live inside the scroll view.
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';
import { haptic, Monogram, useWhimsy } from '../../whimsy';

export type ToastKind = 'ok' | 'err';
export type ToastVariant = 'decision' | 'config';

/** `color` and `border` are token NAMES — resolve them with `t()`, unlike
 * SheetScreen's `status.color`, which is already a resolved colour. */
export interface ToastStyleSpec {
  durationMs: number;
  color: TokenName;
  border: TokenName;
}

export const TOAST_VARIANTS: Record<ToastVariant, Record<ToastKind, ToastStyleSpec>> = {
  decision: {
    ok: { durationMs: 3600, color: 'status-up', border: 'accent-border' },
    err: { durationMs: 6000, color: 'status-warn', border: 'status-warn-soft' },
  },
  config: {
    ok: { durationMs: 3200, color: 'ok', border: 'accent-border' },
    err: { durationMs: 5000, color: 'danger', border: 'status-down-border-strong' },
  },
};

/** `calc(var(--safe-top, 0px) + 14px)` (DecisionCards.tsx:56). */
export const TOAST_TOP_OFFSET = 14;
/** `max-w-[420px] px-[18px]`. */
export const TOAST_MAX_WIDTH = 420;

export interface ToastProps {
  kind: ToastKind;
  text: string;
  onDone: () => void;
  variant?: ToastVariant;
}

export function Toast({ kind, text, onDone, variant = 'decision' }: ToastProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const spec = TOAST_VARIANTS[variant][kind];

  const { level } = useWhimsy();
  useEffect(() => {
    haptic(kind === 'ok' ? 'success' : 'error');
  }, [kind, text]);

  useEffect(() => {
    const timer = setTimeout(onDone, spec.durationMs);
    return () => clearTimeout(timer);
  }, [kind, text, onDone, spec.durationMs]);

  const color = t(spec.color);
  return (
    <View
      accessibilityRole="alert"
      pointerEvents="none"
      style={[styles.anchor, { top: insets.top + TOAST_TOP_OFFSET }]}
    >
      <View
        style={[
          styles.toast,
          { backgroundColor: t('bg-2'), borderColor: t(spec.border), boxShadow: t('shadow-menu') },
        ]}
      >
        {kind === 'ok' && level !== 'off' ? (
          <Monogram size={20} />
        ) : (
          <SymbolView
            name={kind === 'ok' ? 'checkmark' : 'exclamationmark.circle'}
            size={16}
            tintColor={color}
            weight="semibold"
          />
        )}
        <Text style={[styles.text, { color }]}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 30,
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  toast: {
    width: '100%',
    maxWidth: TOAST_MAX_WIDTH,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  text: { flex: 1, minWidth: 0, fontFamily: fonts.sans(400), fontSize: 13 },
});
