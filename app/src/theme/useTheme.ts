import { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { dark, light, type TokenName } from './tokens.gen';
import { useAppStore, type ThemePref } from '../lib/store';

export type Scheme = 'dark' | 'light';

const TABLES: Record<Scheme, Record<TokenName, string>> = { dark, light };

/** An explicit pick wins; 'system' follows the OS, which is dark when unknown. */
export function resolveScheme(pref: ThemePref, os: string | null | undefined): Scheme {
  if (pref !== 'system') return pref;
  return os === 'light' ? 'light' : 'dark';
}

const VAR_REF = /var\(--([\w-]+)\)/g;

/**
 * Token value for a scheme, with `var(--x)` references resolved against the
 * same scheme. tokens.css composes a few glows and veils out of other tokens;
 * CSS resolves those at paint time, and nothing in RN would.
 */
export function resolveToken(scheme: Scheme, name: TokenName): string {
  const table = TABLES[scheme];
  let value = table[name];
  // Bounded: references are one level deep today, the loop just refuses to
  // care whether that stays true.
  for (let depth = 0; depth < 4 && value.includes('var(--'); depth += 1) {
    value = value.replace(VAR_REF, (whole, ref: string) =>
      ref in table ? table[ref as TokenName] : whole,
    );
  }
  return value;
}

/**
 * Every token resolved once per scheme at module load (H6): `useTheme()` is
 * called by nearly every leaf on the brief — a row is ~12-15 `t()` calls, at
 * 120 rows ~1,700 per render — and each one re-ran resolveToken's `var(--…)`
 * scan from scratch. A shell-level fix (Screen.tsx:33-39's SCREEN_TOP_PAD
 * comment already treats this file as shared infra); the brief is just where
 * it first bites.
 */
const RESOLVED: Record<Scheme, Record<TokenName, string>> = {
  dark: resolveAllTokens('dark'),
  light: resolveAllTokens('light'),
};

function resolveAllTokens(scheme: Scheme): Record<TokenName, string> {
  const table = TABLES[scheme];
  const out = {} as Record<TokenName, string>;
  for (const name of Object.keys(table) as TokenName[]) {
    out[name] = resolveToken(scheme, name);
  }
  return out;
}

export function useTheme() {
  const pref = useAppStore((s) => s.pref);
  const setPref = useAppStore((s) => s.setPref);
  const scheme = resolveScheme(pref, useColorScheme());
  const t = useMemo(() => (name: TokenName) => RESOLVED[scheme][name], [scheme]);
  return { scheme, pref, setPref, t };
}
