// Renders agent-written HTML (`/my-pages/<slug>/` briefs and ad-hoc pages)
// under the same trust boundary the PWA's `<iframe sandbox="">` enforces
// (apps/hub/docs/HERMES-WRITE-CONTRACT.md, docs/research/briefs.md §3-4):
// agent HTML built from untrusted email/calendar content must never run
// script with the hub's credentials. Here that boundary is layered, each
// independently sufficient:
//   1. the server's own `CSP: sandbox; script-src 'none'` on every
//      `/my-pages/*` response — engine-enforced, unaffected by this file.
//   2. `javaScriptEnabled={false}` — engine-level `allowsContentJavaScript`.
//   3. `incognito` — no persisted cookies/storage for this WebView.
//   4. no `onMessage` / no injected JS — there is no bridge for a brief to
//      call back into the app through.
//   5. `onShouldStartLoadWithRequest` — `decideBriefNavigation` below is the
//      only thing that decides what may load in-frame at all.
// UNVERIFIED ON DEVICE: whether WKWebView actually enforces the header CSP
// sandbox, and whether `javaScriptEnabled=false` behaves as documented on
// this react-native-webview version — see task-19-report.md's device
// checklist. Layers 2-5 hold even if either is wrong.
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import WebView from 'react-native-webview';
import { useTheme } from '../../theme/useTheme';
import { StatePanel } from '../shell';
import { decideBriefNavigation } from './webViewPolicy';

export interface BriefWebViewProps {
  /** Absolute https(s) URL on the hub host — resolve with `resolveBriefUri`
   * first; this component does not re-validate the scheme. */
  uri: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BriefWebView({ uri, style, testID }: BriefWebViewProps) {
  const { t } = useTheme();
  const ref = useRef<WebView>(null);
  const [error, setError] = useState<string | null>(null);

  const onShouldStartLoadWithRequest = useCallback((req: { url: string }) => {
    const decision = decideBriefNavigation(req.url);
    if (decision === 'external') {
      WebBrowser.openBrowserAsync(req.url);
      return false;
    }
    return decision === 'allow';
  }, []);

  if (error) {
    return <StatePanel tone="error" title="Page unavailable" detail={error} />;
  }

  return (
    <View
      style={[styles.container, { backgroundColor: t('page-white') }, style]}
      testID={testID}
    >
      <WebView
        ref={ref}
        source={{ uri }}
        javaScriptEnabled={false}
        incognito
        startInLoadingState
        renderLoading={() => <StatePanel tone="pending" title="Loading…" />}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onContentProcessDidTerminate={() => ref.current?.reload()}
        onError={(e) => setError(e.nativeEvent.description)}
        onHttpError={(e) => setError(`${e.nativeEvent.url} → ${e.nativeEvent.statusCode}`)}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, borderRadius: 10, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: 'transparent' },
});
