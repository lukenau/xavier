// Ops.tsx:263-454 — Hermes cron jobs, with the gated run / pause / resume
// actions in the detail sheet.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { SectionHead, SheetFields, StatePanel } from '../shell';
import { DetailSheet } from '../system/DetailSheet';
import { ChevronRight, OpsCard, OPS_PRESSED } from './parts';
import { jobDotToken, jobMeta, lastRunCostLine, weekCostLabel, writeErrorMessage } from './opsFormat';
import { api } from '../../lib/api';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { CronJob, CronReport } from '../../lib/types';

type ActionKind = 'run' | 'pause' | 'resume';

function JobSheet({ job, onClose }: { job: CronJob | null; onClose: () => void }) {
  const { t } = useTheme();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  useEffect(() => {
    setBusy(null);
    setError(null);
    setApplied(null);
  }, [job?.id]);

  async function act(kind: ActionKind) {
    if (!job || busy) return;
    setBusy(kind);
    setError(null);
    setApplied(null);
    try {
      const action = kind === 'run' ? 'cron.run' : kind === 'pause' ? 'cron.pause' : 'cron.resume';
      const res = await api.applyWrite({ action, job_id: job.id });
      setApplied(`applied · exit ${res.code ?? 0}`);
      await qc.invalidateQueries({ queryKey: ['cron'] });
      await qc.invalidateQueries({ queryKey: ['cron-logs'] });
    } catch (err) {
      const msg = writeErrorMessage(err);
      if (msg) setError(msg);
    } finally {
      setBusy(null);
    }
  }

  const toggleable = job?.state === 'active' || job?.state === 'paused';

  return (
    <DetailSheet visible={job !== null} onClose={onClose} eyebrow="Job" title={job?.name ?? job?.id ?? ''}>
      <SheetFields
        fields={[
          { label: 'Schedule', value: job?.schedule, mono: true },
          { label: 'Next run', value: job?.next_run_at, mono: true },
          { label: 'Deliver', value: job?.deliver },
          { label: 'Mode', value: job?.mode },
          { label: 'State', value: job?.state },
          { label: 'Last run', value: job?.last_run, mono: true },
          { label: 'Last cost', value: job ? lastRunCostLine(job)?.replace(/^last run: /, '') : null, mono: true },
          { label: 'This week', value: job ? weekCostLabel(job)?.replace(/^7d: /, '') : null, mono: true },
        ]}
      />
      <View style={styles.buttons}>
        <Pressable
          onPress={() => act('run')}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null }}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
            busy !== null ? styles.buttonDim : null,
            pressed && { opacity: OPS_PRESSED },
          ]}
        >
          <Text style={[styles.buttonPrimaryLabel, { color: t('accent') }]}>
            {busy === 'run' ? 'Running…' : 'Run now'}
          </Text>
        </Pressable>
        {toggleable && job ? (
          <Pressable
            onPress={() => act(job.state === 'active' ? 'pause' : 'resume')}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy !== null }}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: t('bg-2'), borderColor: t('border-strong') },
              busy !== null ? styles.buttonDim : null,
              pressed && { opacity: OPS_PRESSED },
            ]}
          >
            <Text style={[styles.buttonSecondaryLabel, { color: t('fg-1') }]}>
              {busy === 'pause' || busy === 'resume'
                ? 'Applying…'
                : job.state === 'active'
                  ? 'Pause'
                  : 'Resume'}
            </Text>
          </Pressable>
        ) : null}
        {applied ? <Text style={[styles.applied, { color: t('status-up') }]}>{applied}</Text> : null}
        {error ? <Text style={[styles.error, { color: t('status-down') }]}>{error}</Text> : null}
      </View>
    </DetailSheet>
  );
}

export function JobsSection({ q }: { q: UseQueryResult<CronReport, Error> }) {
  const { t } = useTheme();
  const [selected, setSelected] = useState<CronJob | null>(null);
  const jobs = q.data?.jobs ?? [];

  return (
    <View style={styles.section}>
      <SectionHead label="Jobs" count={q.data ? `${q.data.count}` : ''} />
      {q.isLoading ? (
        <StatePanel tone="pending" title="Reading jobs…" detail="scheduled jobs" />
      ) : null}
      {q.isError ? <StatePanel tone="error" title="Cron unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data && jobs.length === 0 ? (
        <StatePanel tone="neutral" title="No jobs" detail="No cron jobs are scheduled." />
      ) : null}
      {q.data && jobs.length > 0 ? (
        <OpsCard>
          {jobs.map((j, i) => {
            const cost = lastRunCostLine(j);
            return (
              <Pressable
                key={j.id}
                onPress={() => setSelected(j)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.row,
                  i === jobs.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
                  pressed && { opacity: OPS_PRESSED },
                ]}
              >
                <View style={[styles.dot, { backgroundColor: t(jobDotToken(j)) }]} />
                <View style={styles.rowText}>
                  <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={1} ellipsizeMode="tail">
                    {j.name ?? j.id}
                  </Text>
                  <Text style={[styles.meta, { color: t('fg-3') }]} numberOfLines={1} ellipsizeMode="tail">
                    {jobMeta(j) || '—'}
                  </Text>
                  {cost ? (
                    <Text style={[styles.meta, { color: t('fg-4') }]} numberOfLines={1} ellipsizeMode="tail">
                      {cost}
                    </Text>
                  ) : null}
                </View>
                <ChevronRight />
              </Pressable>
            );
          })}
        </OpsCard>
      ) : null}
      <JobSheet job={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0 },
  dot: { width: 7, height: 7, borderRadius: 3.5, flexShrink: 0 },
  title: { fontFamily: fonts.sans(520), fontSize: 15 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  buttons: { flexDirection: 'column', gap: 8, marginTop: 12 },
  button: { minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  buttonDim: { opacity: 0.6 },
  buttonPrimaryLabel: { fontFamily: fonts.sans(600), fontSize: 14 },
  buttonSecondaryLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  applied: { fontFamily: fonts.mono(400), fontSize: 11, textAlign: 'center', ...MONO_FEATURES },
  error: { fontFamily: fonts.sans(400), fontSize: 12, textAlign: 'center' },
});
