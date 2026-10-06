// The PWA — `apps/hub` in the private monorepo — is NOT part of this repo.
//
// Three of this app's checks measure the app against PWA source: the files
// ported verbatim under src/shared, the theme token table generated from the
// PWA's tokens.css, and the xterm bytes vendored out of its node_modules. None
// of that source exists in a public clone, so every one of those checks asks
// this module first and prints an explicit `skip:` line instead of dying on a
// path that was never here.
//
// The skip is deliberately loud and names what did not run: the output must
// never be readable as a pass. Nothing is dropped silently, and a real failure
// (the PWA is present and the copies have drifted) still fails the chain.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The app directory — the parent of scripts/. */
export const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where the PWA would sit: a sibling of the app (apps/hub in the monorepo). */
export const PWA_DIR = join(APP_DIR, '..', 'hub');

/** True when the PWA source tree is checked out beside the app. */
export const hasPwa = () => existsSync(join(PWA_DIR, 'package.json'));

/**
 * The exit status a check uses when it could NOT verify its subject. It is
 * deliberately distinct from 0 (verified) and 1 (verified and failed), so a
 * caller reading only an exit code can never mistake a skip for a pass.
 * `npm run check:pwa` treats it as a failure; `npm run check` runs only the
 * checks a public clone can actually run, so it never sees one.
 */
export const SKIP_EXIT = 2;

/**
 * Report that a check cannot run here and return the status the caller must
 * exit with. Says plainly that nothing was verified and why, so the output is
 * never readable as a pass.
 */
export function skipPwa(name) {
  console.log(
    `skip: ${name} — the PWA (apps/hub) is not part of this repo, so there is nothing to compare against. ` +
      'This check runs only in the private monorepo; it was NOT verified here.',
  );
  return SKIP_EXIT;
}
