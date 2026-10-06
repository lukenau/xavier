// Today's brief, as Home's door into the native screen.
//
// REWRITTEN, not extended (spec §11.1). This card used to open
// `/my-pages/<slug>/` in the WebView reader, because that was the only place
// the old page's dismiss/snooze form POSTs worked. That page dies at cutover
// (Ruling 33) and its buttons are the ones that "didn't really work", so the
// tap now pushes `/brief` — a native screen with native actions.
//
// The WebView reader stays alive for LEGACY briefs reached from Feed; nothing
// here uses it any more.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { Card, PRESSED_OPACITY } from '../shell';
import {
  bucketView,
  cardDateLine,
  degradedSources,
  isEmpty,
  staleServedLabel,
  type Brief,
} from '../brief/briefModel';

export interface BriefCardSummary {
  /** The day this brief is for, never content — 'Monday, Sep 22 · Daily
   * brief'. Ruling 145 (amended): no item's title appears on the card at all. */
  title: string;
  /** 'Now 1 · Today 18' — counts, never a 44-item total. */
  counts: string;
  /** Set when the card should read as a warning rather than as the day. */
  warning: string | null;
}

/**
 * What the card says. Pure so the four states — items to show, a clear day, a
 * degraded day, a brief that never landed — are testable without a renderer.
 */
export function briefSummary(brief: Brief | undefined): BriefCardSummary | null {
  if (!brief) return null;
  const stale = staleServedLabel(brief);
  // Source health is NOT the Home card's business (the user, 2026-09-22: "get rid
  // of the built without packages flag on the home screen. that's pretty much
  // incorrect and i don't want it showing there"). The card is a door: it says
  // which day, and how much is waiting. Which inputs answered belongs on the
  // brief screen's own banner, next to the items it affected. The one warning
  // that stays is the brief not having landed, which is about the card's own
  // subject rather than the machinery behind it.
  const degraded = degradedSources(brief);
  // served_date is what was actually served — a stale-served brief must name
  // the day it is FOR, not the device's today, or the title contradicts the
  // warning underneath it.
  const title = cardDateLine(brief.served_date ?? brief.date);

  if (isEmpty(brief)) {
    // An empty brief with a failed source is not a quiet day, and the card must
    // not imply one. A stale source still answered, so it does not get to
    // contradict "nothing for you".
    // An empty brief whose inputs were degraded is not a quiet day, so the
    // card withholds "Nothing for you today" rather than asserting calm it
    // cannot back. It still does not name the sources.
    return {
      title,
      counts: degraded.length > 0 ? '' : 'Nothing for you today',
      warning: stale,
    };
  }

  const now = bucketView(brief, 'now');
  const today = bucketView(brief, 'today');
  const counts = [
    now.length > 0 ? `Now ${now.length}` : null,
    today.length > 0 ? `Today ${today.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    title,
    counts: counts || `This week ${bucketView(brief, 'week').length}`,
    warning: stale,
  };
}

export function BriefCard() {
  const { t } = useTheme();
  // The same ['brief'] key the screen reads, so opening the screen is instant
  // and a dismissal there updates this card without a second request.
  const brief = usePoll(['brief'], () => api.brief(), QUERY_TUNING.brief);
  const summary = briefSummary(brief.data);

  return (
    <Card tone="strong" style={styles.card}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={
          summary ? `${summary.title}. ${summary.warning ?? summary.counts}` : 'Daily brief'
        }
        onPress={() => router.push('/brief')}
        style={({ pressed }) => [styles.primary, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <SymbolView name="book" size={18} tintColor={t('accent')} weight="regular" />
        <View style={styles.text}>
          <Text
            style={[styles.title, { color: t('fg-0') }]}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {summary?.title ?? 'Daily brief'}
          </Text>
          <Text
            accessibilityRole={summary?.warning ? 'alert' : undefined}
            style={[
              styles.subline,
              { color: summary?.warning ? t('status-warn') : t('fg-4') },
            ]}
          >
            {summary?.warning ?? summary?.counts ?? (brief.isError ? 'couldn’t read the brief' : 'reading…')}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={15} tintColor={t('fg-4')} weight="regular" />
      </Pressable>

      <Pressable
        accessibilityRole="link"
        onPress={() => router.push('/feed')}
        style={({ pressed }) => [
          styles.secondary,
          { borderTopColor: t('border') },
          pressed && { opacity: PRESSED_OPACITY },
        ]}
      >
        <Text style={[styles.secondaryText, { color: t('fg-4') }]}>all briefs &amp; runs in Feed →</Text>
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 13, marginBottom: 12 },
  primary: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(580), fontSize: 15 },
  subline: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 2 },
  secondary: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, alignItems: 'flex-end' },
  secondaryText: { fontFamily: fonts.mono(400), fontSize: 10 },
});
