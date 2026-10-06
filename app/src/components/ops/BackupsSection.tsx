// Ops.tsx:774-825 — restic → Backblaze, fed by backup.sh's hub status file.
// `rel_time` is server-computed (app.py:547-552); the per-snapshot stamps are
// client-side relTime.
import { StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { UseQueryResult } from '@tanstack/react-query';
import { SectionHead, StatePanel } from '../shell';
import { OpsCard, Pill } from './parts';
import { backupSubLine } from './opsFormat';
import { relTime } from '../../shared/time';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { BackupStatus } from '../../lib/types';

const B2_CONSOLE = 'https://secure.backblaze.com/b2_buckets.htm';

export function BackupsSection({ q }: { q: UseQueryResult<BackupStatus, Error> }) {
  const { t } = useTheme();
  const d = q.data;
  const snaps = d?.snapshots ?? [];

  return (
    <View style={styles.section}>
      <SectionHead
        label="Backups"
        count={d?.snapshot_count ? `${d.snapshot_count}` : ''}
        action={
          // The PWA's target="_blank" anchor opens a Safari view controller in
          // the standalone PWA (inventory §5.5); openBrowserAsync is that same
          // SFSafariViewController rather than a jump out to Safari.
          <Pill
            label="B2 console"
            onPress={() => {
              WebBrowser.openBrowserAsync(B2_CONSOLE).catch(() => {});
            }}
            background={t('bg-2')}
            borderColor={t('border')}
            color={t('fg-1')}
          />
        }
      />
      {q.isError ? (
        <StatePanel tone="error" title="Backup status unavailable" detail={q.error?.message ?? ''} />
      ) : null}
      {/* No pending StatePanel: this section renders nothing until data. */}
      {d ? (
        <OpsCard>
          <Text style={[styles.headline, { color: t('fg-0') }]}>Last backup {d.rel_time}</Text>
          <Text style={[styles.sub, { color: t('fg-3') }]}>{backupSubLine(d)}</Text>
          {snaps.length > 0 ? (
            <View style={[styles.snapList, { borderTopColor: t('border') }]}>
              {snaps.map((s, i) => (
                <View
                  key={s.id}
                  style={[
                    styles.snapRow,
                    i === snaps.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
                  ]}
                >
                  <Text style={[styles.snapId, { color: t('fg-1') }]}>{s.id}</Text>
                  <Text style={[styles.snapAge, { color: t('fg-3') }]}>{relTime(s.ts)}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </OpsCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 14, marginBottom: 10 },
  headline: { fontFamily: fonts.sans(520), fontSize: 15 },
  sub: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  snapList: { marginTop: 8, borderTopWidth: 1 },
  snapRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  snapId: { fontFamily: fonts.mono(400), fontSize: 12 },
  snapAge: { flex: 1, textAlign: 'right', fontFamily: fonts.mono(400), fontSize: 10.5, ...MONO_FEATURES },
});
