// Automations tab root — what Xavier's scheduled jobs have said, grouped by the
// job that said it.
//
// Two views of the same runs. "By automation" is one row per job showing its
// latest word, sectioned Needs you / New / Still open / Up to date with the jobs that have
// nothing to say folded at the foot. "Timeline" is strict time order, a day at
// a time, with the runs that reported nothing counted on one line. Both sit
// behind the chat session: a run's output is the same material a thread holds.
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePoll } from '../../lib/query';
import { useRelockOn401 } from '../../chat/hooks';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  CATEGORY_FILTERS,
  EARLIER_SHOWN,
  clusterFailures,
  dayLabel,
  groupJobs,
  quietSummary,
  quietTotal,
  type CategoryFilter,
} from '../../automations/model';
import type { AutomationJob, AutomationsResponse, TimelineDay, TimelineResponse } from '../../automations/types';
import { ChatLockGate } from '../chat/ChatLockGate';
import { PageTitle, RefreshControl, Screen, SectionHead, SkeletonCard, StatePanel, Toast } from '../shell';
import { Chips, ClusterRow, FoldRow, HeaderChip, JobRow, RunRow, Segmented } from './parts';

type View_ = 'jobs' | 'timeline';

const VIEWS: { id: View_; label: string }[] = [
  { id: 'jobs', label: 'By automation' },
  { id: 'timeline', label: 'Timeline' },
];

export const LOCK_COPY =
  'What your scheduled jobs reported. Unlock with Face ID — the session stays live for an hour.';

export function openJob(jobId: string) {
  router.push({ pathname: '/automations/job', params: { jobId } });
}

export function openRun(runId: string) {
  router.push({ pathname: '/automations/run', params: { runId } });
}

function statusLine(counts: AutomationsResponse['counts'] | undefined): string {
  if (!counts) return '';
  const parts = [];
  if (counts.needs_you > 0) parts.push(`${counts.needs_you} ${counts.needs_you === 1 ? 'needs' : 'need'} you`);
  if (counts.unread > 0) parts.push(`${counts.unread} new`);
  return parts.length > 0 ? parts.join(' · ') : `${counts.jobs} automations, nothing new`;
}

function Section({ label, jobs }: { label: string; jobs: AutomationJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <>
      <SectionHead label={label} count={`${jobs.length}`} />
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} onPress={() => openJob(job.id)} />
      ))}
    </>
  );
}

