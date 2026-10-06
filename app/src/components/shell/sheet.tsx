// The PWA's bottom sheet (Sheet.tsx, SHELL-08/09) as an expo-router route.
//
// Everything the PWA hand-built — the scrim, the spring, the 120px/700px·s
// drag-to-dismiss thresholds, the ref-counted scroll lock, `inert` on <main>,
// the focus trap, Escape — is what UIKit's own sheet does, so none of it ports
// as code. What is left is the header row (eyebrow / title / status / Close),
// the two body primitives, and the screen options.
//
// Declare a sheet as a screen on the enclosing stack:
//
//   <Stack.Screen name="detail" options={sheetScreenOptions()} />
//
// and open it with `openSheet('/ops/detail')` (or a plain <Link>).
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, type Href, type NativeStackNavigationOptions } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from './Card';

/**
 * `maxHeight = '85dvh'` — Sheet.tsx:87's default. A single numeric detent
 * reproduces the PWA's fixed-height sheet; pass two (`[0.5, 0.85]`) for one
 * that should also open small.
 *
 * Numeric, never `'fitToContents'`: every fitToContents bug in the tracker is
 * closed-stale rather than closed-fixed (docs/research/native-chrome.md §2).
 */
export const SHEET_DETENTS: number[] = [0.85];

export interface SheetScreenOptions {
  detents?: number[];
  initialDetentIndex?: number | 'last';
  /** Which detent still leaves the content behind it tappable. Default: none — the PWA always scrims. */
  largestUndimmedDetentIndex?: number | 'none' | 'last';
}

/**
 * Screen options for a route presented as a native sheet.
 *
 * `contentStyle` is deliberately absent: expo-router ≥57.0.15 leaves a
 * transparent presentation's container unstyled so the iOS 26 sheet material
 * shows through, and setting any background paints over it (RESEARCH
 * correction 9). `sheetCornerRadius` is left unset for the same reason — iOS
 * 26 sheets carry a larger system radius than the PWA's 22px, and chrome is
 * native.
 */
export function sheetScreenOptions({
  detents = SHEET_DETENTS,
  initialDetentIndex = 0,
  largestUndimmedDetentIndex = 'none',
}: SheetScreenOptions = {}): NativeStackNavigationOptions {
  return {
    presentation: 'formSheet',
    headerShown: false,
    sheetAllowedDetents: detents,
    sheetInitialDetentIndex: initialDetentIndex,
    sheetGrabberVisible: true,
    sheetLargestUndimmedDetentIndex: largestUndimmedDetentIndex,
    sheetExpandsWhenScrolledToEdge: true,
  };
}

/** Push a sheet route. */
export function openSheet(href: Href): void {
  router.push(href);
}

/** Dismiss the sheet on top. Same thing the grabber and the backdrop do. */
export function closeSheet(): void {
  router.back();
}

export interface SheetScreenProps {
  children: ReactNode;
  title?: string;
  eyebrow?: string;
  /** 7px dot + mono label, both in `color` (a resolved colour, not a token name). */
  status?: { label: string; color: string } | null;
  /** `false` when the body owns its own scrolling. Default `true`. */
  scroll?: boolean;
}

/** Root of a sheet route's component: the PWA sheet header plus its padded body. */
export function SheetScreen({
  children,
  title,
  eyebrow,
  status,
  scroll = true,
}: SheetScreenProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const hasHeader = Boolean(title || eyebrow || status);
  const body = (
    <>
      {hasHeader && (
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            {eyebrow ? (
              <Text style={[styles.eyebrow, { color: t('fg-4') }]}>{eyebrow}</Text>
            ) : null}
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
            onPress={closeSheet}
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

  const padding = { paddingBottom: insets.bottom + 16 };
  // flex:1 only in non-scroll mode: a `scroll={false}` body exists so a
  // caller can own full-bleed content that fills the sheet (Task 19's
  // BriefWebView, `flex:1` inside), which needs a bounded-height ancestor to
  // flex into — the scrolling branch below is intentionally NOT flexed, since
  // a ScrollView's content container sizing to its content is the whole
  // point of scrolling.
  if (!scroll) return <View style={[styles.body, styles.bodyFill, padding]}>{body}</View>;
  return (
    <ScrollView contentContainerStyle={[styles.body, padding]}>{body}</ScrollView>
  );
}

export interface SheetField {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}

/** Key/value rows for read-only detail sheets. Rows with empty values are dropped. */
export function SheetFields({ fields }: { fields: SheetField[] }) {
  const { t } = useTheme();
  const shown = fields.filter((f) => f.value != null && f.value !== '');
  if (shown.length === 0) return null;
  return (
    <View style={[styles.fields, { backgroundColor: t('bg-0'), borderColor: t('border') }]}>
      {shown.map((f, i) => (
        <View
          key={f.label}
          style={[
            styles.fieldRow,
            i === shown.length - 1
              ? null
              : { borderBottomWidth: 1, borderBottomColor: t('border') },
          ]}
        >
          <Text style={[styles.fieldLabel, { color: t('fg-4') }]}>{f.label}</Text>
          <Text
            style={[
              styles.fieldValue,
              f.mono ? styles.fieldValueMono : null,
              { color: t('fg-1') },
            ]}
          >
            {f.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Labelled free-text block (description / command) under SheetFields. */
export function SheetBody({ label, children }: { label?: string; children: ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={styles.sheetBody}>
      {label ? <Text style={[styles.sheetBodyLabel, { color: t('fg-4') }]}>{label}</Text> : null}
      <View
        style={[styles.sheetBodyBox, { backgroundColor: t('bg-0'), borderColor: t('border') }]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Sheet.tsx:178 `padding: 10px 16px calc(var(--safe-bottom) + 16px)`, minus
  // the grab-handle row the native grabber replaces.
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
  close: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center', alignItems: 'flex-end' },
  closeLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  fields: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 4, borderWidth: 1 },
  fieldRow: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingVertical: 10 },
  fieldLabel: { width: 86, flexShrink: 0, fontFamily: fonts.sans(400), fontSize: 12 },
  fieldValue: { flex: 1, minWidth: 0, textAlign: 'right', fontFamily: fonts.sans(400), fontSize: 13 },
  fieldValueMono: { fontFamily: fonts.mono(400), fontSize: 11.5 },
  sheetBody: { marginTop: 12 },
  sheetBodyLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 7,
    paddingHorizontal: 4,
  },
  sheetBodyBox: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1 },
});
