// BrowserCard's derivations (BrowserCard.tsx:13-38,129-170).
//
// `domainOf`/`pathOf` are regex ports rather than `new URL()` ports on
// purpose: the PWA leans on the constructor THROWING to fall back to the raw
// string, and react-native's URL polyfill (Libraries/Blob/URL.js) never
// throws — it returns '' from every getter instead. Parsing the parts here
// keeps the rendered text identical on device and under node.
import type { BrowserSessionLive, BrowserSessionRecent, BrowserSessions } from '../../lib/types';
import { relTime } from '../../shared/time';

/** A recent session stays an entry point for two hours after it ends. */
export const RECENT_FRESH_MS = 2 * 3600_000;
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/?#]+)/i;
const PATH = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i;

export function domainOf(url: string): string {
  const m = ORIGIN.exec(url);
  return m ? m[1].replace(/^www\./, '') : url;
}

export function pathOf(url: string): string {
  const m = PATH.exec(url);
  if (!m) return '';
  const p = m[1] === '/' ? '' : m[1];
  return p.length > 34 ? `${p.slice(0, 33)}…` : p;
}

export function fmtDuration(s: number | null): string {
  if (s == null) return '';
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

export interface BrowserCardView {
  live: BrowserSessionLive | undefined;
  lastRecent: BrowserSessionRecent | undefined;
  title: string;
  subline: string;
  /** Sheet title: 'Live browser' while a session runs, else 'Browsing history'. */
  sheetTitle: string;
}

/**
 * Null data (404 no key / 502 unreachable / still loading) and "nothing ran
 * recently" both mean the card does not exist at all — presence, not status.
 */
export function browserCardView(
  data: BrowserSessions | null | undefined,
  now = Date.now(),
): BrowserCardView | null {
  if (!data) return null;
  const live = data.running[0];
  const lastRecent = data.recent[0];
  const recentFresh =
    lastRecent?.ended_at != null && now - new Date(lastRecent.ended_at).getTime() < RECENT_FRESH_MS;
  if (!live && !recentFresh) return null;
  return {
    live,
    lastRecent,
    // The double space when a recent session captured no pages is the PWA's
    // (inventory OQ-11) — reproduced, not tidied.
    title: live
      ? `browsing ${live.current_url ? domainOf(live.current_url) : 'now'} — watch live`
      : `browsed ${lastRecent?.pages[0] ? domainOf(lastRecent.pages[0]) : ''} ${relTime(lastRecent?.ended_at, now)}`,
    subline: live ? `started ${relTime(live.started_at, now)}` : 'session history →',
    sheetTitle: live ? 'Live browser' : 'Browsing history',
  };
}

/** RecentRow's two halves (BrowserCard.tsx:100-113). */
export function recentRowText(
  session: BrowserSessionRecent,
  now = Date.now(),
): { summary: string; meta: string } {
  const first = session.pages[0];
  return {
    summary: first
      ? `${domainOf(first)}${session.pages.length > 1 ? ` +${session.pages.length - 1}` : ''}`
      : (session.status ?? '').toLowerCase(),
    meta: `${relTime(session.started_at, now)}${session.duration_s != null ? ` · ${fmtDuration(session.duration_s)}` : ''}`,
  };
}
