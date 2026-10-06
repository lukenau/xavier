// Two composite tokens are handed to React Native's CSS-string style parsers
// verbatim rather than re-authored as structured values: XavierCard passes
// `--hero-wash` to `experimental_backgroundImage`, Toast passes `--shadow-menu`
// to `boxShadow`. RN renders nothing at all when a string fails to parse, so a
// token rewritten into a syntax RN does not accept would cost the hero card's
// sheen or the toast's shadow with no other signal. These are RN's own parsers.
//
// `--wash` is NOT covered here any more. Ground stopped handing it to RN's
// parser when it switched to stacked circles (Ground.tsx), so RN's ability to
// parse it stopped being a fact about this app. What IS load-bearing is the
// token's SHAPE, because Ground.parseWash reads the corners and colours back
// out of it with a regex — and Ground.test.tsx pins that, for both themes.
//
// Only tokens the shell actually consumes are covered — asserting anything
// about a token nothing reads would document an intention rather than a fact.
/* eslint-disable @typescript-eslint/no-var-requires */
type Parser = (value: string) => unknown[];
const processBackgroundImage: Parser = require('react-native/Libraries/StyleSheet/processBackgroundImage')
  .default;
const processBoxShadow: Parser = require('react-native/Libraries/StyleSheet/processBoxShadow').default;

import { resolveToken, type Scheme } from './useTheme';

const SCHEMES: Scheme[] = ['dark', 'light'];

describe.each(SCHEMES)('%s scheme', (scheme) => {
  test('--hero-wash parses into the sheen XavierCard paints', () => {
    // XavierCard.tsx:67 — a single linear-gradient. Zero layers would mean the
    // hero card silently lost its sheen with no other signal.
    expect(processBackgroundImage(resolveToken(scheme, 'hero-wash'))).toHaveLength(1);
  });

  test('--shadow-menu parses into a shadow Toast can paint', () => {
    expect(processBoxShadow(resolveToken(scheme, 'shadow-menu')).length).toBeGreaterThan(0);
  });
});
