// Per-user display preferences for the Money tab: names for accounts a bank
// labels uselessly (every card from one issuer called "CREDIT CARD"), and
// colours that keep meaning the same account between refreshes.
//
// Optional, and EMPTY unless the build sets EXPO_PUBLIC_FINANCE_ACCOUNTS, so
// nothing personal lives in the source. Expo inlines EXPO_PUBLIC_* values when
// it bundles the JS, so set it wherever `expo start`, `eas build` or
// `eas update` runs, e.g. in app/.env.local (gitignored):
//
//   EXPO_PUBLIC_FINANCE_ACCOUNTS='{
//     "nicknames": { "0000": "Example Bank Travel" },
//     "last4Colors": { "0000": "series-5" },
//     "institutionColors": { "Example Bank": "series-2" },
//     "institutions": ["Example Bank"]
//   }'
//
// It is JS-only, so an installed build picks up a change from an over-the-air
// update; nothing native moves.
import { dark } from '../theme/tokens.gen';

export interface AccountDisplay {
  /** Account key (the last4 mask, or a maskless slug like "venmo") → the name to show. */
  nicknames: Readonly<Record<string, string>>;
  /** Account key → palette token. Beats `institutionColors`. */
  last4Colors: Readonly<Record<string, string>>;
  /** Institution → palette token, shared by every account there. */
  institutionColors: Readonly<Record<string, string>>;
  /** Full institution names that a truncated one ("Example Ba") snaps back to. */
  institutions: readonly string[];
}

export const NO_ACCOUNT_DISPLAY: AccountDisplay = {
  nicknames: {},
  last4Colors: {},
  institutionColors: {},
  institutions: [],
};

/** An own-property read, so an account key can never resolve to something on
 * Object.prototype ("constructor", "toString"). */
export function lookup(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

const isToken = (name: string) => Object.prototype.hasOwnProperty.call(dark, name);

function stringMap(value: unknown, keep: (v: string) => boolean = () => true): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    if (keep(v.trim())) out[k] = v.trim();
    else console.warn(`EXPO_PUBLIC_FINANCE_ACCOUNTS: "${v}" for "${k}" is not a theme colour token; ignored.`);
  }
  return out;
}

/** Malformed input yields the empty config, never a throw: a typo in a build
 * variable may cost the user their nicknames, but never the Money tab. */
export function parseAccountDisplay(raw: string | undefined): AccountDisplay {
  if (!raw || !raw.trim()) return NO_ACCOUNT_DISPLAY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('EXPO_PUBLIC_FINANCE_ACCOUNTS is not valid JSON; account display preferences ignored.');
    return NO_ACCOUNT_DISPLAY;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_ACCOUNT_DISPLAY;
  const o = parsed as Record<string, unknown>;
  return {
    nicknames: stringMap(o.nicknames),
    last4Colors: stringMap(o.last4Colors, isToken),
    institutionColors: stringMap(o.institutionColors, isToken),
    institutions: Array.isArray(o.institutions)
      ? o.institutions.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
      : [],
  };
}

export const ACCOUNT_DISPLAY: AccountDisplay = parseAccountDisplay(process.env.EXPO_PUBLIC_FINANCE_ACCOUNTS);
