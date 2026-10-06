#!/usr/bin/env node
// Runs the app's repo-wide checks and reports exactly what ran.
//
// The checks fall in two classes:
//
//   repo checks — hold in any checkout. A raw-colour literal is a raw-colour
//     literal wherever it lives, so this runs everywhere.
//
//   PWA checks  — compare this app against the PWA (apps/hub) it was ported
//     from: the verbatim copies under src/shared, the theme token table
//     generated from its tokens.css, and the xterm bytes vendored out of its
//     node_modules. The PWA is NOT part of this repo, so in a public clone
//     these have nothing to compare against and cannot run at all.
//
// A PWA check that cannot run exits 2 ("not verified" — see scripts/pwa.mjs),
// never 0. That is the whole point: a caller reading only an exit code must not
// be told a check passed when it never ran. This aggregator keeps that
// distinction:
//
//   npm run check        repo checks only. A public clone has no PWA, so the
//                        PWA checks are out of scope here and are NAMED in the
//                        output rather than reported as passing. Exit 0 means
//                        "everything this command covers passed" — it makes no
//                        claim about the PWA checks.
//   npm run check:pwa    every check; a skip is a FAILURE (exit 2). Use this in
//                        a checkout that has the PWA beside the app (the private
//                        monorepo), where every check actually runs.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const requirePwa = process.argv.includes('--require-pwa');

// [script, args, label] — label is what the summary names.
const REPO_CHECKS = [
  ['check-no-raw-color.mjs', [], 'no raw colour literals outside src/theme/'],
];

const PWA_CHECKS = [
  ['check-pwa-theme-parity.mjs', [], 'theme light-block parity (PWA tokens.css)'],
  ['gen-tokens.mjs', ['--check'], 'token freshness (tokens.gen.ts vs PWA tokens.css)'],
  ['gen-xterm-bundle.mjs', ['--check'], 'xterm bundle freshness (vs PWA node_modules)'],
  ['check-shared-parity.mjs', [], 'shared-copy parity (src/shared vs PWA originals)'],
];

const checks = requirePwa ? [...REPO_CHECKS, ...PWA_CHECKS] : REPO_CHECKS;

if (!requirePwa) {
  console.log('note: this command runs only the checks a public clone can run.');
  console.log(`      NOT run here, and NOT verified: ${PWA_CHECKS.map((c) => c[2]).join('; ')}.`);
  console.log('      Run "npm run check:pwa" in a checkout that contains the PWA (apps/hub).');
}

let passed = 0;
let failed = 0;
let skipped = 0;

for (const [script, args] of checks) {
  const res = spawnSync(process.execPath, [join(APP, 'scripts', script), ...args], {
    stdio: 'inherit',
  });
  const code = res.status ?? 1;
  if (code === 0) passed += 1;
  else if (code === 2) skipped += 1;
  else failed += 1;
}

console.log(
  `\ncheck: ${passed} passed, ${failed} failed, ${skipped} skipped` +
    (requirePwa ? ' (a skipped check is a failure in this mode)' : ''),
);

if (failed) process.exit(1);
if (skipped) process.exit(2);
process.exit(0);
