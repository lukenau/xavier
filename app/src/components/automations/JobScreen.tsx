// One automation: what it is, how it may reach the user, and everything it has
// said — newest first, with the runs that added nothing folded.
//
// Run / pause / resume are the same Face-ID-gated writes Ops → Jobs makes
// (`api.applyWrite`); how a job notifies is Hub-owned state behind the chat
// session, so changing it never asks for Face ID.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePoll } from '../../lib/query';
import { useRelockOn401 } from '../../chat/hooks';
import { relTime } from '../../shared/time';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  NOTIFY_CHOICES,
  SNOOZE_CHOICES,
  countsLine,
  deliverLabel,
  jobPills,
  scheduleLine,
  spanLabel,
} from '../../automations/model';
import type { AutomationJob, JobDetailResponse, PrefsInput } from '../../automations/types';
import { ChatLockGate } from '../chat/ChatLockGate';
import { writeErrorMessage } from '../ops/opsFormat';
import {
  Card,
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SectionHead,
  SkeletonCard,
  StatePanel,
  Toast,
  useHideTabBar,
} from '../shell';
import { LOCK_COPY, openRun } from './AutomationsScreen';
import { FoldRow, Pills, RunRow, Segmented } from './parts';

type ActionKind = 'run' | 'pause' | 'resume';

export function BackToAutomations() {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.dismissTo('/automations')}
      accessibilityRole="button"
      accessibilityLabel="Automations"
      style={({ pressed }) => [styles.back, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <SymbolView name="chevron.left" size={15} tintColor={t('accent')} weight="semibold" />
      <Text style={[styles.backLabel, { color: t('accent') }]}>Automations</Text>
    </Pressable>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: t('fg-3') }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: t('fg-1') }]}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  primary,
  disabled,
  onPress,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }
          : { backgroundColor: t('bg-2'), borderColor: t('border-strong') },
        disabled ? styles.dim : null,
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: t(primary ? 'accent' : 'fg-1') }]}>{label}</Text>
    </Pressable>
  );
}

