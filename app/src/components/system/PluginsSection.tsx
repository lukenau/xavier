// SystemPanel.tsx:209-301 — the FULL plugin list (enabled + bundled), enabled
// first, tappable into a detail sheet. Collapsed by default.
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SheetBody, SheetFields, StatePanel } from '../shell';
import { OpsCard, OPS_PRESSED } from '../ops/parts';
import { CollapseHead } from './CollapseHead';
import { DetailSheet } from './DetailSheet';
import { LIST_MAX_HEIGHT } from './SkillsSection';
import { pluginStatusLabel, pluginStatusTone, sortPluginsEnabledFirst } from './systemFormat';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { PluginRow } from '../../lib/types';

function PluginItem({ p, isLast, onOpen }: { p: PluginRow; isLast: boolean; onOpen: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: OPS_PRESSED },
      ]}
    >
      {/* `box-shadow: 0 0 0 2px var(--status-up-soft)` is a spread ring, which
          RN has no shadow for — a concentric 11px halo View is the same paint. */}
      <View style={[styles.halo, p.enabled ? { backgroundColor: t('status-up-soft') } : null]}>
        <View style={[styles.dot, { backgroundColor: p.enabled ? t('status-up') : t('fg-4') }]} />
      </View>
      <View style={styles.rowText}>
        <View style={styles.nameLine}>
          <Text style={[styles.name, { color: t('fg-0') }]} numberOfLines={1} ellipsizeMode="tail">
            {p.name}
          </Text>
          {p.version ? <Text style={[styles.version, { color: t('fg-4') }]}>{p.version}</Text> : null}
        </View>
        {p.description ? (
          <Text style={[styles.description, { color: t('fg-3') }]} numberOfLines={2} ellipsizeMode="tail">
            {p.description}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.onOff, { color: p.enabled ? t('status-up') : t('fg-4') }]}>
        {p.enabled ? 'on' : 'off'}
      </Text>
    </Pressable>
  );
}

export function PluginsSection() {
  const { t } = useTheme();
  const q = usePoll(['plugins'], api.plugins, QUERY_TUNING.plugins);
  const [selected, setSelected] = useState<PluginRow | null>(null);
  const [open, setOpen] = useState(false);

  const plugins = useMemo(() => sortPluginsEnabledFirst(q.data?.plugins ?? []), [q.data]);

  return (
    <View style={styles.section}>
      <CollapseHead
        label="Plugins"
        count={q.data ? `${q.data.enabled}/${q.data.total}` : ''}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && q.isLoading ? (
        <StatePanel tone="pending" title="Reading plugins…" detail="installed plugins" />
      ) : null}
      {open && q.isError ? (
        <StatePanel tone="error" title="Plugins unavailable" detail={q.error?.message ?? ''} />
      ) : null}
      {open && q.data && plugins.length === 0 ? (
        <StatePanel tone="neutral" title="No plugins" detail="No bundled or enabled plugins reported." />
      ) : null}
      {open && q.data && plugins.length > 0 ? (
        <OpsCard>
          <ScrollView style={styles.list} nestedScrollEnabled>
            {plugins.map((p, i) => (
              <PluginItem key={p.name ?? i} p={p} isLast={i === plugins.length - 1} onOpen={() => setSelected(p)} />
            ))}
          </ScrollView>
        </OpsCard>
      ) : null}

      <DetailSheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        eyebrow="Plugin"
        title={selected?.name ?? ''}
        status={
          selected
            ? { label: pluginStatusLabel(selected), color: t(pluginStatusTone(selected)) }
            : null
        }
      >
        <SheetFields
          fields={[
            { label: 'Version', value: selected?.version, mono: true },
            { label: 'Source', value: selected?.source, mono: true },
            { label: 'Status', value: selected?.status },
          ]}
        />
        {selected?.description ? <SheetBody label="Description">{selected.description}</SheetBody> : null}
      </DetailSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  list: { maxHeight: LIST_MAX_HEIGHT },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11 },
  rowText: { flex: 1, minWidth: 0 },
  halo: {
    width: 11,
    height: 11,
    borderRadius: 5.5,
    marginTop: 4,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  nameLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { fontFamily: fonts.sans(540), fontSize: 14, flexShrink: 1 },
  version: { fontFamily: fonts.mono(400), fontSize: 10, flexShrink: 0 },
  description: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16.68, marginTop: 1 },
  onOff: { fontFamily: fonts.mono(400), fontSize: 10, flexShrink: 0, marginTop: 3 },
});
