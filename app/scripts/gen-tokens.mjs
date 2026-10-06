#!/usr/bin/env node
// Generates src/theme/tokens.gen.ts from the PWA's CSS source of truth
// (apps/hub/src/styles/tokens.css). Dark = the top-level `:root {}` block;
// light = the `@media (prefers-color-scheme: light)` block. tokens.css has
// a SECOND, byte-identical light block (`:root[data-theme="light"]`); we
// only ever read the media block here, so we don't independently notice if
// that block's extraction regex ever truncated early (which would silently
// merge dark colours into "light"). Two guards cover that:
//   1. The first step of `npm run check` (scripts/check-pwa-theme-parity.mjs)
//      chains the PWA's own checker, apps/hub/scripts/check-theme-parity.mjs —
//      the PWA's checker that asserts the media block and the
//      `[data-theme="light"]` twin are name-and-value identical. With no PWA
//      checked out, both that step and this one skip (see scripts/pwa.mjs).
//   2. Below, we hard-fail if the parsed override count drops under 100 —
//      a regex that stopped early would produce a suspiciously small count.
//
// The light block only *overrides* colour-family tokens (103 of the dark
// block's 127 declarations); type scale, radii, motion and layout tokens
// (24 of them) are declared once in `:root` and inherit into light
// unchanged via the normal CSS cascade (same selector, more specific/later
// rule wins only for the properties it actually redeclares). So the
// emitted `light` object is `{ ...dark, ...lightOverrides }` — this is
// what the app actually renders, and it's what makes dark/light key sets
// identical (asserted by tokens.test.ts).
//
//   node scripts/gen-tokens.mjs         # write src/theme/tokens.gen.ts
//   node scripts/gen-tokens.mjs --check # exit 1 if the committed file is stale
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { skipPwa } from './pwa.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cssPath = join(root, '..', 'hub', 'src', 'styles', 'tokens.css');
const outPath = join(root, 'src', 'theme', 'tokens.gen.ts');
const checkMode = process.argv.includes('--check');

// The source of truth is the PWA's stylesheet, and the PWA is not part of this
// repo. With no PWA beside the app there is nothing to regenerate from and
// nothing to compare the committed table against — say so rather than dying on
// an ENOENT that reads like a broken repo.
if (!existsSync(cssPath)) {
  if (checkMode) {
    // Exit with the "not verified" status, never 0 — see scripts/pwa.mjs.
    process.exit(skipPwa("token freshness (src/theme/tokens.gen.ts vs the PWA's tokens.css)"));
  }
  console.error(`FAIL: ${cssPath} is missing.`);
  console.error(
    "tokens.gen.ts is generated from the PWA's tokens.css — check the PWA (apps/hub) out beside the app first.",
  );
  process.exit(1);
}

const css = readFileSync(cssPath, 'utf8');

function parseDecls(block) {
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const raw of noComments.split(';')) {
    const decl = raw.trim();
    if (!decl.startsWith('--')) continue;
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const name = decl.slice(2, idx).trim();
    const value = decl.slice(idx + 1).trim().replace(/\s+/g, ' ');
    if (!name || !value) continue;
    out[name] = value;
  }
  return out;
}

const darkMatch = css.match(/:root \{([\s\S]*?)\n\}/);
const lightMatch = css.match(
  /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\n  \}\n\}/
);

if (!darkMatch || !lightMatch) {
  console.error('FAIL: could not locate the dark :root block or the light @media block in tokens.css');
  process.exit(1);
}

const dark = parseDecls(darkMatch[1]);
const lightOverrides = parseDecls(lightMatch[1]);
const light = { ...dark, ...lightOverrides };

const darkKeys = Object.keys(dark);
const overrideCount = Object.keys(lightOverrides).length;
if (darkKeys.length === 0 || overrideCount === 0) {
  console.error('FAIL: parsed zero tokens from one of the blocks');
  process.exit(1);
}

// Guard against a truncated-early extraction regex silently producing a
// near-empty override set (which would leave "light" mostly dark colours).
// The block currently declares 103; 100 gives headroom for small edits
// without being so loose it'd miss a real truncation.
const MIN_OVERRIDES = 100;
if (overrideCount < MIN_OVERRIDES) {
  console.error(
    `FAIL: light block only yielded ${overrideCount} overrides (expected >= ${MIN_OVERRIDES}). ` +
      'The @media (prefers-color-scheme: light) block regex may have matched too little of tokens.css.'
  );
  process.exit(1);
}

const extraLightKeys = Object.keys(lightOverrides).filter((k) => !(k in dark));
if (extraLightKeys.length) {
  console.error(`FAIL: light block declares tokens not present in dark: ${extraLightKeys.join(', ')}`);
  process.exit(1);
}

function objectLiteral(obj) {
  const lines = Object.keys(obj)
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(obj[k])},`)
    .join('\n');
  return `{\n${lines}\n}`;
}

const output = `// AUTO-GENERATED by scripts/gen-tokens.mjs — do not edit by hand.
// Source: apps/hub/src/styles/tokens.css (dark :root block + light @media
// block, merged with dark so both objects share one complete key set —
// see the comment at the top of gen-tokens.mjs).
// Regenerate: node scripts/gen-tokens.mjs

export const dark = ${objectLiteral(dark)} as const;

export const light = ${objectLiteral(light)} as const;

export type TokenName = keyof typeof dark;
`;

if (checkMode) {
  let current;
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    console.error(`FAIL: ${outPath} does not exist. Run "node scripts/gen-tokens.mjs" to generate it.`);
    process.exit(1);
  }
  if (current !== output) {
    console.error('FAIL: src/theme/tokens.gen.ts is stale — run "node scripts/gen-tokens.mjs" and commit the result.');
    process.exit(1);
  }
  console.log(`ok: tokens.gen.ts matches tokens.css (${darkKeys.length} dark, ${Object.keys(light).length} light tokens)`);
} else {
  writeFileSync(outPath, output);
  console.log(`wrote ${outPath} (${darkKeys.length} dark, ${Object.keys(light).length} light tokens)`);
}
