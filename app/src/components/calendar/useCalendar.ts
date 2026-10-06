// The one calendar query. The whole synced span is fetched under a single key,
// so a change of view or date is a re-slice of what is already in hand and the
// Home card and the screen never ask twice.
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fetchRange } from './calendarModel';

const SYNC_POLL_MS = 20_000;

export function useCalendar(now: Date) {
  return usePoll(
    ['calendar'],
    () => {
      const { from, to } = fetchRange(now);
      return api.calendar(from, to);
    },
    {
      ...QUERY_TUNING.calendar,
      // While a "Sync now" is under way, look again every 20 s so the result
      // lands on screen without a pull.
      refetchInterval: (query) => (query.state.data?.sync_requested_at ? SYNC_POLL_MS : false),
    },
  );
}
