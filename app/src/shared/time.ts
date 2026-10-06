// VERBATIM COPY of apps/hub/src/lib/time.ts (PWA). Do not edit by hand:
// scripts/check-shared-parity.mjs compares this file to the source and
// fails on any difference beyond the two allowed transforms — import
// paths, and `var(--token)` rewritten to the bare token name for
// src/theme's resolveToken(). Change the PWA first, then re-copy.
// --- end copy header; everything below is verbatim ---
// One relative-time formatter for the whole app. Nine near-identical copies of
// this lived in Feed, Ops, Home, BrowserCard, XavierCard, SourcesFooter and
// DecisionCards.
//
// the user, 2026-08-08: "instead of x days ago, can you do dates and x days ago".
// Once something is a day or more old, "3d ago" no longer tells you WHICH day,
// so day-scale stamps carry the date too: "Aug 5 · 3d ago". Minutes and hours
// stay bare — a date on something from twelve minutes ago is noise, and the
// clock time is already implied by "now".
//
// Accepts an ISO string or an epoch (seconds, or milliseconds if it is clearly
// too large for seconds) because the call sites disagree about which they hold.
// Future timestamps read forwards ("in 4m") rather than collapsing to
// "just now", which is how next_tick used to misreport every pending check.

export function toMs(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return input > 1e11 ? input : input * 1000; // seconds unless clearly ms
  }
  // ECMAScript parses a date-TIME form with no offset as LOCAL time (date-only
  // forms are UTC), so an offset-less backend timestamp lands in the wrong
  // instant by the reader's UTC offset — and by a DIFFERENT amount on a Mac in
  // ET than on a phone elsewhere. Every backend on this estate emits UTC; read
  // an offset-less datetime as UTC rather than silently skewing it.
  const naiveDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(input);
  const parsed = Date.parse(naiveDateTime ? `${input.replace(' ', 'T')}Z` : input);
  return Number.isNaN(parsed) ? null : parsed;
}

// "Aug 5", or "Aug 5 2025" once the year differs from the year we are in now.
export function dateLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function relTime(input: string | number | null | undefined, now = Date.now()): string {
  const ms = toMs(input);
  if (ms == null) return '';

  const seconds = (now - ms) / 1000;

  if (seconds < 0) {
    const ahead = -seconds;
    if (ahead < 90) return 'in a moment';
    if (ahead < 3600) return `in ${Math.round(ahead / 60)}m`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    return `${dateLabel(ms, now)} · in ${Math.round(ahead / 86400)}d`;
  }

  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;

  // Round, not floor: alongside an explicit date, flooring made 2026-08-04
  // (3.97 days) and 2026-08-05 (3.2 days) both read "3d ago" on the same card.
  const days = Math.round(seconds / 86400);
  return `${dateLabel(ms, now)} · ${days}d ago`;
}
