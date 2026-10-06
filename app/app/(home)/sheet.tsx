// The brief reader: a native form sheet hosting BriefWebView (Task 19).
// Opened via `openBrief(uri, title)` (src/components/briefs/openBrief.ts) —
// Feed and PagesShelf (their own tasks) both tap into a brief/page and call
// that helper rather than pushing this route by hand.
//
// A static route, not `/sheet/[id]`: the brief's own URL is passed as a
// search param (`uri`) instead of a dynamic path segment. KNOWN_ROUTES /
// +native-intent only need to arbitrate in-app pushes vs external deep
// links, and nothing outside this app yet needs to deep-link to a specific
// brief (no push-notification consumer exists), so there's nothing to gain
// from teaching deepLinks.ts's route matching about `[id]` wildcards today —
// see task-19-report.md for the full scoping note.
//
// SECURITY: `uri` is an untrusted route param — this screen must never hand
// it to BriefWebView unvalidated, regardless of how it got here. Two
// independent reasons it's still treated as attacker-controlled even though
// `/sheet` is deliberately kept out of `KNOWN_ROUTES`
// (`src/lib/deepLinks.ts`'s `INTERNAL_ONLY_ROUTES`, so an external
// `hub://sheet?uri=https://attacker.example/…` deep link resolves to Home
// instead of here): (1) that's one door, not a proof the param is safe —
// `resolveBriefUri` is the actual gate; (2) `title` is rendered verbatim as
// the sheet's title text (SheetScreen → RN <Text>, never interpolated into
// markup — safe today, but do not "helpfully" start treating it as HTML
// later without re-deriving that it's still attacker-controlled).
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { BriefWebView } from '../../src/components/briefs/BriefWebView';
import { resolveBriefUri } from '../../src/components/briefs/webViewPolicy';
import { SheetScreen, StatePanel } from '../../src/components/shell';

export default function BriefSheetScreen() {
  const { uri, title } = useLocalSearchParams<{ uri?: string; title?: string }>();
  // BriefWebView is expensive to remount (a fresh network load), and the
  // sheet's params never change under it once opened — resolve+freeze on
  // the first render so an unrelated re-render of this screen can't reload
  // (or re-validate away) the page underneath it.
  const resolvedUri = useRef(resolveBriefUri(uri ?? null)).current;

  return (
    <SheetScreen title={title || 'Page'} scroll={false}>
      {resolvedUri ? (
        <View style={styles.fill}>
          <BriefWebView uri={resolvedUri} />
        </View>
      ) : (
        <StatePanel
          tone="error"
          title="Nothing to show"
          detail={uri ? 'That link can’t be opened here.' : 'No page URL was provided.'}
        />
      )}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
