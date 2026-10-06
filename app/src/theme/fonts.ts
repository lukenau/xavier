import type { TextStyle } from 'react-native';

// Native font-family map for the instanced statics in assets/fonts/.
//
// RN on iOS has no variable-font axis API, so every intermediate weight the
// PWA uses is baked into its own static TTF (scripts/instance-fonts.py) and
// registered as its own family name via the expo-font config plugin
// (app.json). fonts.sans(weight) / fonts.mono(weight) return that exact
// family string for use as a RN `fontFamily` style value.
//
// SANS_WEIGHTS is the verified set from apps/hub/src (grep of every
// fontWeight literal + Tailwind weight class) cross-checked against
// docs/inventory/theme.md §3.3 — see task-3-report.md for the full command
// + counts. It supersedes the task brief's stale {400,450,500,520,550,580,
// 620,640} list: 450 is unused anywhere in the PWA; 540/560/600/650/700/800
// are used (600 has 42 call sites, 700 includes the header wordmark) and
// were missing from that list.
//
// MONO_WEIGHTS is a strict subset: a per-site audit (same-element font-mono
// + fontWeight, conditional class expressions, `...mono` SVG style spreads,
// and ancestor/descendant font-family inheritance — see task-3-report.md
// "Mono weight audit") found 540/560/580/640 are sans-only everywhere they
// occur in apps/hub/src, so those four HubMono statics were pruned. The
// type system enforces the split: fonts.mono() only accepts MONO_WEIGHTS,
// so passing a pruned weight is a compile error, not a silent system-font
// fallback at runtime.
export const SANS_WEIGHTS = [400, 500, 520, 540, 550, 560, 580, 600, 620, 640, 650, 700, 800] as const;
export const MONO_WEIGHTS = [400, 500, 520, 550, 600, 620, 650, 700, 800] as const;

export type SansWeight = (typeof SANS_WEIGHTS)[number];
export type MonoWeight = (typeof MONO_WEIGHTS)[number];

function buildFamily<W extends number>(prefix: string, weights: readonly W[]): Record<W, string> {
  return Object.fromEntries(weights.map((w) => [w, `${prefix}-${w}`])) as Record<W, string>;
}

const SANS_FAMILY = buildFamily('HubOnest', SANS_WEIGHTS);
const MONO_FAMILY = buildFamily('HubMono', MONO_WEIGHTS);

export const fonts = {
  sans(weight: SansWeight): string {
    return SANS_FAMILY[weight];
  },
  mono(weight: MonoWeight): string {
    return MONO_FAMILY[weight];
  },
};

// Mirrors the PWA's `fontVariantNumeric: 'tabular-nums'` usage (74 call
// sites per docs/inventory/theme.md §3.4) on every money/number column.
// No `as const`: that infers `readonly ['tabular-nums']`, which is NOT
// assignable to RN's `TextStyle.fontVariant` (`FontVariant[]`, mutable,
// wider union) — `satisfies` contextually types the array literal against
// TextStyle instead, so the inferred type is the correct `FontVariant[]`.
export const MONO_FEATURES = { fontVariant: ['tabular-nums'] } satisfies TextStyle;

export const FONT_FILES: readonly string[] = [
  ...SANS_WEIGHTS.map((w) => `HubOnest-${w}.ttf`),
  ...MONO_WEIGHTS.map((w) => `HubMono-${w}.ttf`),
];
