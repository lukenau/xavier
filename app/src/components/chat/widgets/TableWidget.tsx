import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { TableColumn, TableWidget as TableWidgetT } from '../../../chat/widget';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';

export const MIN_COL_W = 56;
export const MAX_COL_W = 220;
// HubMono's advance is exactly 0.600 em, so a 12.5pt cell character is 7.5pt.
// At 7 every column was budgeted 7% short and truncated the moment the table
// stopped being stretched to fit (design review, 2026-09-22).
const CHAR_W = 7.5;
const CELL_PAD_X = 9;
// Cells wrap. Every one used to be a single line pinned by a 26pt line height,
// so a sentence rendered as its first few words (the user, 2026-09-22: "make text
// wrap for longer sentences in the table widget").

/**
 * Widths come from the content, then stretch to fill: a table that fits shares
 * the card's width in proportion to what each column has to say, and one that
 * does not keeps its natural width and scrolls inside its own container — the
 * transcript must never scroll sideways.
 */
export function columnWidths(
  columns: TableColumn[],
  rows: Record<string, string>[],
  available: number,
): number[] {
  const natural = columns.map((c) => {
    const longest = rows.reduce((max, r) => Math.max(max, (r[c.key] ?? '').length), c.label.length);
    return Math.min(MAX_COL_W, Math.max(MIN_COL_W, longest * CHAR_W + CELL_PAD_X * 2));
  });
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (available <= 0 || total >= available) return natural;
  return natural.map((w) => (w / total) * available);
}

export function TableWidget({ widget }: { widget: TableWidgetT }) {
  const { t } = useTheme();
  const [available, setAvailable] = useState(0);

  const widths = columnWidths(widget.columns, widget.rows, available);
  const tableWidth = widths.reduce((sum, w) => sum + w, 0);

  return (
    <Card>
      {widget.title && <Text style={[styles.title, { color: t('fg-0') }]}>{widget.title}</Text>}
      <View
        style={styles.frame}
        testID="table-frame"
        onLayout={(e: LayoutChangeEvent) => setAvailable(e.nativeEvent.layout.width)}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={{ width: tableWidth }}
        >
          <View style={{ width: tableWidth }}>
            <View style={[styles.row, styles.headRow, { borderBottomColor: t('border-strong') }]}>
              {widget.columns.map((c, i) => (
                <Text
                  key={c.key}
                  numberOfLines={1}
                  style={[styles.head, { width: widths[i], textAlign: c.align, color: t('fg-3') }]}
                >
                  {c.label}
                </Text>
              ))}
            </View>
            {widget.rows.map((row, ri) => (
              <View
                key={ri}
                style={[styles.row, widget.rows.length >= 4 && ri % 2 === 1 && { backgroundColor: t('bg-2') }]}
              >
                {widget.columns.map((c, i) => (
                  <Text
                    key={c.key}
                    style={[styles.cell, { width: widths[i], textAlign: c.align, color: t('fg-1') }]}
                  >
                    {row[c.key]}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
      {widget.caption && (
        <Text style={[styles.caption, { color: t('fg-3') }]}>{widget.caption}</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.sans(600), fontSize: 14, letterSpacing: -0.1 },
  frame: { marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'flex-start', borderRadius: 4 },
  headRow: { borderBottomWidth: 1, paddingBottom: 5, marginBottom: 3 },
  head: {
    fontFamily: fonts.mono(550),
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: CELL_PAD_X,
  },
  cell: {
    fontFamily: fonts.mono(400),
    fontSize: 12.5,
    lineHeight: 17,
    paddingVertical: 5,
    paddingHorizontal: CELL_PAD_X,
    ...MONO_FEATURES,
  },
  caption: { marginTop: 8, fontFamily: fonts.mono(400), fontSize: 10.5, ...MONO_FEATURES },
});
