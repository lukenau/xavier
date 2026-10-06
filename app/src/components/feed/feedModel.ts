// Pure Feed logic, ported line-for-line from apps/hub/src/routes/Feed.tsx
// (docs/inventory/feed.md §1). Everything here is a decision the screen makes
// about an item — which chip it belongs to, whether it can be opened, which
// tone its glyph and second line carry — kept out of the component so it can
// be tested without a renderer.
import type { SFSymbol } from 'expo-symbols';
import { HUB_ORIGIN } from '../../lib/api';
import type { FeedItem, FeedKind } from '../../lib/types';
import type { TokenName } from '../../theme/tokens.gen';

/** Feed.tsx:24. Same key the PWA writes, so a device that ran both agrees. */
export const LAST_SEEN_KEY = 'hub-feed-seen-ts';

export type FeedFilter = FeedKind | 'all';

/** Feed.tsx:16-22. Four chips for five kinds: `report` and `status` have none,
 * so those cards are reachable only under All (PARITY-INVENTORY FEED-03). */
export const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'brief', label: 'Briefs' },
  { id: 'run', label: 'Runs' },
  { id: 'alert', label: 'Alerts' },
];

/** Feed.tsx:128-131 — client-side, on the full unsorted-by-us server list. */
export function filterItems(items: FeedItem[], filter: FeedFilter): FeedItem[] {
  return filter === 'all' ? items : items.filter((i) => i.kind === filter);
}

/** Feed.tsx:181 — literal `No ${filter}s`, pluralisation included ("No runs"). */
export function emptyTitle(filter: FeedFilter): string {
  return filter === 'all' ? 'Nothing yet' : `No ${filter}s`;
}

/** Feed.tsx:65. A brief needs a link, a run needs its output, everything else
 * takes either. Non-openable cards render disabled. */
export function isOpenable(item: FeedItem): boolean {
  if (item.kind === 'brief') return Boolean(item.link);
  if (item.kind === 'run') return Boolean(item.summary);
  return Boolean(item.link || item.summary);
}

/** Feed.tsx:36-41, as a token name for `t()` rather than a `var(--x)` string. */
export function runToneToken(status: string | null | undefined): TokenName {
  if (!status) return 'fg-4';
  if (/(fail|error)/i.test(status)) return 'status-down';
  if (/silent/i.test(status)) return 'fg-4';
  return 'status-up';
}

/** Feed.tsx:66-71 — the colour of the kind glyph. */
export function kindToneToken(item: FeedItem): TokenName {
  if (item.priority === 'high' || item.kind === 'alert') return 'status-warn';
  if (item.kind === 'brief') return 'accent';
  return 'fg-3';
}

/**
 * Feed.tsx:43-62's six inline Lucide strokes, as their SF Symbols equivalents:
 * book / clock / triangle-exclaim / document / check-circle / trend-line.
 * `KIND_SYMBOL[item.kind]` is total over FeedKind — unlike the PWA's record
 * lookup, an unknown kind off the wire cannot render "no glyph" here because
 * the caller falls back explicitly (see FeedCard).
 */
export const KIND_SYMBOL: Record<FeedKind, SFSymbol> = {
  brief: 'book',
  run: 'clock',
  alert: 'exclamationmark.triangle',
  report: 'doc.text',
  status: 'checkmark.circle',
};

/**
 * Feed.tsx:26-34's `safeHref`, for the ONE thing the PWA uses it for that is
 * not the brief viewer: the sheet's `open link →` anchor, which leaves the app
 * for a browser (`target="_blank"` there, `expo-web-browser` here).
 *
 * Deliberately NOT `resolveBriefUri`. That one requires the hub origin because
 * whatever it returns is mounted in BriefWebView, where an off-host page would
 * lose the server CSP that makes agent HTML safe to render. This one hands the
 * URL to the system browser instead — a separate browsing context with none of
 * the app's credentials — so it keeps the PWA's scheme-only rule (http(s) yes,
 * `javascript:`/`data:` no) and still resolves origin-relative links, which is
 * what makes the live `"link": "/"` finance alerts behave as they do today.
 * Two different destinations, two explicitly-named resolvers; do not collapse
 * them (task-19-report.md, "Pure policy layer").
 */
export function externalFeedHref(
  link: string | null | undefined,
  origin: string = HUB_ORIGIN,
): string | null {
  if (!link) return null;
  try {
    const parsed = new URL(link, origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Feed.tsx:107-111 — the second line, shown only when there is something in
 * it. Runs show their status (colour-coded); everything else its summary. */
export function secondLine(item: FeedItem): { text: string; tone: TokenName } | null {
  if (!item.summary && !item.status) return null;
  if (item.kind === 'run') {
    return { text: item.status ?? 'no status', tone: runToneToken(item.status) };
  }
  return item.summary ? { text: item.summary, tone: 'fg-3' } : null;
}
