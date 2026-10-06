// Pure formatting behind /config/pages (PagesPage.tsx:11-36).
import type { MyPage } from '../../lib/types';

/** The hosted page's path on the hub origin. */
export function pageHref(slug: string): string {
  return `/my-pages/${slug}/`;
}

/** `Sep 8` — or nothing at all when the server reported no mtime. */
export function fmtWhen(mtime: number | null): string {
  if (!mtime) return '';
  return new Date(mtime * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** `daily brief · Sep 8 · /my-pages/briefing-2026-09-08` (PagesPage.tsx:33-36). */
export function pageSub(page: MyPage): string {
  return `${page.kind === 'brief' ? 'daily brief · ' : ''}${fmtWhen(page.mtime)} · /my-pages/${page.slug}`;
}
