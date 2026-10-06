// The page is unverifiable on this host — nothing here renders a terminal.
// What IS verifiable, and what a device run cannot cheaply re-check, is the
// CONTRACT: the versions vendored, the globals the shim defines, and the exact
// strings React Native injects to reach them. A typo in any of those is a
// blank terminal with no error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTerminalHtml,
  jsFontSize,
  jsScrollToBottom,
  jsTheme,
  jsViewportHeight,
  jsWrite,
  parseHostMessage,
  SCROLLBACK,
  TERMINAL_FONT_FAMILY,
  type XtermTheme,
} from './xtermHtml';
import {
  FIT_ADDON_VERSION,
  MONO_FONT_FILE,
  XTERM_CSS,
  XTERM_VERSION,
} from './xtermBundle.gen';
import { resolveToken } from '../theme/useTheme';

// Resolved from the token table rather than spelled out, so a --term-* change
// moves the fixture with it instead of failing this file.
const THEME: XtermTheme = {
  background: resolveToken('dark', 'term-bg'),
  foreground: resolveToken('dark', 'term-fg'),
  cursor: resolveToken('dark', 'term-cursor'),
  cursorAccent: resolveToken('dark', 'term-bg'),
  selectionBackground: resolveToken('dark', 'term-selection'),
};

const html = buildTerminalHtml({ theme: THEME, fontSize: 13 });

describe('what is vendored', () => {
  test('is the version the notices declare for the vendored xterm', () => {
    // The PWA this bundle was originally copied from (apps/hub) is not part of
    // this repo, so there is no sibling package.json to compare against. The
    // declaration the vendored constants must stay in step with is the
    // release's own third-party notices, which name the exact versions the
    // bundle was vendored from ("**@xterm/xterm** 6.0.0"). Re-vendoring
    // without updating the notices fails here.
    const notices = readFileSync(join(__dirname, '..', '..', '..', 'THIRD-PARTY-NOTICES.md'), 'utf8');
    const declared = (name: string): string => {
      const at = notices.indexOf(`**${name}**`);
      const m = at === -1 ? null : notices.slice(at + name.length + 4).match(/^ ([0-9]+\.[0-9]+\.[0-9]+)\b/);
      if (!m) throw new Error(`THIRD-PARTY-NOTICES.md no longer names a version for ${name}`);
      return m[1];
    };
    expect(declared('@xterm/xterm')).toBe(XTERM_VERSION);
    expect(declared('@xterm/addon-fit')).toBe(FIT_ADDON_VERSION);
  });

  test('is a real bundle, not a placeholder', () => {
    expect(html.length).toBeGreaterThan(400_000);
    expect(XTERM_CSS).toContain('.xterm');
    expect(MONO_FONT_FILE).toBe('HubMono-400.ttf');
  });

  test('cannot break out of the tags it is inlined into', () => {
    // A `</script` anywhere in the payload would end the tag early and render
    // the rest of xterm as text. The generator refuses to emit one; this is
    // the assertion that a hand-edit cannot sneak one in either.
    expect(html.slice(html.indexOf('<script>')).match(/<\/script/g)).toHaveLength(3);
    expect(html.match(/<\/style/g)).toHaveLength(1);
  });
});

