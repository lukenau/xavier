// "Xavier is browsing" (BrowserCard.tsx:127-199) — a presence card that
// exists only while a Browserbase session is RUNNING, plus a fading entry
// point for two hours after one ends. Live = the vendor's own view; past = an
// itinerary of the pages visited, which is the phone-native replay.
//
// The PWA opens a bottom sheet from this row. Natively the detail expands in
// place: a sheet is a route here, and Home is not allowed to add one. It
// still carries the sheet's own header — eyebrow, title, and an explicit
// Close — because a second tap on the row was otherwise the only way back,
// where the PWA offered Close, a backdrop, Escape and a drag.
//
// The one piece still missing is the live view itself — `BrowserLiveView`
// (src/components/briefs) is the scripts-on WebView built for exactly this
// URL; dropping it in where the StatePanel sits below is the whole of the
// follow-up (it needs an https guard on `live_url` at the call site and an
// explicit height — see task-9-report.md).
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { BrowserSessionRecent } from '../../lib/types';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, StatePanel } from '../shell';
import { pulseScale, usePulseRing } from './pulse';
import { browserCardView, domainOf, pathOf, recentRowText } from './browserState';

/** The live dot's own pulse rate and size (BrowserCard.tsx:156-158). */
const LIVE_PULSE_MS = 1800;
const LIVE_DOT_SIZE = 7;

function Itinerary({ pages }: { pages: string[] }) {
  const { t } = useTheme();
  if (pages.length === 0) {
    return <Text style={[styles.empty, { color: t('fg-4') }]}>no page history captured</Text>;
  }
  return (
    <View>
      {pages.map((url, i) => (
        <View key={`${i}-${url}`} style={styles.trailRow}>
          <View
            style={[styles.trailDot, { backgroundColor: i === pages.length - 1 ? t('accent') : t('fg-4') }]}
          />
          <Text style={[styles.trailDomain, { color: t('fg-1') }]}>{domainOf(url)}</Text>
          <Text
            style={[styles.trailPath, { color: t('fg-4') }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {pathOf(url)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function RecentRow({ session, isLast }: { session: BrowserSessionRecent; isLast: boolean }) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { summary, meta } = recentRowText(session);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${summary} ${meta}`}
      onPress={() => setExpanded((e) => !e)}
      style={({ pressed }) => [
        styles.recentRow,
        !isLast && { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <View style={styles.recentHead}>
        <Text
          style={[styles.recentSummary, { color: t('fg-1') }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {summary}
        </Text>
        <Text style={[styles.recentMeta, { color: t('fg-4') }]}>{meta}</Text>
      </View>
      {expanded ? (
        <View style={styles.recentBody}>
          <Itinerary pages={session.pages} />
        </View>
      ) : null}
    </Pressable>
  );
}

export function BrowserCard() {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const q = usePoll(['browser-sessions'], api.browserSessions, QUERY_TUNING['browser-sessions']);
  const view = browserCardView(q.data);
  const pulse = usePulseRing(view?.live != null, LIVE_PULSE_MS);
  if (!view) return null;
  const { live, sheetTitle } = view;
  const past = q.data?.recent ?? [];

  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={view.title}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: live ? t('accent-soft') : t('bg-1'),
            borderColor: live ? t('accent-border') : t('border'),
          },
          pressed && { opacity: PRESSED_OPACITY },
        ]}
      >
        <View style={styles.iconSlot}>
          <SymbolView name="globe" size={16} tintColor={live ? t('accent') : t('fg-3')} weight="regular" />
          {live ? (
            <>
              <Animated.View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  styles.liveDot,
                  {
                    backgroundColor: t('status-up-glow'),
                    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                    transform: [
                      {
                        scale: pulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, pulseScale(LIVE_DOT_SIZE / 2)],
                        }),
                      },
                    ],
                  },
                ]}
              />
              <View style={[styles.liveDot, { backgroundColor: t('status-up') }]} />
            </>
          ) : null}
        </View>
        <View style={styles.text}>
          <Text
            style={[styles.title, { color: live ? t('accent') : t('fg-1') }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {view.title}
          </Text>
          <Text style={[styles.subline, { color: t('fg-4') }]}>{view.subline}</Text>
        </View>
      </Pressable>

      {open ? (
        <View style={[styles.panel, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
          <View style={styles.panelHead}>
            <View style={styles.panelHeadText}>
              <Text style={[styles.eyebrow, { color: t('fg-4') }]}>Browserbase</Text>
              <Text style={[styles.panelTitle, { color: t('fg-0') }]}>{sheetTitle}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setOpen(false)}
              style={({ pressed }) => [styles.close, pressed && { opacity: PRESSED_OPACITY }]}
            >
              <Text style={[styles.closeLabel, { color: t('accent') }]}>Close</Text>
            </Pressable>
          </View>
          {live?.live_url ? (
            <>
              {/* FOLLOW-UP: <BrowserLiveView uri={live.live_url} /> replaces
                  this panel once Task 19's WebView is wired in. */}
              <StatePanel
                tone="neutral"
                title="Live view isn’t in the app yet"
                detail="The session is running — open the Hub in a browser to watch it live."
              />
              {live.pages.length > 0 ? (
                <View style={styles.block}>
                  <Text style={[styles.eyebrow, { color: t('fg-4') }]}>trail</Text>
                  <Itinerary pages={live.pages} />
                </View>
              ) : null}
            </>
          ) : null}
          {past.length > 0 ? (
            <View style={styles.block}>
              <Text style={[styles.eyebrow, { color: t('fg-4') }]}>past sessions</Text>
              {past.map((r, i) => (
                <RecentRow key={r.id} session={r} isLast={i === past.length - 1} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  iconSlot: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  liveDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: LIVE_DOT_SIZE,
    height: LIVE_DOT_SIZE,
    borderRadius: LIVE_DOT_SIZE / 2,
  },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(580), fontSize: 13.5 },
  subline: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 1 },
  panel: { marginTop: 8, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  panelHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  panelHeadText: { flex: 1, minWidth: 0 },
  panelTitle: { fontFamily: fonts.sans(620), fontSize: 18 },
  // The PWA sheet's own Close: 14px accent text, 44pt hit area (Sheet.tsx:215).
  close: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  closeLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  block: { gap: 2 },
  eyebrow: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    paddingBottom: 3,
  },
  empty: { fontFamily: fonts.mono(400), fontSize: 10.5, paddingVertical: 4 },
  trailRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  trailDot: { width: 5, height: 5, borderRadius: 2.5 },
  trailDomain: { fontFamily: fonts.mono(400), fontSize: 11 },
  trailPath: { fontFamily: fonts.mono(400), fontSize: 10, flex: 1, minWidth: 0 },
  recentRow: { paddingVertical: 10, minHeight: 44 },
  recentHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  recentSummary: { fontFamily: fonts.mono(400), fontSize: 12, flex: 1, minWidth: 0 },
  recentMeta: { fontFamily: fonts.mono(400), fontSize: 10, ...MONO_FEATURES },
  recentBody: { marginTop: 6, paddingLeft: 2 },
});