/** Needs you, with jobs failing one way gathered into one row that opens. */
function NeedsYou({ jobs }: { jobs: AutomationJob[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const entries = useMemo(() => clusterFailures(jobs), [jobs]);
  if (jobs.length === 0) return null;
  return (
    <>
      <SectionHead label="Needs you" count={`${jobs.length}`} />
      {entries.map((entry) =>
        entry.kind === 'job' ? (
          <JobRow key={entry.job.id} job={entry.job} onPress={() => openJob(entry.job.id)} />
        ) : (
          <View key={entry.key}>
            <ClusterRow
              count={entry.jobs.length}
              preview={entry.preview}
              open={open === entry.key}
              onPress={() => setOpen((k) => (k === entry.key ? null : entry.key))}
            />
            {open === entry.key
              ? entry.jobs.map((job) => <JobRow key={job.id} job={job} onPress={() => openJob(job.id)} />)
              : null}
          </View>
        ),
      )}
    </>
  );
}

function UpToDate({ jobs }: { jobs: AutomationJob[] }) {
  const [all, setAll] = useState(false);
  if (jobs.length === 0) return null;
  const shown = all ? jobs : jobs.slice(0, EARLIER_SHOWN);
  return (
    <>
      <SectionHead label="Up to date" count={`${jobs.length}`} />
      {shown.map((job) => (
        <JobRow key={job.id} job={job} onPress={() => openJob(job.id)} />
      ))}
      {jobs.length > EARLIER_SHOWN ? (
        <FoldRow
          label={all ? 'Show fewer' : `${jobs.length - EARLIER_SHOWN} more, older`}
          onPress={() => setAll((v) => !v)}
        />
      ) : null}
    </>
  );
}

function JobsView({ jobs, filter }: { jobs: AutomationJob[]; filter: CategoryFilter }) {
  const [showQuiet, setShowQuiet] = useState(false);
  const sections = useMemo(() => groupJobs(jobs, filter), [jobs, filter]);
  const shown =
    sections.needsYou.length + sections.fresh.length + sections.stillOpen.length + sections.upToDate.length;

  return (
    <>
      {shown === 0 && sections.quiet.length === 0 ? (
        <StatePanel
          tone="neutral"
          title="Nothing here"
          detail="No automation in this group has run yet."
        />
      ) : null}
      <NeedsYou jobs={sections.needsYou} />
      <Section label="New" jobs={sections.fresh} />
      <Section label="Still open" jobs={sections.stillOpen} />
      <UpToDate jobs={sections.upToDate} />
      {sections.quiet.length > 0 ? (
        <>
          <SectionHead label="Quiet" count={`${sections.quiet.length}`} />
          <FoldRow
            label={
              showQuiet
                ? 'Background jobs, muted or ended ones, and jobs with nothing to report'
                : `${sections.quiet.length} automations with nothing to report`
            }
            detail={showQuiet ? 'Tap to fold' : 'Tap to show'}
            onPress={() => setShowQuiet((v) => !v)}
          />
          {showQuiet
            ? sections.quiet.map((job) => <JobRow key={job.id} job={job} onPress={() => openJob(job.id)} />)
            : null}
        </>
      ) : null}
    </>
  );
}

function DayBlock({ day, filter }: { day: TimelineDay; filter: CategoryFilter }) {
  const runs = filter === 'all' ? day.runs : day.runs.filter((r) => r.category === filter);
  // The quiet line counts every job, so it only belongs to the unfiltered day.
  const quiet = filter === 'all' ? day.quiet : [];
  if (runs.length === 0 && quiet.length === 0) return null;
  return (
    <>
      <SectionHead label={dayLabel(day.day)} count={runs.length > 0 ? `${runs.length}` : ''} />
      {runs.map((run) => (
        <RunRow key={run.run_id} run={run} named onPress={() => openRun(run.run_id)} />
      ))}
      {quiet.length > 0 ? (
        <FoldRow label={`${quietTotal(quiet)} runs with nothing to report`} detail={quietSummary(quiet)} />
      ) : null}
    </>
  );
}

function TimelineView({ filter, onFailure }: { filter: CategoryFilter; onFailure: (err: unknown) => void }) {
  const first = usePoll<TimelineResponse>(['automations-timeline'], () => api.automationsTimeline(), {
    refetchInterval: 60_000,
  });
  useRelockOn401(first.error);
  const [older, setOlder] = useState<TimelineDay[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const before = cursor === undefined ? (first.data?.before ?? null) : cursor;

  async function loadOlder() {
    if (!before || loading) return;
    setLoading(true);
    try {
      const page = await api.automationsTimeline(before);
      setOlder((days) => [...days, ...page.days]);
      setCursor(page.before);
    } catch (err) {
      onFailure(err);
    } finally {
      setLoading(false);
    }
  }

  const days = [...(first.data?.days ?? []), ...older];
  return (
    <>
      {first.isLoading && !first.data ? <SkeletonCard height={220} /> : null}
      {first.isError ? <StatePanel tone="error" title="Timeline unavailable" detail={first.error?.message} /> : null}
      {first.data && days.length === 0 ? (
        <StatePanel tone="neutral" title="Nothing in the last week" detail="No job has run in the last seven days." />
      ) : null}
      {days.map((day) => (
        <DayBlock key={day.day} day={day} filter={filter} />
      ))}
      {before ? (
        <FoldRow label={loading ? 'Loading earlier days…' : 'Show earlier days'} onPress={() => void loadOlder()} />
      ) : null}
    </>
  );
}

function Inbox() {
  const { t } = useTheme();
  const qc = useQueryClient();
  const [view, setView] = useState<View_>('jobs');
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [marking, setMarking] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const query = usePoll<AutomationsResponse>(['automations'], api.automations, { refetchInterval: 30_000 });
  useRelockOn401(query.error);
  useRelockOn401(failure);

  // Coming back from a run has read it; the list should say so at once rather
  // than at the next poll.
  const refetch = query.refetch;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const counts = query.data?.counts;
  const pending = (counts?.needs_you ?? 0) + (counts?.unread ?? 0) > 0;

  async function readAll() {
    if (marking) return;
    setMarking(true);
    try {
      await api.automationsReadAll();
      await qc.invalidateQueries({ queryKey: ['automations'] });
      await qc.invalidateQueries({ queryKey: ['automations-timeline'] });
      await qc.invalidateQueries({ queryKey: ['automations-badge'] });
    } catch (err) {
      setFailure(err);
    } finally {
      setMarking(false);
    }
  }

  return (
    <Screen
      header={
        <>
          <PageTitle
            right={
              <View style={styles.headerActions}>
                {pending ? <HeaderChip label="Read all" disabled={marking} onPress={() => void readAll()} /> : null}
                <RefreshControl queries={[query]} />
              </View>
            }
          >
            Automations
          </PageTitle>
          <Text style={[styles.status, { color: t('fg-3') }]} numberOfLines={1}>
            {statusLine(counts)}
          </Text>
        </>
      }
    >
      <Segmented options={VIEWS} value={view} onChange={setView} />
      <Chips options={CATEGORY_FILTERS} value={filter} onChange={setFilter} />

      {view === 'jobs' ? (
        <>
          {query.isLoading && !query.data ? <SkeletonCard height={220} /> : null}
          {query.isError ? (
            <StatePanel tone="error" title="Automations unavailable" detail={query.error?.message} />
          ) : null}
          {query.data ? <JobsView jobs={query.data.jobs} filter={filter} /> : null}
        </>
      ) : (
        <TimelineView filter={filter} onFailure={setFailure} />
      )}
      {failure ? (
        <Toast kind="err" text={failure instanceof Error ? failure.message : 'That did not go through.'} onDone={() => setFailure(null)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: -10, marginBottom: 10 },
});

export default function AutomationsScreen() {
  return (
    <ChatLockGate header={<PageTitle>Automations</PageTitle>} copy={LOCK_COPY} unlockLabel="Unlock automations">
      <Inbox />
    </ChatLockGate>
  );
}
