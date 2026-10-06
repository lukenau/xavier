// SystemPanel.tsx:402-486 — pass/warn/fail roll-up, issues first, all checks on
// demand. The tally card turns red-washed the moment anything fails.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SectionHead, StatePanel } from '../shell';
import { OpsCard, OPS_PRESSED } from '../ops/parts';
import { DOCTOR_TONE, visibleDoctorSections } from './systemFormat';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { DoctorStatus } from '../../lib/types';

function Tally({ status, n }: { status: DoctorStatus; n: number }) {
  const { t } = useTheme();
  const tone = DOCTOR_TONE[status];
  return (
    <View style={styles.tally}>
      <Text style={[styles.glyph, { color: t(tone.color) }]}>{tone.glyph}</Text>
      <Text style={[styles.count, { color: t('fg-0') }]}>{n}</Text>
      <Text style={[styles.tallyLabel, { color: t('fg-4') }]}>{status}</Text>
    </View>
  );
}

export function DoctorSection() {
  const { t } = useTheme();
  const q = usePoll(['doctor'], api.doctor, QUERY_TUNING.doctor);
  const [showAll, setShowAll] = useState(false);
  const sections = visibleDoctorSections(q.data?.sections ?? [], showAll);

  return (
    <View style={styles.section}>
      <SectionHead label="Doctor" count={q.data ? (q.data.summary.ok ? 'healthy' : 'attention') : ''} />
      {q.isLoading ? (
        <StatePanel tone="pending" title="Running checks…" detail="diagnostic checks" />
      ) : null}
      {q.isError ? <StatePanel tone="error" title="Doctor unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data ? (
        <>
          <View
            style={[
              styles.tallyCard,
              q.data.summary.fail > 0
                ? { backgroundColor: t('status-down-wash'), borderColor: t('status-down-border') }
                : { backgroundColor: t('bg-1'), borderColor: t('border') },
            ]}
          >
            <Tally status="pass" n={q.data.summary.pass} />
            <Tally status="warn" n={q.data.summary.warn} />
            <Tally status="fail" n={q.data.summary.fail} />
          </View>

          {sections.length === 0 ? (
            <StatePanel
              tone="neutral"
              title="All checks passed"
              detail={`${q.data.summary.total} checks, no warnings or failures.`}
            />
          ) : (
            <View style={styles.sectionList}>
              {sections.map((sec) => (
                <OpsCard key={sec.name}>
                  <Text style={[styles.sectionName, { color: t('fg-4') }]}>{sec.name}</Text>
                  <View style={styles.checks}>
                    {sec.checks.map((c, i) => (
                      <View key={i} style={styles.check}>
                        <Text style={[styles.checkGlyph, { color: t(DOCTOR_TONE[c.status].color) }]}>
                          {DOCTOR_TONE[c.status].glyph}
                        </Text>
                        <Text style={[styles.checkLabel, { color: t('fg-2') }]}>{c.label}</Text>
                      </View>
                    ))}
                  </View>
                </OpsCard>
              ))}
            </View>
          )}

          <Pressable
            onPress={() => setShowAll((v) => !v)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.toggle,
              { backgroundColor: t('bg-1'), borderColor: t('border') },
              pressed && { opacity: OPS_PRESSED },
            ]}
          >
            <Text style={[styles.toggleLabel, { color: t('fg-2') }]}>
              {showAll ? 'Show only issues' : `Show all ${q.data.summary.total} checks`}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 8 },
  tallyCard: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  tally: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  glyph: { fontFamily: fonts.sans(400), fontSize: 15 },
  count: { fontFamily: fonts.mono(400), fontSize: 16, ...MONO_FEATURES },
  tallyLabel: { fontFamily: fonts.sans(400), fontSize: 11 },
  sectionList: { flexDirection: 'column', gap: 10 },
  sectionName: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 9,
  },
  checks: { flexDirection: 'column', gap: 7 },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  checkGlyph: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 16.2, flexShrink: 0 },
  checkLabel: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 16.88, flexShrink: 1 },
  toggle: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleLabel: { fontFamily: fonts.sans(400), fontSize: 12 },
});
