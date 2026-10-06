// The Feed's detail sheet for everything that is not a brief (Feed.tsx:200-227):
// the run's status line, its output in a mono block, and the card's link.
//
// Briefs do NOT come here. In the PWA both branches share one <Sheet>; here the
// brief branch is `openBrief()` → the `/sheet` route hosting BriefWebView
// (Task 19), because rendering agent HTML needs that component's whole trust
// boundary and its own screen. This one is a UIKit page sheet presented from
// inside the screen rather than a route, because this task may not add route
// files (src/lib/routeTree.test.ts pins app/ against KNOWN_ROUTES) — the same
// call the Ops/System detail sheets make.
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import type { FeedItem } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { externalFeedHref, runToneToken } from './feedModel';

export function FeedDetailSheet({ item, onClose }: { item: FeedItem | null; onClose: () => void }) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Feed.tsx:209's `max-h-[60dvh]` on the summary block.
  const summaryMaxHeight = height * 0.6;
  const href = externalFeedHref(item?.link);

  return (
    <Modal
      visible={item !== null}
      onRequestClose={onClose}
      allowSwipeDismissal
      animationType="slide"
      presentationStyle="pageSheet"
      backdropColor={t('bg-1')}
    >
      {/* Sheet.tsx:173 — a sheet's ground is --bg-1, not the page's --bg-0. */}
      <View style={[styles.ground, { backgroundColor: t('bg-1') }]}>
        <View style={styles.headerRow}>
          <Text accessibilityRole="header" style={[styles.title, { color: t('fg-0') }]}>
            {item?.title ?? ''}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={({ pressed }) => [styles.close, pressed && { opacity: PRESSED_OPACITY }]}
          >
            <Text style={[styles.closeLabel, { color: t('accent') }]}>Close</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 16 }]}>
          {item?.status ? (
            <Text style={[styles.status, { color: t(runToneToken(item.status)) }]}>
              {item.status}
            </Text>
          ) : null}

          {item?.summary ? (
            <ScrollView
              style={[
                styles.summary,
                { maxHeight: summaryMaxHeight, backgroundColor: t('bg-0'), borderColor: t('border') },
              ]}
              contentContainerStyle={styles.summaryContent}
              nestedScrollEnabled
            >
              <Text style={[styles.summaryText, { color: t('fg-1') }]}>{item.summary}</Text>
            </ScrollView>
          ) : null}

          {href ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="open link"
              // `target="_blank"` (Feed.tsx:216-224) left the PWA for the
              // browser; SFSafariViewController is that same separate context.
              onPress={() => WebBrowser.openBrowserAsync(href)}
              style={({ pressed }) => [styles.linkRow, pressed && { opacity: PRESSED_OPACITY }]}
            >
              <Text style={[styles.link, { color: t('accent') }]}>open link →</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  title: { flexShrink: 1, fontFamily: fonts.sans(620), fontSize: 18, letterSpacing: -0.36 },
  close: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  closeLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  body: { paddingHorizontal: 16, gap: 10 },
  status: { fontFamily: fonts.mono(400), fontSize: 12 },
  summary: { borderRadius: 10, borderWidth: 1 },
  summaryContent: { paddingHorizontal: 12, paddingVertical: 10 },
  summaryText: { fontFamily: fonts.mono(400), fontSize: 12, lineHeight: 18 },
  linkRow: { minHeight: 44, justifyContent: 'center' },
  link: { fontFamily: fonts.mono(400), fontSize: 12 },
});
