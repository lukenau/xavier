// The tone helper apps/hub keeps in this file, plus the detail-sheet component
// the PWA folded into shell/Sheet.tsx (DetailSheet.tsx:1-4).
//
// Why the component comes back here instead of reusing shell/SheetScreen:
// SheetScreen is a *route* — its Close button calls router.back(), and it is
// declared with sheetScreenOptions() on a stack. Task 11 may not add route
// files (src/lib/routeTree.test.ts pins the app/ tree against
// KNOWN_ROUTES, and src/lib/deepLinks.ts is another task's file), so the five
// Ops/System detail sheets are presented as UIKit page sheets from inside the
// screen instead. Everything else — the header row, SheetFields, SheetBody —
// is the shell's, so the two presentations look the same.
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PRESSED_OPACITY } from '../shell';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';

/** Map a hermes status/trust token to a tone color for dots + pills.
 *
 * Reproduced regex-for-regex from DetailSheet.tsx:6-15, including the
 * asymmetry: only the first pattern carries a trailing `\b`, so "failed"
 * matches the down pattern while "okay" does NOT match the up pattern and
 * falls through to the neutral default. Returns a token name rather than the
 * PWA's `var(--x)` string — callers resolve it with `t()`. */
export function statusToneColor(raw: string | null | undefined): TokenName {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'fg-4';
  if (/(enabled|active|ok|installed|ready|trusted|pass)\b/.test(s)) return 'status-up';
  if (/(warn|degraded|pending|partial)/.test(s)) return 'status-warn';
  if (/(error|fail|missing|untrusted|blocked|broken)/.test(s)) return 'status-down';
  if (/(disabled|inactive|off)/.test(s)) return 'fg-4';
  return 'fg-3';
}

export interface DetailSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  eyebrow?: string;
  /** 7px dot + mono label, both in `color` (a RESOLVED colour, not a token name). */
  status?: { label: string; color: string } | null;
  /** `false` when the body owns its own scrolling. Default `true`. */
  scroll?: boolean;
  children: ReactNode;
}

/**
 * A detail sheet: the PWA's Sheet header (eyebrow / title / status / Close)
 * over a padded body, presented as a UIKit page sheet.
 *
 * `allowSwipeDismissal` + `onRequestClose` give the swipe-down dismissal the
 * PWA hand-built with framer-motion (120px / 700px·s⁻¹ thresholds); the
 * grabber, the scrim and the spring are the system's.
 */
export function DetailSheet({
  visible,
  onClose,
  title,
  eyebrow,
  status,
  scroll = true,
  children,
}: DetailSheetProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const hasHeader = Boolean(title || eyebrow || status);

  const body = (
    <>
      {hasHeader && (
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            {eyebrow ? <Text style={[styles.eyebrow, { color: t('fg-4') }]}>{eyebrow}</Text> : null}
            {title ? (
              <Text accessibilityRole="header" style={[styles.title, { color: t('fg-0') }]}>
                {title}
              </Text>
            ) : null}
            {status ? (
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: status.color }]} />
                <Text style={[styles.statusLabel, { color: status.color }]}>{status.label}</Text>
              </View>
            ) : null}
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={({ pressed }) => [styles.close, pressed && { opacity: PRESSED_OPACITY }]}
          >
            <Text style={[styles.closeLabel, { color: t('accent') }]}>Close</Text>
          </Pressable>
        </View>
      )}
      {children}
    </>
  );

  // Sheet.tsx:178 `padding: 10px 16px calc(var(--safe-bottom) + 16px)`, minus
  // the grab-handle row the system grabber replaces.
  const padding = { paddingBottom: insets.bottom + 16 };

  return (
    <Modal
      visible={visible}
      onRequestClose={onClose}
      allowSwipeDismissal
      animationType="slide"
      presentationStyle="pageSheet"
      backdropColor={t('bg-1')}
    >
      {/* Sheet.tsx:173 — the sheet's own ground is --bg-1, not the page's. */}
      <View style={[styles.ground, { backgroundColor: t('bg-1') }]}>
        {scroll ? (
          <ScrollView contentContainerStyle={[styles.body, padding]}>{body}</ScrollView>
        ) : (
          <View style={[styles.body, styles.bodyFill, padding]}>{body}</View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1 },
  body: { paddingTop: 10, paddingHorizontal: 16 },
  bodyFill: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 4,
    paddingBottom: 12,
  },
  headerText: { flexShrink: 1, minWidth: 0 },
  eyebrow: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  title: { fontFamily: fonts.sans(620), fontSize: 18, letterSpacing: -0.36 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  statusLabel: { fontFamily: fonts.mono(400), fontSize: 11 },
  close: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  closeLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
});
