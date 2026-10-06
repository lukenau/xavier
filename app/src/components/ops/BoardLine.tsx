// Ops.tsx:511-522 — one-line kanban pulse. Renders NOTHING unless there is
// data with a non-zero total: no loading state, and no error state either.
import { StyleSheet, Text, View } from 'react-native';
import type { UseQueryResult } from '@tanstack/react-query';
import { SectionHead } from '../shell';
import { boardLine } from './opsFormat';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { KanbanReport } from '../../lib/types';

export function BoardLine({ q }: { q: UseQueryResult<KanbanReport, Error> }) {
  const { t } = useTheme();
  if (!q.data || q.data.total === 0) return null;
  return (
    <View style={styles.section}>
      <SectionHead label="Board" count={`${q.data.total}`} />
      <Text style={[styles.line, { color: t('fg-2') }]}>{boardLine(q.data.columns)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  line: { fontFamily: fonts.mono(400), fontSize: 11, paddingHorizontal: 4 },
});
