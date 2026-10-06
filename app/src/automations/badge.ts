// The Automations tab's badge: how many jobs need the user.
//
// Its own tiny read (GET /api/automations/badge), on the same footing as the
// Home feed: no chat cookie, so the number is right while the session is
// locked and an alert that lands mid-afternoon is not invisible until Face ID.
import { api } from '../lib/api';
import { usePoll } from '../lib/query';

export function useAutomationsBadge(): number {
  const query = usePoll<{ needs_you: number }>(['automations-badge'], api.automationsBadge, {
    refetchInterval: 60_000,
    retry: false,
  });
  return query.data?.needs_you ?? 0;
}
