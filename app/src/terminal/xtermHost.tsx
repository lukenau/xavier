// The renderer. One WebView, display-only, fed by `injectJavaScript`.
//
// It owns nothing but pixels: no socket, no cookie, no keyboard, no reconnect.
// The frame height comes from the caller and the KEYBOARD never changes it —
// the key bar translates up over this view instead of resizing it, which is
// what webview#3689 (a blank keyboard-height offset left behind by resizing a
// WebView while the keyboard is up) is about. `viewportHeight` is the part
// still visible under that bar, and the page re-fits its grid to it. Bytes
// arrive batched a frame at a time (writeBatch.ts), and the ack the page sends
// back is what keeps ttyd's flow window open.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import {
  buildTerminalHtml,
  jsFontSize,
  jsScrollToBottom,
  jsTheme,
  jsViewportHeight,
  parseHostMessage,
  type XtermTheme,
} from './xtermHtml';
import { WriteBatcher } from './writeBatch';

/** The page is `about:blank` on purpose: it makes no requests, resolves no
 * relative URLs, and an opaque origin means terminal output — attacker-shaped
 * bytes — is rendered by a document with access to nothing. Anything else
 * navigating is a bug, so nothing else loads. */
export function decideTerminalNavigation(url: string): boolean {
  return url === 'about:blank' || url === '';
}

export interface XtermHostProps {
  theme: XtermTheme;
  fontSize: number;
  /** WKWebView frame height. Changes only with the enclosing layout — the
   * bottom spacer's safe-area collapse moves it by ~30px once when the
   * keyboard opens; the keyboard's own height never does (see layout.ts). */
  height: number;
  /** Height the grid is fitted to: `height` minus what the sticky bar covers. */
  viewportHeight: number;
  onSize: (cols: number, rows: number) => void;
  /** One call per chunk the transport flagged `needsAck`. */
  onAck: () => void;
  /** xterm's own onData — a hardware keyboard, or a paste into the canvas. */
  onData: (text: string) => void;
}

export interface XtermHostHandle {
  write: (bytes: Uint8Array, needsAck: boolean) => void;
  scrollToBottom: () => void;
}

export const XtermHost = forwardRef<XtermHostHandle, XtermHostProps>(function XtermHost(
  { theme, fontSize, height, viewportHeight, onSize, onAck, onData },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const ready = useRef(false);
  // Live values for the post-reload replay: the HTML bakes in whatever theme
  // and font size were current at mount, so after a content-process restart
  // the page comes back stale unless both are pushed again.
  const live = useRef({ theme, fontSize, viewportHeight });
  live.current = { theme, fontSize, viewportHeight };

  const inject = useCallback((js: string) => {
    webRef.current?.injectJavaScript(js);
  }, []);

  const batcher = useMemo(() => new WriteBatcher({ inject, onAck }), [inject, onAck]);
  useEffect(() => () => void batcher.settle(), [batcher]);

  // Built once, and handed over as one stable object. Re-deriving the HTML
  // would reload the page — losing the scrollback — on every theme or font
  // change; those go through injectJavaScript below instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => buildTerminalHtml({ theme, fontSize }), []);
  const source = useMemo(() => ({ html, baseUrl: 'about:blank' }), [html]);

  useImperativeHandle(
    ref,
    () => ({
      write: (bytes, needsAck) => batcher.push(bytes, needsAck),
      scrollToBottom: () => inject(jsScrollToBottom()),
    }),
    [batcher, inject],
  );

  useEffect(() => {
    if (ready.current) inject(jsTheme(theme));
  }, [inject, theme]);

  useEffect(() => {
    if (ready.current) inject(jsFontSize(fontSize));
  }, [fontSize, inject]);

  useEffect(() => {
    if (ready.current) inject(jsViewportHeight(viewportHeight));
  }, [inject, viewportHeight]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const msg = parseHostMessage(event.nativeEvent.data);
      if (!msg) return;
      if (msg.t === 'ready') {
        ready.current = true;
        batcher.resume();
        inject(jsTheme(live.current.theme));
        inject(jsFontSize(live.current.fontSize));
        inject(jsViewportHeight(live.current.viewportHeight));
        return;
      }
      if (msg.t === 'size') {
        onSize(msg.cols, msg.rows);
        return;
      }
      if (msg.t === 'ack') {
        batcher.pageAcked(msg.n);
        return;
      }
      onData(msg.d);
    },
    [batcher, inject, onData, onSize],
  );

  // WebKit kills the content process under memory pressure; the view comes
  // back blank and silent. Reload, settle the acks those lost writes owed,
  // and let the page's own `ready` → `size` round trip re-resize the pty.
  const onContentProcessDidTerminate = useCallback(() => {
    ready.current = false;
    // suspend(), not settle(): the reload is asynchronous, and every byte that
    // arrives before the new page says `ready` would otherwise be injected
    // into a page with no `window.__w` — lost, and its ack with it.
    batcher.suspend();
    webRef.current?.reload();
  }, [batcher]);

  return (
    <View style={[styles.frame, { height, backgroundColor: theme.background }]}>
      <WebView
        ref={webRef}
        testID="xterm-webview"
        source={source}
        originWhitelist={['about:blank']}
        onShouldStartLoadWithRequest={(request) => decideTerminalNavigation(request.url)}
        onMessage={onMessage}
        onContentProcessDidTerminate={onContentProcessDidTerminate}
        scrollEnabled={false}
        bounces={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        hideKeyboardAccessoryView
        allowsLinkPreview={false}
        dataDetectorTypes="none"
        allowsBackForwardNavigationGestures={false}
        style={[styles.web, { backgroundColor: theme.background }]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  frame: { width: '100%', overflow: 'hidden' },
  web: { flex: 1 },
});