function Controls({ job, onChanged }: { job: AutomationJob; onChanged: () => Promise<unknown> }) {
  const { t } = useTheme();
  const [busy, setBusy] = useState<ActionKind | 'prefs' | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  async function act(kind: ActionKind) {
    if (busy) return;
    setBusy(kind);
    setNote(null);
    try {
      const action = kind === 'run' ? 'cron.run' : kind === 'pause' ? 'cron.pause' : 'cron.resume';
      await api.applyWrite({ action, job_id: job.id });
      setNote({ text: kind === 'run' ? 'Started. Its output lands here when it finishes.' : 'Applied.', bad: false });
      await onChanged();
    } catch (err) {
      const text = writeErrorMessage(err);
      if (text) setNote({ text, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function prefs(input: PrefsInput) {
    if (busy) return;
    setBusy('prefs');
    setNote(null);
    try {
      await api.automationPrefs(job.id, input);
      await onChanged();
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Could not save.', bad: true });
    } finally {
      setBusy(null);
    }
  }

  const scheduled = job.state === 'active' || job.state === 'paused';
  // Running an agent job by hand starts a second process with its own MCP
  // connections, which can become a second OAuth token refresher — and a
  // provider that rotates refresh tokens revokes the grant when two of them
  // race. Scripts carry no such risk; an agent job waits for its schedule.
  const runnable = scheduled && job.mode === 'script';
  const notify = NOTIFY_CHOICES.find((c) => c.id === job.notify) ?? NOTIFY_CHOICES[0];

  return (
    <>
      {scheduled ? (
        <View style={styles.buttons}>
          {runnable ? (
            <Button
              primary
              label={busy === 'run' ? 'Starting…' : 'Run now'}
              disabled={busy !== null}
              onPress={() => void act('run')}
            />
          ) : null}
          <Button
            label={busy === 'pause' || busy === 'resume' ? 'Applying…' : job.state === 'active' ? 'Pause' : 'Resume'}
            disabled={busy !== null}
            onPress={() => void act(job.state === 'active' ? 'pause' : 'resume')}
          />
        </View>
      ) : null}

      {scheduled && !runnable ? (
        <Text style={[styles.hint, styles.agentNote, { color: t('fg-3') }]}>
          An agent job runs on its schedule. Running it by hand can break the logins it uses.
        </Text>
      ) : null}

      <SectionHead label="Notify" />
      <Segmented
        options={NOTIFY_CHOICES.map((c) => ({ id: c.id, label: c.label }))}
        value={notify.id}
        onChange={(id) => void prefs({ notify: id })}
      />
      <Text style={[styles.hint, { color: t('fg-3') }]}>{notify.detail}</Text>

      <SectionHead label="Snooze" />
      {job.snoozed_until ? (
        <View style={styles.buttons}>
          <Text style={[styles.snoozed, { color: t('fg-2') }]}>
            Snoozed, back {relTime(job.snoozed_until)}
          </Text>
          <Button label="End snooze" disabled={busy !== null} onPress={() => void prefs({ clear_snooze: true })} />
        </View>
      ) : (
        <View style={styles.buttons}>
          {SNOOZE_CHOICES.map((choice) => (
            <Button
              key={choice.hours}
              label={choice.label}
              disabled={busy !== null}
              onPress={() => void prefs({ snooze_hours: choice.hours })}
            />
          ))}
        </View>
      )}

      {note ? (
        <Text
          accessibilityRole={note.bad ? 'alert' : undefined}
          style={[styles.note, { color: t(note.bad ? 'status-down' : 'status-up') }]}
        >
          {note.text}
        </Text>
      ) : null}
    </>
  );
}

export function JobSurface({ jobId }: { jobId: string }) {
  useHideTabBar();
  const { t } = useTheme();
  const qc = useQueryClient();
  const query = usePoll<JobDetailResponse>(['automation-job', jobId], () => api.automationJob(jobId), {
    refetchInterval: 30_000,
  });
  const [failure, setFailure] = useState<unknown>(null);
  useRelockOn401(query.error);
  useRelockOn401(failure);
  const job = query.data?.job;
  const items = query.data?.items ?? [];

  async function changed() {
    await query.refetch();
    await qc.invalidateQueries({ queryKey: ['automations'] });
    await qc.invalidateQueries({ queryKey: ['automations-badge'] });
  }

  async function readAll() {
    try {
      await api.automationMarkRead(jobId);
      await changed();
    } catch (err) {
      setFailure(err);
    }
  }

  return (
    <Screen
      header={
        <>
          <BackToAutomations />
          <PageTitle right={<RefreshControl queries={[query]} />}>{job?.name ?? 'Automation'}</PageTitle>
        </>
      }
    >
      {query.isLoading && !query.data ? <SkeletonCard height={220} /> : null}
      {query.isError ? (
        <StatePanel tone="error" title="Automation unavailable" detail={query.error?.message} />
      ) : null}

      {job ? (
        <>
          <Card style={styles.meta}>
            <Text style={[styles.schedule, { color: t('fg-2') }]}>{scheduleLine(job) || 'No schedule'}</Text>
            <Pills pills={jobPills(job)} />
            <View style={styles.fields}>
              {job.next_run_at ? <Field label="next run" value={relTime(job.next_run_at)} /> : null}
              <Field label="sends to" value={deliverLabel(job.deliver)} />
              <Field label="last 30 days" value={countsLine(job)} />
              {job.last_error ? <Field label="last error" value={job.last_error} /> : null}
            </View>
            {job.origin_thread ? (
              <Pressable
                accessibilityRole="link"
                onPress={() =>
                  router.push({ pathname: '/chat/thread', params: { threadId: job.origin_thread?.id ?? '' } })
                }
                style={({ pressed }) => [pressed && { opacity: PRESSED_OPACITY }]}
              >
                <Text style={[styles.origin, { color: t('accent') }]} numberOfLines={1}>
                  Set up in: {job.origin_thread.title?.trim() || 'a chat'}
                </Text>
              </Pressable>
            ) : null}
          </Card>

          <Controls job={job} onChanged={changed} />

          <SectionHead
            label="Runs"
            action={
              job.unread > 0 || job.needs_you ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Mark all read" onPress={() => void readAll()}>
                  <Text style={[styles.readAll, { color: t('accent') }]}>Mark all read</Text>
                </Pressable>
              ) : undefined
            }
          />
          {items.length === 0 ? (
            <StatePanel tone="neutral" title="No runs on record" detail="This job has not run yet." />
          ) : null}
          {items.map((item) =>
            item.kind === 'run' ? (
              <RunRow key={item.run.run_id} run={item.run} named={false} onPress={() => openRun(item.run.run_id)} />
            ) : (
              <FoldRow key={`${item.span}-${item.from}`} label={spanLabel(item)} />
            ),
          )}
        </>
      ) : null}
      {failure ? (
        <Toast kind="err" text={failure instanceof Error ? failure.message : 'Could not mark read.'} onDone={() => setFailure(null)} />
      ) : null}
    </Screen>
  );
}

export default function JobScreen() {
  const { jobId } = useLocalSearchParams<{ jobId?: string }>();
  if (!jobId) {
    return (
      <Screen header={<BackToAutomations />}>
        <StatePanel tone="error" title="No automation" detail="This link is missing a job id." />
      </Screen>
    );
  }
  return (
    <ChatLockGate
      header={
        <>
          <BackToAutomations />
          <PageTitle>Automation</PageTitle>
        </>
      }
      copy={LOCK_COPY}
      unlockLabel="Unlock automations"
    >
      <JobSurface jobId={jobId} />
    </ChatLockGate>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingBottom: 8, alignSelf: 'flex-start' },
  backLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  meta: { marginBottom: 12, gap: 8 },
  schedule: { fontFamily: fonts.mono(400), fontSize: 11.5, ...MONO_FEATURES },
  fields: { gap: 6 },
  field: { flexDirection: 'row', gap: 12 },
  fieldLabel: { width: 92, fontFamily: fonts.mono(400), fontSize: 10.5, paddingTop: 2 },
  fieldValue: { flex: 1, minWidth: 0, fontFamily: fonts.sans(400), fontSize: 13, lineHeight: 18 },
  origin: { fontFamily: fonts.sans(500), fontSize: 13 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  button: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  buttonLabel: { fontFamily: fonts.sans(550), fontSize: 13.5 },
  dim: { opacity: 0.6 },
  agentNote: { marginTop: -4 },
  hint: { fontFamily: fonts.sans(400), fontSize: 12, marginTop: -6, marginBottom: 10, paddingHorizontal: 4 },
  snoozed: { flex: 2, fontFamily: fonts.sans(400), fontSize: 13 },
  note: { fontFamily: fonts.sans(400), fontSize: 12.5, textAlign: 'center', marginBottom: 10 },
  readAll: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.3 },
});
