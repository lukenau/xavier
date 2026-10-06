// A run, and the conversation under it.
//
// Opening a run reads it and makes sure its follow-up thread exists
// (`POST /chat/automations/runs/{id}/open`), so this is always the chat's own
// thread surface with the run drawn above the first message. Xavier receives
// the run's output with the user's first message — hub-api parks it as a note on
// the thread — which is why a reply here is answered with the run in hand and
// a reply in one of the old catch-all threads was not.
import { useEffect, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePoll } from '../../lib/query';
import { useRelockOn401 } from '../../chat/hooks';
import { clockOf } from '../../chat/clock';
import type { ChatMessage } from '../../chat/types';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { quickAsks, runPills } from '../../automations/model';
import type { RunDetail, RunOpenResponse } from '../../automations/types';
import { ChatLockGate } from '../chat/ChatLockGate';
import { MessageBubble } from '../chat/MessageBubble';
import { ThreadSurface } from '../chat/ThreadScreen';
import { PRESSED_OPACITY, PageTitle, Screen, StatePanel, useHideTabBar } from '../shell';
import { LOCK_COPY, openJob } from './AutomationsScreen';
import { BackToAutomations } from './JobScreen';
import { Pills } from './parts';

/** The run as the one message it is, so it is drawn by the same renderer that
 * draws everything else Xavier says — markdown, images and files included. */
export function runAsMessage(run: RunDetail, threadId: string): ChatMessage {
  return {
    id: `run_${run.run_id}`,
    thread_id: threadId,
    seq: 0,
    version: 0,
    role: 'assistant',
    author_type: 'agent',
    run_id: null,
    status: 'complete',
    client_msg_id: null,
    cron_run_id: run.run_id,
    created_at: run.run_time,
    updated_at: run.run_time,
    parts: run.parts,
  };
}

/** The run, drawn as the bubble it is: the head names the job and the time
 * above it, and nothing frames the bubble a second time. */
export function RunCard({ run, threadId }: { run: RunDetail; threadId: string }) {
  const { t } = useTheme();
  const message = useMemo(() => runAsMessage(run, threadId), [run, threadId]);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${run.job_name}, all runs`}
          onPress={() => openJob(run.job_id)}
          style={({ pressed }) => [styles.name, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.nameLabel, { color: t('fg-0') }]} numberOfLines={1}>
            {run.job_name}
          </Text>
        </Pressable>
        <Text style={[styles.when, { color: t('fg-3') }]}>{clockOf(run.run_time)}</Text>
      </View>
      <Pills pills={runPills(run)} />
      {run.parts.length > 0 ? (
        <MessageBubble message={message} />
      ) : (
        <Text style={[styles.empty, { color: t('fg-3') }]}>
          {run.status === 'silent' ? 'This run had nothing to report.' : 'This run left no output.'}
        </Text>
      )}
      {run.truncated ? (
        <Text style={[styles.empty, { color: t('fg-4') }]}>Output cut at 16,000 characters.</Text>
      ) : null}
    </View>
  );
}

export function RunSurface({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const query = usePoll<RunOpenResponse>(['automation-run', runId], () => api.automationOpenRun(runId), {
    refetchInterval: false,
    staleTime: 0,
  });
  useRelockOn401(query.error);

  // Opening it read it: the inbox and the job's own page are out of date.
  const opened = query.data?.run.run_id;
  useEffect(() => {
    if (!opened) return;
    void qc.invalidateQueries({ queryKey: ['automations'] });
    void qc.invalidateQueries({ queryKey: ['automation-job'] });
  }, [opened, qc]);

  if (!query.data) {
    return (
      <HiddenTabBarScreen>
        {query.isError ? (
          <StatePanel tone="error" title="Run unavailable" detail={query.error?.message} />
        ) : (
          <StatePanel tone="pending" title="Opening run…" />
        )}
      </HiddenTabBarScreen>
    );
  }

  const { run, thread } = query.data;
  return (
    <ThreadSurface
      threadId={thread.id}
      lead={<RunCard run={run} threadId={thread.id} />}
      asks={quickAsks(run)}
    />
  );
}

function HiddenTabBarScreen({ children }: { children: ReactNode }) {
  useHideTabBar();
  return <Screen header={<BackToAutomations />}>{children}</Screen>;
}

export default function RunScreen() {
  const { runId } = useLocalSearchParams<{ runId?: string }>();
  if (!runId) {
    return (
      <HiddenTabBarScreen>
        <StatePanel tone="error" title="No run" detail="This link is missing a run id." />
      </HiddenTabBarScreen>
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
      <RunSurface runId={runId} />
    </ChatLockGate>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 2 },
  name: { flex: 1, minWidth: 0 },
  nameLabel: { fontFamily: fonts.sans(600), fontSize: 15 },
  when: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10.5, ...MONO_FEATURES },
  empty: { fontFamily: fonts.sans(400), fontSize: 13 },
});
