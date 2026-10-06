// 1:1 port of apps/hub/src/routes/config/PagesPage.tsx — the raw index of
// everything Xavier has dropped under `sites/my-pages/<slug>/index.html`.
// Daily briefs also surface in the Feed; this page is the whole shelf.
//
// The PWA row is `<a target="_blank">`, which in a standalone PWA leaves the
// app for Safari. Natively the same content opens in the brief reader sheet
// (Task 19's BriefWebView: `javaScriptEnabled={false}`, incognito, no bridge,
// behind the server's `CSP: sandbox; script-src 'none'`) — the same surface
// the Feed uses for the same HTML, rather than handing agent-written markup
// to a full browser. `resolveBriefUri` is the gate: it requires the hub
// origin, so a row can only ever open a hub page.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PageTitle, PRESSED_OPACITY, RefreshControl, Screen, useHideTabBar } from '../shell';
import { openBrief, resolveBriefUri } from '../briefs';
import { api, HUB_ORIGIN } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { MyPage } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { BackLink, ConfigCard, ExternalArrow } from './parts';
import { pageHref, pageSub } from './pages';

function PageRow({ page, isLast }: { page: MyPage; isLast: boolean }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => {
        const uri = resolveBriefUri(`${HUB_ORIGIN}${pageHref(page.slug)}`);
        if (uri) openBrief(uri, page.title);
      }}
      accessibilityRole="link"
      style={({ pressed }) => [
        styles.row,
        isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.title, { color: t('fg-0') }]}>
          {page.title}
        </Text>
        <Text numberOfLines={1} style={[styles.sub, { color: t('fg-3') }]}>
          {pageSub(page)}
        </Text>
      </View>
      <ExternalArrow />
    </Pressable>
  );
}

export function PagesPage() {
  useHideTabBar();
  const { t } = useTheme();
  const pagesQuery = usePoll(['my-pages'], api.myPages, QUERY_TUNING['my-pages-page']);
  // No loading or error panel, by parity (inventory §13.6): a failed
  // /api/my-pages looks exactly like "no pages yet".
  const pages = pagesQuery.data?.pages ?? [];

  return (
    <Screen
      header={
        <>
          <BackLink />
          <PageTitle right={<RefreshControl queries={pagesQuery} />}>Pages</PageTitle>
        </>
      }
    >
      {pages.length === 0 ? (
        <ConfigCard style={styles.emptyCard}>
          <Text style={[styles.empty, { color: t('fg-3') }]}>
            No hosted pages yet. Xavier drops an <Text style={styles.emptyMono}>index.html</Text> under{' '}
            <Text style={styles.emptyMono}>sites/my-pages/&lt;slug&gt;</Text> and it appears here.
          </Text>
        </ConfigCard>
      ) : (
        <View style={styles.list}>
          {pages.map((p, i) => (
            <PageRow key={p.slug} page={p} isLast={i === pages.length - 1} />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flexDirection: 'column', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14 },
  rowText: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(550), fontSize: 15 },
  sub: { fontFamily: fonts.mono(400), fontSize: 11 },
  emptyCard: { paddingVertical: 16, marginBottom: 8 },
  empty: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18.75 },
  emptyMono: { fontFamily: fonts.mono(400), fontSize: 12.5 },
});
