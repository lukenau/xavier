// Everything the gate held back, read-only.
//
// "110 held back" is the one number on the brief that invites a "by what?".
// This answers it and nothing more: there is no un-defer action, because the
// way to change what tomorrow holds back is the Useful signal, not a per-item
// override of today's gate.
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { DetailSheet } from '../system/DetailSheet';
import { heldBackSummary, type Brief, type BriefDeferred } from './briefModel';

/** Human copy for a gate code, and the order the groups appear in. */
const CODE_LABELS: Record<string, string> = {
  D2: 'Nothing to do',
  DONE: 'Already done',
  EVIDENCE: 'No quote to stand on',
  D1: 'Not yours to act on',
  AMBIENT: 'Ambient screen activity',
  D4: 'Too old',
  MERGED: 'Shown as part of another item',
  NOISE: 'Noise',
  ROLE: 'Duplicate role',
  UNDECIDED: 'Undecided',
};

export function groupDeferred(deferred: BriefDeferred[]): { code: string; label: string; items: BriefDeferred[] }[] {
  const byCode = new Map<string, BriefDeferred[]>();
  for (const d of deferred) {
    const list = byCode.get(d.code);
    if (list) list.push(d);
    else byCode.set(d.code, [d]);
  }
  return [...byCode.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([code, items]) => ({ code, label: CODE_LABELS[code] ?? code, items }));
}

export function HeldBackSheet({
  brief,
  visible,
  onClose,
}: {
  brief: Brief | undefined;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTheme();
  // Memoized on [brief] (H16): unmemoized this re-ran on every BriefScreen
  // render — every setRows call from an interaction elsewhere on the screen —
  // even while the sheet is closed.
  const groups = useMemo(() => groupDeferred(brief?.deferred ?? []), [brief]);

  // The sheet has no dismissal animation of its own to preserve: RN's Modal
  // (animationType="slide", inside DetailSheet) owns that, and it is already
  // unmounted by the time visible goes false. So closed means built nothing
  // at all, not "built and thrown away" (H16) — 84-110 deferred items were
  // ~220 React elements per BriefScreen re-render for a sheet nobody had open.
  if (!visible) return null;

  return (
    <DetailSheet
      visible={visible}
      onClose={onClose}
      eyebrow="held back"
      title={heldBackSummary(brief) || 'Nothing held back'}
    >
      {groups.map((group) => (
        <View key={group.code} style={styles.group}>
          <Text style={[styles.groupLabel, { color: t('fg-4') }]}>
            {group.label} · {group.items.length}
          </Text>
          {group.items.map((d) => (
            <View
              key={d.item_id}
              style={[styles.row, { borderTopColor: t('border') }]}
            >
              <Text numberOfLines={2} style={[styles.title, { color: t('fg-2') }]}>
                {d.title}
              </Text>
              <Text numberOfLines={2} style={[styles.reason, { color: t('fg-4') }]}>
                {/* `closure` is the one deferral worth reading — it says what
                    closed something the user was tracking. */}
                {d.closure ?? d.reason}
                {d.source ? ` · ${d.source}` : ''}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </DetailSheet>
  );
}

const styles = StyleSheet.create({
  group: { marginBottom: 18 },
  groupLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  row: { borderTopWidth: 1, paddingVertical: 9, paddingHorizontal: 4 },
  title: { fontFamily: fonts.sans(550), fontSize: 13 },
  reason: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 3 },
});
