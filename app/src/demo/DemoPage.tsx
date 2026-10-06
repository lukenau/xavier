// The page reader in the demo. A real /my-pages page is HTML the agent wrote,
// fetched from the server; the demo has copies of the seed's pages and shows
// those from memory instead, with the same no-script WebView. Nothing it
// renders may load anything: a CSP that refuses every fetch rides in with the
// HTML, and the WebView will not navigate off it.
import { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import WebView from 'react-native-webview';
import { useTheme } from '../theme/useTheme';
import { demoPage } from './server';
import { ServerOnlyPanel } from './ServerOnly';

/** No network for anything in the page; a phone-width layout, since the seed's
 * pages carry no viewport of their own. No colours: the page keeps its own. */
const HEAD =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<style>body{font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.45;margin:16px}</style>';

export function withDemoHead(html: string): string {
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (tag) => tag + HEAD) : HEAD + html;
}

export function DemoPageView({
  uri,
  style,
  testID,
}: {
  uri: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { t } = useTheme();
  const html = useMemo(() => {
    const page = demoPage(uri);
    return page === null ? null : withDemoHead(page);
  }, [uri]);

  if (html === null) {
    return (
      <ServerOnlyPanel
        title="Not in the demo"
        detail="Pages are what your agent publishes on your own server. The demo carries copies of only a few."
      />
    );
  }
  return (
    <View style={[styles.container, { backgroundColor: t('page-white') }, style]} testID={testID}>
      <WebView
        source={{ html }}
        javaScriptEnabled={false}
        incognito
        onShouldStartLoadWithRequest={(req) => req.url === 'about:blank'}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, borderRadius: 10, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: 'transparent' },
});
