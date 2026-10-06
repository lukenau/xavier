// Wire types for GET /api/calendar (server/hub_calendar.py).
//
// The snapshot behind it is synced from Superhuman's natural-language query,
// which exposes no RSVP status — so there is deliberately no field for one.

export type CalendarAccount = 'work' | 'personal';

export interface WireEvent {
  id: string;
  title: string;
  account: CalendarAccount;
  all_day: boolean;
  /** RFC3339 with offset. Null on an all-day event. */
  start: string | null;
  end: string | null;
  /** `YYYY-MM-DD`; the end date is exclusive. Null on a timed event. */
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  conference_url: string | null;
  organizer: string | null;
  attendee_count: number | null;
  /** The last sync of its week did not return it. It stays until three in a
   * row have not, so it may be cancelled — or the source may have blinked. */
  unconfirmed: boolean;
}

/** When each account last synced one Monday-aligned week. Null: never. */
export interface CalendarWeek {
  monday: string;
  work: string | null;
  personal: string | null;
}

export interface CalendarWindow {
  from: string;
  to: string;
}

export interface CalendarResponse {
  events: WireEvent[];
  /** Null until the first sync has written a snapshot. */
  synced_at: string | null;
  /** The dates the snapshot covers. Null with no snapshot. */
  window: CalendarWindow | null;
  /** Week-and-account slices the sync has failed to refresh on schedule. */
  stale_slices: number;
  weeks: CalendarWeek[];
  /** Set while a "Sync now" waits for, or is in, its host run. */
  sync_requested_at: string | null;
}