describe('the page', () => {
  test('embeds the font as a data URI and names it for xterm', () => {
    expect(html).toContain('@font-face{font-family:"HubMono";src:url("data:font/ttf;base64,');
    expect(html).toContain(`fontFamily: ${JSON.stringify(TERMINAL_FONT_FAMILY)}`);
    expect(TERMINAL_FONT_FAMILY).toBe('"HubMono", ui-monospace, monospace');
  });

  test('constructs the terminal with the PWA\'s options', () => {
    expect(html).toContain('cursorBlink: true');
    expect(html).toContain(`scrollback: ${SCROLLBACK}`);
    expect(SCROLLBACK).toBe(5000);
    expect(html).toContain('fontSize: 13');
    expect(html).toContain(`theme: ${JSON.stringify(THEME)}`);
    // Baked in, so the first paint is already themed — no flash of a
    // differently-coloured terminal while the theme message crosses.
    expect(html).toContain(`background:${THEME.background}`);
  });

  test('loads the fit addon through its NAMESPACED umd global', () => {
    // xterm spreads its exports onto globalThis (`Terminal` is the class);
    // addon-fit assigns the module namespace (`FitAddon.FitAddon` is).
    expect(html).toContain('new FitAddon.FitAddon()');
    expect(html).toContain('new Terminal({');
  });

  test('defines every entry point React Native injects', () => {
    for (const global of ['window.__w', 'window.__theme', 'window.__font', 'window.__box', 'window.__bottom']) {
      expect(html).toContain(`${global} = function`);
    }
  });

  test('posts ready, size, ack and data back', () => {
    expect(html).toContain("post({ t: 'ready' })");
    expect(html).toContain("post({ t: 'size', cols: term.cols, rows: term.rows })");
    expect(html).toContain("post({ t: 'ack', n: acks })");
    expect(html).toContain("post({ t: 'data', d: d })");
    expect(html).toContain('window.ReactNativeWebView.postMessage(JSON.stringify(msg))');
  });

  test('acks ONLY when the batch carried flagged chunks', () => {
    expect(html).toContain('if (acks > 0) term.write(bytes, function () {');
    expect(html).toContain('else term.write(bytes);');
  });

  test('suppresses the software keyboard inside the WebView', () => {
    // The whole point of the native composer: no focusable element in
    // WKWebView may ever raise the iOS keyboard.
    expect(html).toContain("term.textarea.setAttribute('inputmode', 'none')");
  });

  test('re-fits once the embedded font has decoded', () => {
    // Fitting on fallback metrics hands ttyd the wrong column count.
    expect(html).toContain('document.fonts.ready.then(measure)');
  });
});

describe('injected payloads', () => {
  test('every one ends in true; so iOS does not warn on the result', () => {
    for (const js of [
      jsWrite('AAA=', 0),
      jsTheme(THEME),
      jsFontSize(14),
      jsViewportHeight(300),
      jsScrollToBottom(),
    ]) {
      expect(js.endsWith('true;')).toBe(true);
    }
  });

  test('jsWrite passes the base64 as a quoted string with the ack count', () => {
    expect(jsWrite('Zm9v', 2)).toBe('window.__w("Zm9v",2);true;');
  });

  test('jsTheme hands the page a JSON STRING, which it parses', () => {
    // Double-encoded on purpose: the outer JSON.stringify makes it a JS string
    // literal, the page's JSON.parse turns it back into the theme object.
    expect(jsTheme(THEME)).toBe(`window.__theme(${JSON.stringify(JSON.stringify(THEME))});true;`);
    expect(jsTheme(THEME)).toContain(`\\"background\\":\\"${THEME.background}\\"`);
  });

  test('jsViewportHeight rounds — a fractional px is a CSS string the page would not fit on', () => {
    expect(jsViewportHeight(412.6)).toBe('window.__box(413);true;');
  });

  test('jsFontSize carries the number', () => {
    expect(jsFontSize(17)).toBe('window.__font(17);true;');
  });
});

describe('parseHostMessage', () => {
  test('reads each message the shim sends', () => {
    expect(parseHostMessage('{"t":"ready"}')).toEqual({ t: 'ready' });
    expect(parseHostMessage('{"t":"size","cols":80,"rows":24}')).toEqual({
      t: 'size',
      cols: 80,
      rows: 24,
    });
    expect(parseHostMessage('{"t":"ack","n":3}')).toEqual({ t: 'ack', n: 3 });
    expect(parseHostMessage('{"t":"data","d":"\\u0003"}')).toEqual({ t: 'data', d: '\x03' });
  });

  test('drops anything malformed rather than throwing inside a WebView callback', () => {
    expect(parseHostMessage('not json')).toBeNull();
    expect(parseHostMessage('null')).toBeNull();
    expect(parseHostMessage('42')).toBeNull();
    expect(parseHostMessage('{"t":"size","cols":"80","rows":24}')).toBeNull();
    expect(parseHostMessage('{"t":"ack"}')).toBeNull();
    expect(parseHostMessage('{"t":"nope"}')).toBeNull();
  });
});
