// The terminal's own bottom sheet.
//
// The shell's SheetScreen is a ROUTE (a native formSheet pushed on the
// enclosing stack). The unlocked terminal is a full-bleed overlay that owns
// the whole screen — pushing a route under it would tear the overlay down —
// so these two sheets are plain modals presented in place, styled after the
// PWA's Sheet (apps/hub/src/components/shell/Sheet.tsx): grabber, eyebrow,
// title, Close, tap-the-backdrop-to-dismiss, 85% max height.
//
// DEVIATION, recorded: the PWA's sheet can also be dragged down to dismiss.
// This one cannot — the grabber is an affordance, not a handle. Backdrop tap,
// Close, and the hardware/Android back gesture all dismiss.
import type { ReactNode } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PRESSED_OPACITY, useReducedMotion } from '../components/shell';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';

export const SHEET_MAX_HEIGHT_FRACTION = 0.85;
export const SHEET_MAX_WIDTH = 440;
export const SHEET_RADIUS = 22;

export interface TerminalSheetProps {
  open: boolean;
  onClose: () => void;
  /** After the dismissal ANIMATION completes (iOS `Modal.onDismiss`). A
   * `focus()` requested while a modal is still presenting is routinely dropped
   * by UIKit, so anything that wants the keyboard has to wait for this. */
  onDismissed?: () => void;
  eyebrow: string;
  title: string;
  children: ReactNode;
}

export function TerminalSheet({
  open,
  onClose,
  onDismissed,
  eyebrow,
  title,
  children,
}: TerminalSheetProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();

  return (
    <Modal
      visible={open}
      transparent
      animationType={reduced ? 'none' : 'slide'}
      onRequestClose={onClose}
      onDismiss={onDismissed}
      statusBarTranslucent
    >
      <Pressable
        accessibilityLabel="Dismiss"
        accessibilityRole="button"
        onPress={onClose}
        style={[styles.backdrop, { backgroundColor: t('scrim') }]}
      />
      <View style={styles.dock} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: t('bg-1'),
              borderTopColor: t('border-strong'),
              maxHeight: height * SHEET_MAX_HEIGHT_FRACTION,
              paddingBottom: insets.bottom + 16,
            },
          ]}
        >
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: t('border-strong') }]} />
          </View>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.eyebrow, { color: t('fg-4') }]}>{eyebrow.toUpperCase()}</Text>
              <Text style={[styles.title, { color: t('fg-0') }]}>{title}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed && { opacity: PRESSED_OPACITY }]}
            >
              <Text style={[styles.closeLabel, { color: t('accent') }]}>Close</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  dock: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    alignSelf: 'center',
    borderTopWidth: 1,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  grabberRow: { alignItems: 'center', paddingVertical: 6, marginTop: -6, marginBottom: 8 },
  grabber: { width: 36, height: 4, borderRadius: 2 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 4, paddingBottom: 12 },
  headerText: { flex: 1, minWidth: 0 },
  eyebrow: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 1.2, marginBottom: 3 },
  title: { fontFamily: fonts.sans(620), fontSize: 18, letterSpacing: -0.36 },
  close: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: 8, marginRight: -8, marginVertical: -6 },
  closeLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
});
