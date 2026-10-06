// 1:1 port of apps/hub/src/routes/Ops.tsx.
//
// Ops — "what has Xavier been doing, does anything need me". Jump-offs first,
// then pending pairings (the only thing that blocks someone), session history,
// the Claude shells, cron jobs with gated run/pause, recent run output, a
// one-line board pulse, and jump-offs to Terminal / Files.
//
// Two approved deviations from the PWA (the user, 2026-09): Feed is no longer a
// tab, so the top jump-off card gains a Feed row above Agent spend; and the
// Terminal entry point moves up into that card, at the top of the page
// (2026-09-22).
import { PageTitle, RefreshControl, Screen } from '../shell';
import { NavCard, type NavRow } from './NavCard';
import { NeedsYou } from './NeedsYou';
import { SessionsSection } from './SessionsSection';
import { ShellsSection } from './ShellsSection';
import { JobsSection } from './JobsSection';
import { RunsSection } from './RunsSection';
import { BackupsSection } from './BackupsSection';
import { BoardLine } from './BoardLine';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';

/** The top jump-off card, in order. */
export const OPS_NAV_ROWS: NavRow[] = [
  { href: '/ops/feed', label: 'Feed', sub: 'briefs & cards from Xavier' },
  { href: '/ops/cost', label: 'Agent spend', sub: 'model + cron cost · windows & trends' },
  { href: '/ops/terminal', label: 'Terminal', sub: 'tmux hub-term · Face ID gate' },
];

export function OpsScreen() {
  const pairing = usePoll(['pairing'], api.pairing, QUERY_TUNING['pairing-ops']);
  // The cross-thread attention read, so the Needs-you section can show the
  // iMessage drafts waiting on a send/discard alongside pairing approvals. Read
  // here rather than inside NeedsYou so the screen's own refresh control can
  // invalidate it with the rest of the page.
  const chatAttention = usePoll(['chat-attention'], api.chatAttention, { refetchInterval: 60_000 });
  const sessions = usePoll(['sessions'], api.sessions, QUERY_TUNING['sessions-ops']);
  const cron = usePoll(['cron'], api.cron, QUERY_TUNING.cron);
  const cronLogs = usePoll(['cron-logs'], () => api.cronLogs(10), QUERY_TUNING['cron-logs-ops']);
  const kanban = usePoll(['kanban'], api.kanban, QUERY_TUNING.kanban);
  const shells = usePoll(['tmux-sessions'], api.tmuxSessions, QUERY_TUNING['tmux-sessions']);
  const backups = usePoll(['backups'], api.backups, QUERY_TUNING.backups);

  return (
    <Screen
      header={
        <PageTitle
          right={<RefreshControl queries={[pairing, sessions, cron, cronLogs, kanban, shells, backups]} />}
        >
          Ops
        </PageTitle>
      }
    >
      <NavCard rows={OPS_NAV_ROWS} style={{ marginBottom: 10 }} />
      <NeedsYou q={pairing} attention={chatAttention} />
      <SessionsSection q={sessions} />
      <ShellsSection q={shells} />
      <JobsSection q={cron} />
      <RunsSection q={cronLogs} />
      <BackupsSection q={backups} />
      <BoardLine q={kanban} />
      <NavCard
        rows={[
          { href: '/ops/files', label: 'Files', sub: 'code · hub data · read-only' },
        ]}
        style={{ marginTop: 14 }}
      />
    </Screen>
  );
}

export default OpsScreen;
