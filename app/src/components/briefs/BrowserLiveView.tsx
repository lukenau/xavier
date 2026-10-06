// The Browserbase live-browser sheet ONLY (docs/inventory/home.md §6.3's
// `ScaledLiveView`: `<iframe src={live_url} sandbox="allow-scripts
// allow-same-origin">`). This is Browserbase's own remote-debugging viewer —
// a trusted third-party service, not agent-written HTML — so scripts are on.
// It is still locked hard to the one `live_url` it was given: a remote
// browser session has no legitimate reason to navigate the WebView anywhere
// else, so any other navigation (even another http(s) URL) is blocked
// outright rather than handed off to expo-web-browser. Never reuse this
// component for anything else — see BriefWebView / TrustedPageView for the
// two other trust levels.
import { useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import WebView from 'react-native-webview';
import { useTheme } from '../../theme/useTheme';
import { StatePanel } from '../shell';
import { decideLiveViewNavigation } from './webViewPolicy';

export interface BrowserLiveViewProps {
  /** Browserbase `live_url` (`debuggerFullscreenUrl`/`debuggerUrl`) for a
   * RUNNING session — the WebView never navigates anywhere else. */
  uri: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BrowserLiveView({ uri, style, testID }: BrowserLiveViewProps) {
  const { t } = useTheme();
  const ref = useRef<WebView>(null);
  const [error, setError] = useState<string | null>(null);

  if (error) {
    return <StatePanel tone="error" title="Live view unavailable" detail={error} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: t('bg-0') }, style]} testID={testID}>
      <WebView
        ref={ref}
        source={{ uri }}
        javaScriptEnabled
        incognito
        startInLoadingState
        renderLoading={() => <StatePanel tone="pending" title="Connecting…" />}
        onShouldStartLoadWithRequest={(req) => decideLiveViewNavigation(req.url, uri) === 'allow'}
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
