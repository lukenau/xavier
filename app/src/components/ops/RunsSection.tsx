// Ops.tsx:456-509 — the cron log tail (10 newest runs) and the run-output
// sheet behind each row.
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { UseQueryResult } from '@tanstack/react-query';
import { SectionHead, StatePanel } from '../shell';
import { DetailSheet, statusToneColor } from '../system/DetailSheet';
import { OpsCard, OPS_PRESSED } from './parts';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { CronRun } from '../../lib/types';

export function RunsSection({ q }: { q: UseQueryResult<CronRun[], Error> }) {
  const { t } = useTheme();
  const [selected, setSelected] = useState<CronRun | null>(null);
  const runs = q.data ?? [];

  return (
    <View style={styles.section}>
      <SectionHead label="Recent runs" count={q.data ? `${runs.length}` : ''} />
      {q.isLoading ? (
        <StatePanel tone="pending" title="Reading run log…" detail="job run history" />
      ) : null}
      {q.isError ? <StatePanel tone="error" title="Run log unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data && runs.length === 0 ? (
        <StatePanel tone="neutral" title="No runs yet" detail="No cron runs recorded." />
      ) : null}
      {q.data && runs.length > 0 ? (
        <OpsCard>
          {runs.map((r, i) => (
            <Pressable
              key={`${r.job_id ?? 'run'}-${r.run_time ?? i}`}
              onPress={() => setSelected(r)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.row,
                i === runs.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
                pressed && { opacity: OPS_PRESSED },
              ]}
            >
              <View style={styles.rowText}>
                <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={1} ellipsizeMode="tail">
                  {r.name ?? r.job_id ?? 'run'}
                </Text>
                <Text style={[styles.meta, { color: t('fg-3') }]} numberOfLines={1} ellipsizeMode="tail">
                  {r.run_time ?? '—'}
                </Text>
              </View>
              <Text style={[styles.status, { color: t(statusToneColor(r.status)) }]}>{r.status ?? '—'}</Text>
            </Pressable>
          ))}
        </OpsCard>
      ) : null}
      {/* scroll={false}: the output box owns the scrolling, so the "truncated"
          footer stays pinned below it. The PWA caps that box at 50dvh inside a
          scrolling sheet body; here it takes the sheet's remaining height. */}
      <DetailSheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        eyebrow="Run"
        title={selected?.name ?? selected?.job_id ?? 'Run'}
        scroll={false}
      >
        <ScrollView
          style={[styles.output, { backgroundColor: t('bg-0'), borderColor: t('border') }]}
          contentContainerStyle={styles.outputContent}
        >
          <Text style={[styles.outputText, { color: t('fg-1') }]}>{selected?.output || 'No output.'}</Text>
        </ScrollView>
        {selected?.truncated ? (
          <Text style={[styles.truncated, { color: t('fg-4') }]}>· output truncated at 4000 chars</Text>
        ) : null}
      </DetailSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(520), fontSize: 14 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  status: { fontFamily: fonts.mono(400), fontSize: 10.5, flexShrink: 0 },
  output: { flex: 1, borderRadius: 12, borderWidth: 1 },
  outputContent: { padding: 12 },
  outputText: { fontFamily: fonts.mono(400), fontSize: 11, lineHeight: 16.5 },
  truncated: { fontFamily: fonts.sans(400), fontSize: 11, marginTop: 6, paddingHorizontal: 4 },
});
