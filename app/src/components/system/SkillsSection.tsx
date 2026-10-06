// SystemPanel.tsx:83-207 — skills count + category tallies, then a searchable,
// tappable list. Open by default; collapsed hides the loading and error panels
// too (SystemPanel.tsx:130-132).
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SheetFields, StatePanel } from '../shell';
import { ChevronRight, OpsCard, OPS_PRESSED } from '../ops/parts';
import { CollapseHead } from './CollapseHead';
import { DetailSheet, statusToneColor } from './DetailSheet';
import { filterSkills, skillMeta, skillsSummary } from './systemFormat';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { SkillRow } from '../../lib/types';

/** SystemPanel.tsx:170-173 / 269-272 — both long lists cap at 360 and scroll. */
export const LIST_MAX_HEIGHT = 360;

function SkillRowItem({ s, isLast, onOpen }: { s: SkillRow; isLast: boolean; onOpen: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.skillRow,
        isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: OPS_PRESSED },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: t(statusToneColor(s.status)) }]} />
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: t('fg-0') }]} numberOfLines={1} ellipsizeMode="tail">
          {s.name}
        </Text>
        <Text style={[styles.meta, { color: t('fg-3') }]} numberOfLines={1} ellipsizeMode="tail">
          {skillMeta(s)}
        </Text>
      </View>
      <ChevronRight size={13} tone="fg-4" />
    </Pressable>
  );
}

export function SkillsSection() {
  const { t } = useTheme();
  const q = usePoll(['skills'], api.skills, QUERY_TUNING.skills);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SkillRow | null>(null);
  const [open, setOpen] = useState(true);

  const rows = q.data?.skills ?? [];
  const filtered = useMemo(() => filterSkills(rows, query), [rows, query]);

  return (
    <View style={styles.section}>
      <CollapseHead
        label="Skills"
        count={q.data ? `${q.data.total}` : ''}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && q.isLoading ? (
        <StatePanel tone="pending" title="Reading skills…" detail="installed skills" />
      ) : null}
      {open && q.isError ? (
        <StatePanel tone="error" title="Skills unavailable" detail={q.error?.message ?? ''} />
      ) : null}
      {open && q.data ? (
        <OpsCard>
          <View style={styles.totalRow}>
            <Text style={[styles.total, { color: t('fg-0') }]}>{q.data.total}</Text>
            <Text style={[styles.totalSub, { color: t('fg-3') }]}>{skillsSummary(q.data)}</Text>
          </View>
          {q.data.categories.length > 0 ? (
            <View style={styles.chips}>
              {q.data.categories.map((c) => (
                <View key={c.name} style={[styles.chip, { backgroundColor: t('bg-2'), borderColor: t('border') }]}>
                  <Text style={[styles.chipLabel, { color: t('fg-2') }]}>{c.name}</Text>
                  <Text style={[styles.chipCount, { color: t('fg-4') }]}>{c.count}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {rows.length === 0 ? (
            <Text style={[styles.quiet, { color: t('fg-4') }]}>No skills reported.</Text>
          ) : (
            <>
              {/* 16px font is the iOS focus-zoom guard the PWA relies on
                  (index.html:5-8 deliberately omits maximum-scale). */}
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search skills…"
                placeholderTextColor={t('fg-4')}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.search, { backgroundColor: t('bg-0'), borderColor: t('border'), color: t('fg-0') }]}
              />
              <ScrollView style={styles.list} nestedScrollEnabled>
                {filtered.length === 0 ? (
                  <Text style={[styles.noMatch, { color: t('fg-4') }]}>No skills match “{query}”.</Text>
                ) : (
                  filtered.map((s, i) => (
                    <SkillRowItem
                      key={s.name ?? i}
                      s={s}
                      isLast={i === filtered.length - 1}
                      onOpen={() => setSelected(s)}
                    />
                  ))
                )}
              </ScrollView>
            </>
          )}
        </OpsCard>
      ) : null}

      <DetailSheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        eyebrow="Skill"
        title={selected?.name ?? ''}
        status={selected ? { label: selected.status || '—', color: t(statusToneColor(selected.status)) } : null}
      >
        <SheetFields
          fields={[
            { label: 'Category', value: selected?.category },
            { label: 'Source', value: selected?.source },
            { label: 'Trust', value: selected?.trust },
            { label: 'Status', value: selected?.status },
          ]}
        />
      </DetailSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginBottom: 12 },
  total: { fontFamily: fonts.sans(640), fontSize: 26, letterSpacing: -0.52 },
  totalSub: { fontFamily: fonts.sans(400), fontSize: 12, flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderWidth: 1,
  },
  chipLabel: { fontFamily: fonts.sans(400), fontSize: 11 },
  chipCount: { fontFamily: fonts.mono(400), fontSize: 10 },
  quiet: { fontFamily: fonts.sans(400), fontSize: 12 },
  search: {
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: fonts.sans(400),
    fontSize: 16,
  },
  list: { maxHeight: LIST_MAX_HEIGHT },
  noMatch: { fontFamily: fonts.sans(400), fontSize: 12, paddingVertical: 11 },
  skillRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  rowText: { flex: 1, minWidth: 0 },
  dot: { width: 7, height: 7, borderRadius: 3.5, flexShrink: 0 },
  name: { fontFamily: fonts.sans(520), fontSize: 14 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
