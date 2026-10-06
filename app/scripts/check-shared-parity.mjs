#!/usr/bin/env node
// Guards the verbatim copies under src/shared/ (and src/lib/types.ts) against
// their PWA originals in apps/hub/src.
//
// Two transforms are allowed, and both are applied to the PWA side before the
// comparison, so the transformed lines are still checked rather than skipped:
//   1. import specifiers are dropped from both sides (paths necessarily differ)
//   2. `var(--token)` becomes the bare token name, which is what src/theme's
//      resolveToken() consumes
// Anything else is drift and fails the build.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPwa, skipPwa } from './pwa.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PWA = resolve(APP, '../hub');

// Every pair below compares a file in this repo against its PWA original, and
// the PWA is not part of this repo. With no PWA there is nothing to compare —
// say so and exit not-verified (2), rather than reporting every copy as
// "cannot read".
if (!hasPwa()) {
  // Exit with the "not verified" status, never 0 — see scripts/pwa.mjs.
  process.exit(skipPwa('shared-copy parity (src/shared/* and src/lib/types.ts vs the PWA originals)'));
}

// [copy in this app, original in the PWA, optional line slice]
const PAIRS = [
  ['src/lib/types.ts', 'src/lib/types.ts'],
  ['src/shared/financeModel.ts', 'src/components/finance/model.ts'],
  ['src/shared/targets.ts', 'src/lib/targets.ts'],
  ['src/shared/symbols.ts', 'src/lib/symbols.ts'],
  ['src/shared/exposure.ts', 'src/lib/exposure.ts'],
  ['src/shared/decisions.ts', 'src/lib/decisions.ts'],
  ['src/shared/sessions.ts', 'src/lib/sessions.ts'],
  ['src/shared/configHelp.ts', 'src/lib/configHelp.ts'],
  ['src/shared/seriesColors.ts', 'src/lib/seriesColors.ts'],
  ['src/shared/time.ts', 'src/lib/time.ts'],
  // The Sankey's pure helper block only; the component and its useMemo layout
  // body stay in the PWA file and port separately.
  ['src/shared/sankeyLayout.ts', 'src/components/finance/FlowSankey.tsx', [2, 229]],
];

const HEADER_MARK = '// VERBATIM COPY of ';
const HEADER_END = '// --- end copy header; everything below is verbatim ---';

const normalize = (text) =>
  text
    .replace(/var\(--([\w-]+)\)/g, '$1')
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n')
    .trimEnd();

/**
 * The header sits above the sentinel and is therefore NOT compared. That makes
 * it the one unchecked region in a file whose whole purpose is byte parity, so
 * it is restricted to comments plus identity re-exports: `export { fitLabel }`
 * republishes the verbatim binding, while `export { mine as fitLabel }` would
 * substitute a different implementation under a verbatim name and pass.
 */
const checkHeader = (lines) => {
  const code = lines
    .filter((l) => !/^\s*(\/\/.*)?$/.test(l))
    .join('\n');
  let rest = code.trim();
  while (rest) {
    const m = rest.match(/^export\s+(?:type\s+)?\{([^}]*)\}\s*;?/);
    if (!m) return `header carries something other than an export clause: ${JSON.stringify(rest.split('\n')[0])}`;
    for (const spec of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!/^(?:type\s+)?[A-Za-z_$][\w$]*$/.test(spec)) {
        return `header export clause is not identity-only: ${JSON.stringify(spec)} — a rename can substitute a non-verbatim implementation under a verbatim name`;
      }
    }
    rest = rest.slice(m[0].length).trim();
  }
  return null;
};

const stripHeader = (text) => {
  const lines = text.split('\n');
  if (!lines[0].startsWith(HEADER_MARK)) {
    return { error: 'missing the VERBATIM COPY header', body: text };
  }
  const end = lines.indexOf(HEADER_END);
  if (end === -1) return { error: 'missing the end-of-header sentinel', body: text };
  const headerError = checkHeader(lines.slice(1, end));
  if (headerError) return { error: headerError, body: text };
  return { body: lines.slice(end + 1).join('\n') };
};

let failed = 0;

for (const [copyRel, srcRel, slice] of PAIRS) {
  let copyRaw;
  let srcRaw;
  try {
    copyRaw = readFileSync(resolve(APP, copyRel), 'utf8');
    srcRaw = readFileSync(resolve(PWA, srcRel), 'utf8');
  } catch (err) {
    console.error(`shared-parity: cannot read ${copyRel} or ${srcRel} — ${err.message}`);
    failed += 1;
    continue;
  }

  const { error, body } = stripHeader(copyRaw);
  if (error) {
    console.error(`shared-parity: ${copyRel} ${error}`);
    failed += 1;
    continue;
  }

  const srcBody = slice
    ? srcRaw.split('\n').slice(slice[0] - 1, slice[1]).join('\n')
    : srcRaw;

  const a = normalize(body);
  const b = normalize(srcBody);
  if (a === b) continue;

  failed += 1;
  const al = a.split('\n');
  const bl = b.split('\n');
  const at = al.findIndex((l, i) => l !== bl[i]);
  console.error(
    `shared-parity: ${copyRel} has drifted from ${srcRel}${slice ? ` lines ${slice[0]}-${slice[1]}` : ''}\n` +
      `  first difference at normalized line ${at + 1}\n` +
      `    copy: ${JSON.stringify(al[at] ?? '<end of file>')}\n` +
      `    pwa : ${JSON.stringify(bl[at] ?? '<end of file>')}\n` +
      `  Change the PWA first, then re-copy — never edit the copy alone.`,
  );
}

if (failed) {
  console.error(`\nshared-parity: ${failed} of ${PAIRS.length} file(s) drifted.`);
  process.exit(1);
}
console.log(`shared-parity: ${PAIRS.length} files match their PWA originals.`);
