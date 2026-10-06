// Pure logic behind /config/routing (RoutingPage.tsx:21-65, 243-262): the
// curated job labels, the target options, and the edit-staging arithmetic.
import type { TopicsConfig } from '../../lib/types';

export const FRIENDLY: Record<string, { label: string; sub: string }> = {
  'Daily Briefing — Personal': { label: 'Daily briefing', sub: 'personal · 7:35 daily' },
  'ops-watch': { label: 'Ops watch', sub: 'nightly estate check · 21:00' },
  'cron-watch': { label: 'Cron watch', sub: 'job-failure sweep · every 30m' },
  'credit-watch': { label: 'Credit watch', sub: 'API credit balances · 9:00' },
  'insights-weekly': { label: 'Weekly insights', sub: 'Mondays 8:00' },
  'security-monthly': { label: 'Security review', sub: 'monthly · 1st 8:00' },
  'advisor-tool-upstream-watch': { label: 'Advisor upstream watch', sub: 'Mondays 10:00' },
  'notes-sync-supermemory': { label: 'Notes-sync → Supermemory', sub: 'daily 18:00' },
  'ambient-capture': { label: 'Ambient capture', sub: 'every 2h · 8–22' },
  'finance-snapshot': { label: 'Finance snapshot', sub: '3×/day' },
  'test-rich': { label: 'Test (rich)', sub: 'dormant test job' },
  'Scuffers return reply watch': { label: 'Scuffers reply watch', sub: 'hourly' },
  healthcheck: { label: 'Healthcheck alerts', sub: 'host script · every 5m' },
  'imessage-approvals': { label: 'iMessage approvals', sub: 'compose draft notices' },
};

export function friendly(name: string): { label: string; sub: string } {
  return FRIENDLY[name] ?? { label: name, sub: 'cron job' };
}

export function topicLabel(key: string, thread?: number): string {
  const cap = key.charAt(0).toUpperCase() + key.slice(1);
  return thread ? `${cap} · ${thread}` : cap;
}

export interface TargetOption {
  value: string;
  label: string;
}

/** The `<select>`'s option list (RoutingPage.tsx:143-149): every topic, then
 * the two pseudo-targets. */
export function targetOptions(topics: Record<string, number>): TargetOption[] {
  return [
    ...Object.entries(topics).map(([key, thread]) => ({ value: key, label: topicLabel(key, thread) })),
    { value: 'dm', label: 'DM (no topic)' },
    { value: 'local', label: 'Local (no send)' },
  ];
}

/** Selecting the ORIGINAL target drops the edit; anything else records it.
 * Unlike ConfigSectionPage, several routes can be edited before one save. */
export function stageEdit(
  edits: Record<string, string>,
  name: string,
  target: string,
  routes: Record<string, string>,
): Record<string, string> {
  const next = { ...edits };
  if ((routes[name] ?? '') === target) delete next[name];
  else next[name] = target;
  return next;
}

/** The edits that actually differ from the saved config (RoutingPage.tsx:248-250). */
export function changedEntries(
  edits: Record<string, string>,
  routes: Record<string, string>,
): [string, string][] {
  return Object.entries(edits).filter(([name, target]) => (routes[name] ?? '') !== target);
}

/** The save payload: the whole routes map with the changed entries applied. */
export function savePayload(config: TopicsConfig, changed: [string, string][]): TopicsConfig {
  return {
    chat_id: config.chat_id,
    topics: config.topics,
    routes: { ...config.routes, ...Object.fromEntries(changed) },
  };
}

/** " Drift checked 14:05:00." — appended to the footer only when the live
 * snapshot exists (RoutingPage.tsx:354). */
export function driftCheckedSuffix(liveSnapshotAt: string | null): string {
  return liveSnapshotAt ? ` Drift checked ${new Date(liveSnapshotAt).toLocaleTimeString()}.` : '';
}

export function footerNote(topicCount: number, liveSnapshotAt: string | null): string {
  return (
    `Topics live in the Telegram DM (${topicCount} configured). ` +
    '“Local” keeps a job\'s output in the Hub feed only. Healthcheck + iMessage approvals ' +
    'are host-side senders that read the same config.' +
    driftCheckedSuffix(liveSnapshotAt)
  );
}

export function pluralRoutes(n: number, verb: string): string {
  return `${n} route${n === 1 ? '' : 's'} ${verb}`;
}
