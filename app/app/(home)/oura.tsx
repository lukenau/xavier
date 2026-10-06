// Full-screen push hosting TrustedPageView on `/oura/` — the one trusted,
// non-sandboxed first-party static page (docs/inventory/assets.md §9). Home's
// OuraRow (Task 9, not yet built) should `router.push('/oura')` for the tap
// that in the PWA is a plain `<a href="/oura/">` leaving the SPA.
//
// The page's own in-page "hubback" link (href="/") is same-origin, so under
// TrustedPageView's policy it navigates the WebView to the hub root rather
// than popping this native screen — see task-19-report.md's device
// checklist. The chevron below is this screen's own back affordance so a tap
// on the sticky topnav's chevron (whichever `href="/"` link the ring taps)
// isn't the only way out; the edge-swipe gesture also pops as normal.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HUB_ORIGIN } from '../../src/lib/api';
import { TrustedPageView } from '../../src/components/briefs/TrustedPageView';
import { PRESSED_OPACITY, useHideTabBar } from '../../src/components/shell';
import { useTheme } from '../../src/theme/useTheme';
import { fonts } from '../../src/theme/fonts';

export default function OuraScreen() {
  useHideTabBar();
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  // tailscale serve sends no Cache-Control, so WKWebView heuristically reuses an old
  // copy of this page (regenerated after every ring sync) for up to ~10% of its age.
  // A per-open query string keys a fresh cache entry; the page ignores it.
  const [uri] = useState(() => `${HUB_ORIGIN}/oura/?v=${Date.now()}`);

  return (
    <View style={[styles.root, { backgroundColor: t('bg-0') }]}>
      <View style={[styles.chrome, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.back, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.backLabel, { color: t('accent') }]}>‹ Back</Text>
        </Pressable>
      </View>
      <TrustedPageView uri={uri} style={styles.fill} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chrome: { paddingHorizontal: 12, paddingBottom: 6 },
  back: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 4 },
  backLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  fill: { flex: 1 },
});
