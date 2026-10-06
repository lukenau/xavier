import fs from 'fs';
import path from 'path';
import type { TextStyle } from 'react-native';
import { FONT_FILES, MONO_FEATURES, MONO_WEIGHTS, SANS_WEIGHTS, fonts } from './fonts';
import appJson from '../../app.json';

const HUB_APP_DIR = path.join(__dirname, '..', '..');
const FONTS_DIR = path.join(HUB_APP_DIR, 'assets', 'fonts');

function appJsonFontFiles(): string[] {
  const plugins: unknown[] = appJson.expo.plugins ?? [];
  const entry = plugins.find(
    (p): p is [string, { fonts: string[] }] => Array.isArray(p) && p[0] === 'expo-font'
  );
  if (!entry) throw new Error('app.json: no expo-font plugin entry found');
  return entry[1].fonts.map((f) => path.basename(f));
}

describe('theme fonts', () => {
  it('SANS_WEIGHTS covers the audited weight set (apps/hub/src grep, docs/inventory/theme.md §3.3)', () => {
    expect([...SANS_WEIGHTS].sort((a, b) => a - b)).toEqual(
      [400, 500, 520, 540, 550, 560, 580, 600, 620, 640, 650, 700, 800]
    );
  });

  it('MONO_WEIGHTS is SANS_WEIGHTS minus the audited mono-unreachable weights (540/560/580/640)', () => {
    expect([...MONO_WEIGHTS].sort((a, b) => a - b)).toEqual(
      [400, 500, 520, 550, 600, 620, 650, 700, 800]
    );
    for (const w of MONO_WEIGHTS) {
      expect(SANS_WEIGHTS).toContain(w);
    }
  });

  it('fonts.sans(weight) and fonts.mono(weight) return a distinct family per weight', () => {
    const sansNames = SANS_WEIGHTS.map((w) => fonts.sans(w));
    const monoNames = MONO_WEIGHTS.map((w) => fonts.mono(w));
    expect(new Set(sansNames).size).toBe(SANS_WEIGHTS.length);
    expect(new Set(monoNames).size).toBe(MONO_WEIGHTS.length);
    expect(new Set([...sansNames, ...monoNames]).size).toBe(SANS_WEIGHTS.length + MONO_WEIGHTS.length);
  });

  it('every weight maps to the expected HubOnest-N / HubMono-N family name', () => {
    for (const w of SANS_WEIGHTS) {
      expect(fonts.sans(w)).toBe(`HubOnest-${w}`);
    }
    for (const w of MONO_WEIGHTS) {
      expect(fonts.mono(w)).toBe(`HubMono-${w}`);
    }
  });

  it('every mapped font file exists on disk under assets/fonts/', () => {
    for (const w of SANS_WEIGHTS) {
      expect(fs.existsSync(path.join(FONTS_DIR, `HubOnest-${w}.ttf`))).toBe(true);
    }
    for (const w of MONO_WEIGHTS) {
      expect(fs.existsSync(path.join(FONTS_DIR, `HubMono-${w}.ttf`))).toBe(true);
    }
  });

  it('FONT_FILES, the files on disk, and app.json expo-font plugin all list exactly the same set', () => {
    const onDisk = fs.readdirSync(FONTS_DIR).filter((f) => f.endsWith('.ttf')).sort();
    const fromFontsTs = [...FONT_FILES].sort();
    const fromAppJson = appJsonFontFiles().sort();
    expect(fromFontsTs).toEqual(onDisk);
    expect(fromAppJson).toEqual(onDisk);
  });

  it('MONO_FEATURES requests tabular numerals (mirrors PWA fontVariantNumeric: tabular-nums)', () => {
    expect(MONO_FEATURES).toEqual({ fontVariant: ['tabular-nums'] });
  });

  it('MONO_FEATURES is assignable to a RN TextStyle, directly and spread (compile-time check)', () => {
    // If MONO_FEATURES's inferred type isn't assignable to TextStyle.fontVariant
    // (FontVariant[]), `npm run typecheck` fails on the two lines below — this
    // is the actual regression test; the assertions just keep the it() non-empty.
    const direct: TextStyle = MONO_FEATURES;
    const spread: TextStyle = { ...MONO_FEATURES };
    expect(direct.fontVariant).toEqual(['tabular-nums']);
    expect(spread.fontVariant).toEqual(['tabular-nums']);
  });
});
