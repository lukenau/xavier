#!/usr/bin/env node
// Runs the PWA's own theme checker (apps/hub/scripts/check-theme-parity.mjs),
// which asserts that tokens.css's `@media (prefers-color-scheme: light)` block
// and its byte-identical `:root[data-theme="light"]` twin declare the same
// names and values. The app chains it because src/theme/tokens.gen.ts is
// generated from that same tokens.css (gen-tokens.mjs) — if the two light
// blocks ever diverged, the generated table would be silently wrong.
//
// It is a check of the PWA BY the PWA, and the PWA is not part of this repo, so
// with no PWA checked out there is simply nothing to check: say so and exit
// not-verified (2), never 0.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { skipPwa, PWA_DIR } from './pwa.mjs';

const checker = join(PWA_DIR, 'scripts', 'check-theme-parity.mjs');

if (!existsSync(checker)) {
  // Exit with the "not verified" status, never 0 — see scripts/pwa.mjs.
  process.exit(skipPwa('theme parity (the PWA\'s tokens.css light-block check)'));
}

const run = spawnSync(process.execPath, [checker], { stdio: 'inherit' });
process.exit(run.status ?? 1);
