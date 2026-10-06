// Xavier's pages, front and centre (PagesShelf.tsx:17-79): a horizontal shelf
// of everything he has published, newest first. Cards open the brief reader
// sheet — the native stand-in for the PWA's zero-privilege `<iframe sandbox="">`
// (Task 19's BriefWebView: JS off, locked to the hub origin).
//
// The scroller bleeds past the 18px page gutter with a negative margin, the
// same trick the PWA plays with `-mx-[18px] px-[18px]`.
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { MyPage } from '../../lib/types';
import { SCREEN_GUTTER, PRESSED_OPACITY } from '../shell';
import { openBrief, resolveBriefUri } from '../briefs';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { fmtWhen } from './homeState';

/** The shelf is a shelf, not an archive — Config → Pages holds the rest. */
export const SHELF_LIMIT = 10;
const CARD_WIDTH = 150;

export function PagesShelf({ pages }: { pages: MyPage[] | undefined }) {
  const { t } = useTheme();
  // A slug that will not resolve against the hub origin cannot be opened —
  // say so rather than letting the tap do nothing at all.
  const [unopenable, setUnopenable] = useState<string | null>(null);
  if (!pages || pages.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={[styles.eyebrow, { color: t('fg-3') }]}>Pages</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Manage pages"
          hitSlop={8}
          onPress={() => router.push('/config/pages')}
        >
          <Text style={[styles.manage, { color: t('fg-4') }]}>manage →</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroller}
        contentContainerStyle={styles.scrollerContent}
      >
        {pages.slice(0, SHELF_LIMIT).map((p) => (
          <Pressable
            key={p.slug}
            accessibilityRole="button"
            accessibilityLabel={p.title}
            onPress={() => {
              const uri = resolveBriefUri(`/my-pages/${p.slug}/`);
              if (uri) {
                setUnopenable(null);
                openBrief(uri, p.title);
              } else {
                setUnopenable(p.title);
              }
            }}
            style={({ pressed }) => [
              styles.card,
              { backgroundColor: t('bg-1'), borderColor: t('border') },
              pressed && { opacity: PRESSED_OPACITY },
            ]}
          >
            <View style={styles.cardHead}>
              <View
                style={[styles.dot, { backgroundColor: p.kind === 'brief' ? t('accent') : t('fg-4') }]}
              />
              <Text style={[styles.kind, { color: t('fg-4') }]}>
                {p.kind === 'brief' ? 'brief' : 'page'} · {fmtWhen(p.mtime)}
              </Text>
            </View>
            <Text
              style={[styles.title, { color: t('fg-1') }]}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {p.title}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {unopenable ? (
        <Text accessibilityRole="alert" style={[styles.unopenable, { color: t('status-warn') }]}>
          can’t open “{unopenable}” — that page isn’t on the hub
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 12 },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: 4,
  },
  eyebrow: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  manage: { fontFamily: fonts.mono(400), fontSize: 10 },
  scroller: { marginHorizontal: -SCREEN_GUTTER },
  scrollerContent: { paddingHorizontal: SCREEN_GUTTER, gap: 8, paddingBottom: 4 },
  card: { width: CARD_WIDTH, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  kind: { fontFamily: fonts.mono(400), fontSize: 9, letterSpacing: 0.72, textTransform: 'uppercase' },
  title: { fontFamily: fonts.sans(540), fontSize: 12.5, lineHeight: 16.25, marginTop: 5 },
  unopenable: { fontFamily: fonts.mono(400), fontSize: 10.5, paddingTop: 6, paddingHorizontal: 4 },
});
