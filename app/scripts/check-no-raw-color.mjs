#!/usr/bin/env node
// Port of apps/hub/scripts/check-no-raw-color.mjs for the native app.
// The theme is only "one file" for as long as nobody reintroduces a literal.
// Fails on any raw hex or numeric rgb()/rgba()/hsl()/hsla() literal under
// src/** and app/**, outside src/theme/ (the generated token table itself).
//
// Escape hatch: put `theme-exempt` in a comment on the line, or anywhere in
// the comment block directly above it, and say why. Legitimate cases are
// values that are not colours — mask channels, for instance, where #000
// means "keep these pixels".
//
//   node scripts/check-no-raw-color.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['theme', 'node_modules']);
// 3, 6 or 8 hex digits — deliberately NOT 4. `#RGBA` is valid CSS but unused in
// this design system (tokens.css is 205 six-digit literals and nothing else),
// while `#3689`-shaped GitHub issue references are common in comments. Matching
// 4 digits made every `webview#3689` citation a lint failure.
const COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\(\s*\d/;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(full);
    return /\.(ts|tsx)$/.test(full) ? [full] : [];
  });

const roots = [join(root, 'src'), join(root, 'app')].filter((dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
});

const findings = [];
for (const base of roots) {
  for (const file of walk(base)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!COLOR.test(line)) return;
      if (/theme-exempt/.test(line)) return;
      // Walk up the contiguous comment block immediately above.
      for (let j = i - 1; j >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[j]); j--) {
        if (/theme-exempt/.test(lines[j])) return;
      }
      findings.push(`${relative(root, file)}:${i + 1}  ${line.trim()}`);
    });
  }
}

if (findings.length) {
  console.error(`FAIL: ${findings.length} raw colour literal(s) outside src/theme/.`);
  console.error('Use a token from src/theme/tokens.ts, or mark the line `theme-exempt` with a reason.\n');
  for (const f of findings) console.error('  ' + f);
  process.exit(1);
}
console.log('ok: no raw colour literals outside src/theme/');
