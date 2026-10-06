// The terminal WebView's page, assembled as one self-contained HTML string.
//
// Everything is inline — xterm, the fit addon, the stylesheet, HubMono as a
// data: URI, and the shim below — because `source={{ html, baseUrl }}` is the
// only delivery route that behaves identically in dev and in a store build
// (docs/research/terminal.md §3.1) and the page must never make a network
// request of its own: it is `about:blank`-origin, holds no cookie, and the
// socket lives in React Native (src/terminal/wsClient.ts), not here.
//
// The page is DISPLAY-ONLY. It draws bytes, reports its grid size, and
// acknowledges writes. It owns no connection, no reconnect, no lock state,
// and — deliberately — no keyboard: the composer and key bar are native
// views outside WKWebView, which is what sidesteps the whole
// keyboard-viewport bug family the PWA fought (research §3.5).
import {
  FIT_ADDON_JS,
  MONO_FONT_BASE64,
  XTERM_CSS,
  XTERM_JS,
} from './xtermBundle.gen';

/** xterm's `ITheme` subset the PWA sets (XtermView.tsx:20-26). */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

export interface TerminalHtmlOptions {
  theme: XtermTheme;
  fontSize: number;
}

/** HubMono is JetBrains Mono instanced at 400 (src/theme/fonts.ts) — the same
 * face `"JetBrains Mono Variable"` resolves to in the PWA. */
export const TERMINAL_FONT_FAMILY = '"HubMono", ui-monospace, monospace';

/** XtermView.tsx:84 — the PWA's scrollback, not xterm's 1000 default. */
export const SCROLLBACK = 5000;

/** XtermView.tsx:263 — `px-[6px] pt-[4px]` around the xterm host element. */
export const HOST_PADDING = { top: 4, side: 6 };

export type HostMessage =
  | { t: 'ready' }
  | { t: 'size'; cols: number; rows: number }
  | { t: 'ack'; n: number }
  | { t: 'data'; d: string };

/**
 * The bridge shim. Five entry points, all called with `injectJavaScript`:
 *
 *   `__w(b64, acks)`  write bytes; when `acks > 0` post one `{t:'ack', n}`
 *                     once xterm has rendered them — the renderer half of
 *                     ttyd's flow-control window (task-22-report.md §3).
 *   `__theme(json)`   swap `term.options.theme` (light/dark, live).
 *   `__font(size)`    font size, then re-fit.
 *   `__box(px)`       logical height: the keyboard shrinks the terminal's
 *                     ROWS without resizing the WKWebView frame, which is
 *                     what avoids webview#3689.
 *   `__bottom()`      `term.scrollToBottom()` (XtermView.tsx:54, on send).
 *
 * And three outbound messages: `ready`, `size` (after every fit) and `data`
 * (xterm's own `onData` — a hardware keyboard or a paste into the canvas;
 * the software keyboard is suppressed, see `inputmode` below).
 */
function shim(options: TerminalHtmlOptions): string {
  return `(function () {
  var host = document.getElementById('host');
  function post(msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  var term = new Terminal({
    fontFamily: ${JSON.stringify(TERMINAL_FONT_FAMILY)},
    fontSize: ${options.fontSize},
    cursorBlink: true,
    scrollback: ${SCROLLBACK},
    theme: ${JSON.stringify(options.theme)}
  });
  // The fit addon's UMD global is the module namespace, xterm's is the class.
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Display-only: inputmode=none keeps xterm's helper textarea focusable for a
  // hardware keyboard while never raising the iOS software keyboard inside
  // WKWebView. The native composer owns the keyboard.
  if (term.textarea) term.textarea.setAttribute('inputmode', 'none');
  term.onData(function (d) { post({ t: 'data', d: d }); });
  function measure() {
    try { fit.fit(); } catch (e) { /* pre-layout fit throws; the next one wins */ }
    post({ t: 'size', cols: term.cols, rows: term.rows });
  }
  window.__w = function (b64, acks) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (acks > 0) term.write(bytes, function () { post({ t: 'ack', n: acks }); });
    else term.write(bytes);
  };
  window.__theme = function (json) {
    var theme = JSON.parse(json);
    term.options.theme = theme;
    document.body.style.background = theme.background;
  };
  window.__font = function (size) { term.options.fontSize = size; measure(); };
  window.__box = function (px) { host.style.height = px + 'px'; measure(); };
  window.__bottom = function () { term.scrollToBottom(); };
  window.addEventListener('resize', measure);
  // The first fit runs on fallback metrics if HubMono has not decoded yet,
  // which would hand ttyd the wrong cols; re-fit once the face is live.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  measure();
  post({ t: 'ready' });
})();`;
}

export function buildTerminalHtml(options: TerminalHtmlOptions): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<style>
@font-face{font-family:"HubMono";src:url("data:font/ttf;base64,${MONO_FONT_BASE64}") format("truetype");font-weight:400;font-style:normal;font-display:block}
${XTERM_CSS}
html,body{margin:0;padding:0;height:100%;width:100%;overflow:hidden;background:${options.theme.background};-webkit-text-size-adjust:100%;-webkit-touch-callout:none}
#host{position:absolute;left:0;top:0;right:0;height:100%;box-sizing:border-box;padding:${HOST_PADDING.top}px ${HOST_PADDING.side}px 0}
</style>
</head>
<body>
<div id="host"></div>
<script>${XTERM_JS}</script>
<script>${FIT_ADDON_JS}</script>
<script>${shim(options)}</script>
</body>
</html>`;
}

// --- injectJavaScript payloads -------------------------------------------------------
// Every one ends in `true;`: iOS logs a warning when evaluateJavaScript's
// result is not a serialisable value.

export function jsWrite(base64: string, acks: number): string {
  return `window.__w(${JSON.stringify(base64)},${acks});true;`;
}

export function jsTheme(theme: XtermTheme): string {
  return `window.__theme(${JSON.stringify(JSON.stringify(theme))});true;`;
}

export function jsFontSize(size: number): string {
  return `window.__font(${size});true;`;
}

export function jsViewportHeight(px: number): string {
  return `window.__box(${Math.round(px)});true;`;
}

export function jsScrollToBottom(): string {
  return `window.__bottom();true;`;
}

/** `onMessage` payloads. Anything unrecognised is dropped rather than guessed
 * at — the page is the only writer, but a malformed frame must not throw
 * inside a WebView callback. */
export function parseHostMessage(raw: string): HostMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const msg = value as Record<string, unknown>;
  if (msg.t === 'ready') return { t: 'ready' };
  if (msg.t === 'size' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
    return { t: 'size', cols: msg.cols, rows: msg.rows };
  }
  if (msg.t === 'ack' && typeof msg.n === 'number') return { t: 'ack', n: msg.n };
  if (msg.t === 'data' && typeof msg.d === 'string') return { t: 'data', d: msg.d };
  return null;
}
