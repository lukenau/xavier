// One-call entry point for the Feed and Home (PagesShelf) tasks: push the
// brief reader sheet (`app/(home)/sheet.tsx`) with a resolved brief URI.
// Callers should still run `resolveBriefUri` themselves first (fail fast
// with a useful UI state instead of opening a sheet that immediately shows
// "Nothing to show") — but `app/(home)/sheet.tsx` ALSO re-validates every
// `uri` it receives with the same function before it ever reaches
// BriefWebView, regardless of caller. Belt-and-braces on purpose: `/sheet`
// is kept out of `KNOWN_ROUTES` (deepLinks.ts's `INTERNAL_ONLY_ROUTES`) so
// an external `hub://sheet?uri=…` deep link can't reach it at all, but the
// route's own validation does not depend on that door staying shut.
import { openSheet } from '../shell';

export function openBrief(uri: string, title?: string): void {
  openSheet({
    pathname: '/sheet',
    params: title ? { uri, title } : { uri },
  });
}
