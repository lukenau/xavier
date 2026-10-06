import { StyleSheet, Text, View } from 'react-native';
import type { ChartWidget as ChartWidgetT } from '../../../chat/widget';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { LineChart } from '../../charts/LineChart';
import { LegendChips, StackedBars } from '../../charts/StackedBars';
import { Card } from '../../shell';

const MAX_TICK_CHARS = 7;
const PREFIX_UNITS = new Set(['$', '€', '£', '¥']);

/** Axis room is a few glyphs wide at 400px, and bucket keys arrive as whatever
 *  the agent wrote — `2026-09-22`, `Groceries`, `wk 38`. */
export function abbreviateKey(key: string): string {
  return key.length <= MAX_TICK_CHARS ? key : `${key.slice(0, MAX_TICK_CHARS - 1)}…`;
}

export function compactNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${round(v / 1e6)}M`;
  if (abs >= 1e3) return `${round(v / 1e3)}k`;
  return round(v);
}

function round(v: number): string {
  return String(Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
}

export function formatValue(v: number, unit: string | null): string {
  const n = compactNumber(v);
  if (!unit) return n;
  if (PREFIX_UNITS.has(unit)) return `${unit}${n}`;
  return unit === '%' ? `${n}%` : `${n} ${unit}`;
}

export function chartAriaTitle(widget: ChartWidgetT): string {
  const what = widget.title ?? widget.series.map((s) => s.label).join(', ');
  const first = widget.buckets[0];
  const last = widget.buckets[widget.buckets.length - 1];
  const span = first && last && first !== last ? ` from ${first.key} to ${last.key}` : '';
  const shape = widget.variant === 'line' ? 'line chart' : 'bar chart';
  return `${what}, ${shape}, ${widget.buckets.length} point${widget.buckets.length === 1 ? '' : 's'}${span}`;
}

export function ChartWidget({ widget }: { widget: ChartWidgetT }) {
  const { t } = useTheme();

  const tickFormat = (key: string) => abbreviateKey(key);
  const valueFormat = (v: number) => formatValue(v, widget.unit);
  const ariaTitle = chartAriaTitle(widget);

  return (
    <Card>
      {widget.title && (
        <Text style={[styles.title, { color: t('fg-0') }]}>{widget.title}</Text>
      )}
      <View style={styles.chart}>
        {widget.variant === 'bars' ? (
          <StackedBars
            buckets={widget.buckets.map((b) => ({
              key: b.key,
              values: b.values,
              total: Object.values(b.values).reduce((sum, v) => sum + v, 0),
            }))}
            series={widget.series}
            tickFormat={tickFormat}
            valueFormat={valueFormat}
            ariaTitle={ariaTitle}
          />
        ) : (
          <LineChart
            buckets={widget.buckets}
            series={widget.series}
            tickFormat={tickFormat}
            valueFormat={valueFormat}
            ariaTitle={ariaTitle}
          />
        )}
      </View>
      <LegendChips series={widget.series} />
      {widget.caption && (
        <Text style={[styles.caption, { color: t('fg-3') }]}>{widget.caption}</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.sans(600), fontSize: 14, letterSpacing: -0.1 },
  chart: { marginTop: 10 },
  caption: { marginTop: 8, fontFamily: fonts.mono(400), fontSize: 10.5, ...MONO_FEATURES },
});
