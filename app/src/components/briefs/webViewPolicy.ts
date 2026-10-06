// Pure navigation-policy logic for the three brief/trusted-page WebView
// configs (Task 19 brief, docs/research/briefs.md). Kept dependency-free
// (no react-native-webview / expo-web-browser imports) so the trust-boundary
// decisions — the actual security-relevant part of this task — are testable
// under plain jest without touching a native module.
import { HUB_ORIGIN } from '../../lib/api';

export type LoadDecision = 'allow' | 'external' | 'block';

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve a feed/page link against the hub origin — starts from
 * `apps/hub/src/routes/Feed.tsx:26-34`'s `safeHref`, but goes further:
 * `safeHref` only checks the scheme (http/https), which is not enough here.
 * The PWA's iframe carries the server's own CSP sandbox no matter what host
 * it points at, so an off-host page is merely un-sandboxed HTML in a frame
 * with no cookies. BriefWebView has no such backstop for an off-host page —
 * its whole trust model (§ the header comment in BriefWebView.tsx) is
 * "this is *our* server's HTML, serving *our* CSP" — so this function
 * REQUIRES the hub origin, not just an http(s) scheme. `javascript:`,
 * `data:`, and every off-host https(s) URL (including a same-scheme
 * lookalike host) are all rejected. There is currently no legitimate caller
 * that needs an off-host brief URI — if one shows up, it needs its own
 * explicitly-named resolver, not a loosened version of this one.
 */
export function resolveBriefUri(
  link: string | null | undefined,
  origin: string = HUB_ORIGIN,
): string | null {
  if (!link) return null;
  try {
    const parsed = new URL(link, origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.origin !== origin) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * BriefWebView's `onShouldStartLoadWithRequest` policy (docs/research/briefs.md
 * §6). Same-host `/my-pages/*` (brief → email/imessage sub-page → back) and
 * `/api/*` (the dismiss/snooze POST + its 303 redirect) stay inside the
 * WebView — that reproduces "same tab, back arrow". A bare same-origin path
 * outside those two prefixes (e.g. `/`) is deliberately BLOCKED rather than
 * allowed: nothing in a brief should ever load the hub's own app shell inside
 * the sandboxed viewer. Any other `http(s)` URL (a `jump_url` pill) is an
 * external `↗` — handed to expo-web-browser, never loaded in-frame.
 */
export function decideBriefNavigation(url: string, origin: string = HUB_ORIGIN): LoadDecision {
  if (originOf(url) === origin) {
    try {
      const { pathname } = new URL(url);
      if (pathname.startsWith('/my-pages/') || pathname.startsWith('/api/')) return 'allow';
    } catch {
      // fall through to block
    }
    return 'block';
  }
  return /^https?:\/\//i.test(url) ? 'external' : 'block';
}

/**
 * TrustedPageView's policy (/oura and any future `hub/www` static page):
 * same-origin navigation stays in the WebView (including the page's own
 * `hubback` link to `/`, which is same-origin by design — see task-19-report
 * "device checklist" for the resulting UX note); anything off-host is
 * external.
 */
export function decideTrustedNavigation(url: string, origin: string = HUB_ORIGIN): LoadDecision {
  if (originOf(url) === origin) return 'allow';
  return /^https?:\/\//i.test(url) ? 'external' : 'block';
}

/**
 * BrowserLiveView's policy: the WebView is locked to exactly the Browserbase
 * `live_url` it was given — a remote-controlled session, so any navigation
 * away (including to another http(s) URL) is blocked outright rather than
 * handed to expo-web-browser; there is no legitimate "external" case here.
 */
export function decideLiveViewNavigation(url: string, liveUrl: string): LoadDecision {
  return url === liveUrl ? 'allow' : 'block';
}
