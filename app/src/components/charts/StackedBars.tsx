import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  Group,
  Line,
  Path,
  Rect,
  RoundedRect,
  Text as SkiaText,
  useFont,
  vec,
} from '@shopify/react-native-skia';
import type { BarSeries } from '../../shared/chartTypes';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  axisTicks,
  barX,
  barY,
  barsLayout,
  bucketLabel,
  bucketSegments,
  fmtGrid,
  roundedTopRect,
  seriesPaint,
  toggleSelection,
  type StackedBarBucket,
} from './geometry';

// The one bar chart. Cost's history and Home's spend mini both render through
// this so mark specs stay consistent: bars ≤24px with a rounded data-end and a
// square baseline, 2px surface gaps between stacked segments, solid hairline
// gridlines, an in-progress bucket dimmed to 40%. Colors arrive via `series`
// and follow the entity — never recomputed on filter.
//
// Port of apps/hub/src/components/charts/StackedBars.tsx. Two substitutions:
// the SVG becomes a Skia canvas (paths and rects carry over unchanged —
// `roundedTopRect` emits the same string), and the per-bucket
// `<g role="img" onClick>` becomes a row of transparent Pressables laid over
// the canvas, because canvas pixels have no accessibility tree: the sentence
// and the tap target both have to live in real views.

const MONO_400 = require('../../../assets/fonts/HubMono-400.ttf');
const GRID_FONT_SIZE = 9;

export interface StackedBarsProps {
  buckets: StackedBarBucket[];
  series: BarSeries[];
  height?: number;
  showGrid?: boolean;
  tickFormat: (key: string, index: number) => string;
  valueFormat?: (v: number) => string;
  selected?: number | null;
  onSelect?: (index: number | null) => void;
  ariaTitle: string;
}

export function StackedBars({
  buckets,
  series,
  height = 120,
  showGrid = true,
  tickFormat,
  valueFormat = fmtGrid,
  selected = null,
  onSelect,
  ariaTitle,
}: StackedBarsProps) {
  const { t } = useTheme();
  const [width, setWidth] = useState(0);
  const gridFont = useFont(MONO_400, GRID_FONT_SIZE);

  const layout = barsLayout(buckets, width, height, showGrid);
  const { n, slot, barW, plotTop, plotH, gridLines } = layout;
  const ticks = axisTicks(buckets, tickFormat);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View style={styles.host} onLayout={onLayout}>
      {width > 0 && n > 0 && (
        <View style={{ width, height }}>
          <Canvas
            style={{ width, height }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={ariaTitle}
          >
            {gridLines.map((v) => (
              <Group key={`grid-${v}`}>
                <Line
                  p1={vec(0, barY(v, layout))}
                  p2={vec(width, barY(v, layout))}
                  color={t('border')}
                  style="stroke"
                  strokeWidth={1}
                />
                {gridFont && (
                  <SkiaText
                    x={width - 3 - gridFont.measureText(valueFormat(v)).width}
                    y={barY(v, layout) - 3}
                    text={valueFormat(v)}
                    font={gridFont}
                    color={t('fg-3')}
                  />
                )}
              </Group>
            ))}
            {buckets.map((b, i) => {
              const x = barX(i, layout);
              const opacity = b.partial ? 0.4 : 1;
              const segs = bucketSegments(b, series, layout);
              return (
                <Group key={b.key}>
                  {i === selected && (
                    <RoundedRect
                      x={i * slot}
                      y={0}
                      width={slot}
                      height={height}
                      r={4}
                      color={t('accent-soft')}
                    />
                  )}
                  {segs.map((seg, j) =>
                    j === segs.length - 1 ? (
                      <Path
                        key={j}
                        path={roundedTopRect(x, seg.y, barW, seg.h, 3)}
                        color={seriesPaint(seg.color, t)}
                        opacity={opacity}
                      />
                    ) : (
                      <Rect
                        key={j}
                        x={x}
                        y={seg.y}
                        width={barW}
                        height={seg.h}
                        color={seriesPaint(seg.color, t)}
                        opacity={opacity}
                      />
                    ),
                  )}
                  {b.total <= 0 && (
                    <Rect
                      x={x}
                      y={plotTop + plotH - 1}
                      width={barW}
                      height={1}
                      color={t('border-strong')}
                    />
                  )}
                </Group>
              );
            })}
          </Canvas>
          <View style={[StyleSheet.absoluteFill, styles.hitRow]}>
            {buckets.map((b, i) => (
              <Pressable
                key={b.key}
                style={{ width: slot, height }}
                accessible
                accessibilityRole={onSelect ? 'imagebutton' : 'image'}
                accessibilityState={onSelect ? { selected: i === selected } : undefined}
                accessibilityLabel={bucketLabel(b, i, tickFormat, valueFormat)}
                onPress={onSelect ? () => onSelect(toggleSelection(selected, i)) : undefined}
              />
            ))}
          </View>
        </View>
      )}
      <View style={[styles.rule, { backgroundColor: t('border') }]} />
      <View style={styles.axisRow}>
        <Text style={[styles.axisLabel, { color: t('fg-4') }]}>{ticks.left}</Text>
        {ticks.mid !== null && (
          <Text style={[styles.axisLabel, { color: t('fg-4') }]}>{ticks.mid}</Text>
        )}
        <Text style={[styles.axisLabel, { color: t('fg-4') }]}>{ticks.right}</Text>
      </View>
    </View>
  );
}

/** Legend chips: swatch carries identity, text stays in text tokens. */
export function LegendChips({ series }: { series: BarSeries[] }) {
  const { t } = useTheme();
  if (series.length < 2) return null;
  return (
    <View style={styles.legend}>
      {series.map((s) => (
        <View key={s.id} style={styles.chip}>
          <View style={[styles.swatch, { backgroundColor: seriesPaint(s.color, t) }]} />
          <Text style={[styles.chipLabel, { color: t('fg-3') }]}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { width: '100%' },
  hitRow: { flexDirection: 'row' },
  rule: { height: 1 },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  axisLabel: { fontFamily: fonts.mono(400), fontSize: 9.5, ...MONO_FEATURES },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 5, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', columnGap: 5 },
  swatch: { width: 7, height: 7, borderRadius: 2 },
  chipLabel: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
