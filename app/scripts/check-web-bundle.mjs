#!/usr/bin/env node
// Scans the exported web build (npm run build:web → dist/) for the strings that
// must never ship: the author's internal hostnames, private estate paths, the
// private monorepo's layout, work content, and secret/token shapes.
//
// The publish gate (scripts/publish-gate.sh) scans SOURCE, not build output,
// and it excludes dist/ on purpose — so a web export that embeds something the
// source never spelled out (a resolved value, a baked-in host) would slip past
// it. This check reads the artifact the browser would actually receive.
//
// It does NOT keep its own copy of the patterns: it reads the gate's scan rules
// from the gate script and reruns them over the bundle. One source of truth, so
// the two cannot drift, and this file never contains a pattern literal for the
// gate to flag (the same reason the gate excludes itself).
//
// Exit codes match scripts/pwa.mjs: 0 verified-clean, 1 verified-and-failed,
// 2 not verified (no bundle to scan). A caller reading only the exit code can
// never mistake a skip for a pass.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(APP_DIR, 'dist');
const GATE = join(APP_DIR, '..', 'scripts', 'publish-gate.sh');

// Categories the gate applies to SOURCE prose but that a compiled bundle cannot
// use for a verdict: the bundle is overwhelmingly third-party code, and its
// dependency licence headers carry real contact details (names, emails) that
// are neither the author's nor ours to strip. The bundle scan still covers every
// class that is actually ours to leak — identifiers, hosts, paths, work content
// and secrets.
const BUNDLE_EXEMPT = new Set(['pii: phone number', 'pii: street address', 'pii: personal email']);

const SKIP_EXIT = 2;

function gatePatterns() {
  let text;
  try {
    text = readFileSync(GATE, 'utf8');
  } catch {
    return null;
  }
  const rules = [];
  // The gate writes one rule per line:  scan "label" 'pattern'   (prose, -i)
  //                                scan_cs "label" 'pattern'      (exact case)
  const re = /^\s*scan(_cs)?\s+"([^"]+)"\s+'([^']+)'/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    rules.push({ label: m[2], pattern: m[3], flags: m[1] === '_cs' ? 'g' : 'gi' });
  }
  return rules;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let distExists = false;
try {
  distExists = statSync(DIST).isDirectory();
} catch {
  distExists = false;
}

if (!distExists) {
  console.log(
    'skip: web bundle — dist/ does not exist, so there is nothing to scan. ' +
      'Run `npm run build:web` first. Nothing was verified here.',
  );
  process.exit(SKIP_EXIT);
}

const rules = gatePatterns();
if (!rules || rules.length === 0) {
  console.log(
    `skip: web bundle — could not read any scan rules from ${relative(APP_DIR, GATE)}. ` +
      'Nothing was verified here.',
  );
  process.exit(SKIP_EXIT);
}

const files = walk(DIST);
const active = rules.filter((r) => !BUNDLE_EXEMPT.has(r.label));
let fails = 0;

for (const rule of active) {
  const rx = new RegExp(rule.pattern, rule.flags);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'latin1');
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text)) !== null) {
      const at = Math.max(0, m.index - 40);
      hits.push({
        file: relative(APP_DIR, file),
        snippet: text.slice(at, m.index + m[0].length + 40).replace(/\s+/g, ' '),
      });
      if (hits.length >= 5) break;
      if (m.index === rx.lastIndex) rx.lastIndex += 1; // guard against zero-width
    }
    if (hits.length >= 5) break;
  }
  if (hits.length) {
    fails += 1;
    console.log(`FAIL  [${rule.label}] ${hits.length} hit(s):`);
    for (const h of hits) console.log(`        ${h.file}: …${h.snippet}…`);
  } else {
    console.log(`ok    [${rule.label}]`);
  }
}

console.log(`note: read ${active.length} rule(s) from the publish gate; exempted for bundle content: ${[...BUNDLE_EXEMPT].join(', ')}.`);
console.log();
if (fails === 0) {
  console.log(`web bundle: CLEAN — scanned ${files.length} file(s) under ${relative(APP_DIR, DIST)}/`);
  process.exit(0);
} else {
  console.log(`web bundle: BLOCKED — ${fails} categor${fails === 1 ? 'y' : 'ies'} with hits. Do not ship this build.`);
  process.exit(1);
}
