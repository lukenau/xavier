// SystemPanel.tsx:303-354 — the active built-in store + provider and any
// installed memory plugins. Exported separately because it is mounted on its
// own /config/memory page, NOT inside SystemPanel (MemoryPage.tsx:25-36).
import { StyleSheet, Text, View } from 'react-native';
import { SectionHead, StatePanel } from '../shell';
import { OpsCard } from '../ops/parts';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

export function MemorySection() {
  const { t } = useTheme();
  const q = usePoll(['memory'], api.memory, QUERY_TUNING.memory);

  return (
    <View style={styles.section}>
      <SectionHead label="Memory" count={q.data ? (q.data.provider ?? q.data.built_in ?? '') : ''} />
      {q.isLoading ? (
        <StatePanel tone="pending" title="Reading memory…" detail="memory status" />
      ) : null}
      {q.isError ? <StatePanel tone="error" title="Memory unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data ? (
        <OpsCard>
          <View style={[styles.row, { borderBottomWidth: 1, borderBottomColor: t('border') }]}>
            <Text style={[styles.label, { color: t('fg-4') }]}>Built-in</Text>
            <Text style={[styles.value, { color: q.data.built_in ? t('fg-1') : t('fg-4') }]}>
              {q.data.built_in ?? 'not reported'}
            </Text>
          </View>
          <View
            style={[
              styles.row,
              q.data.plugins.length > 0 ? { borderBottomWidth: 1, borderBottomColor: t('border') } : null,
            ]}
          >
            <Text style={[styles.label, { color: t('fg-4') }]}>Provider</Text>
            <Text style={[styles.value, { color: q.data.provider ? t('fg-1') : t('fg-4') }]}>
              {q.data.provider ?? 'not reported'}
            </Text>
          </View>
          {q.data.plugins.length > 0 ? (
            <View style={styles.pluginsBlock}>
              <Text style={[styles.pluginsLabel, { color: t('fg-4') }]}>Installed plugins</Text>
              <View style={styles.plugins}>
                {q.data.plugins.map((p, i) => (
                  <View key={p.name ?? i} style={styles.plugin}>
                    <View style={[styles.dot, { backgroundColor: t('status-up') }]} />
                    <View style={styles.pluginText}>
                      <Text style={[styles.pluginName, { color: t('fg-1') }]}>{p.name}</Text>
                      {p.note ? <Text style={[styles.pluginNote, { color: t('fg-3') }]}>{p.note}</Text> : null}
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </OpsCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingVertical: 10 },
  label: { width: 86, flexShrink: 0, fontFamily: fonts.sans(400), fontSize: 12 },
  value: { flex: 1, minWidth: 0, textAlign: 'right', fontFamily: fonts.sans(400), fontSize: 13 },
  pluginsBlock: { paddingTop: 11 },
  pluginsLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  plugins: { flexDirection: 'column', gap: 8 },
  plugin: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  pluginText: { flex: 1, minWidth: 0 },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 6, flexShrink: 0 },
  pluginName: { fontFamily: fonts.sans(500), fontSize: 13 },
  pluginNote: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16.1 },
});
