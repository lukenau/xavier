import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  Circle,
  Group,
  Line,
  Path,
  Text as SkiaText,
  useFont,
  vec,
} from '@shopify/react-native-skia';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import type { TokenName } from '../../theme/tokens.gen';
import { useTheme } from '../../theme/useTheme';
import { LINE_M, lineAxisTicks, lineLayout, lineY, type LineBucket } from './lineGeometry';

// The generic line chart: same mark spec as EquityChart (2px line, hairline
// gridlines at clean ticks, an end-dot with a surface ring, first/middle/last
// labels under a rule) over any `{series, buckets}` payload rather than a
// fixed equity curve. Colors follow the series, never the position.

const MONO_400 = require('../../../assets/fonts/HubMono-400.ttf');
const AXIS_FONT_SIZE = 9;

export interface LineChartSeries {
  id: string;
  label: string;
  color: TokenName;
}

export interface LineChartProps {
  series: LineChartSeries[];
  buckets: LineBucket[];
  height?: number;
  ariaTitle: string;
  tickFormat?: (key: string, index: number) => string;
  valueFormat?: (v: number) => string;
}

export function LineChart({
  series,
  buckets,
  height = 140,
  ariaTitle,
  tickFormat = (key) => key,
  valueFormat = (v) => String(v),
}: LineChartProps) {
  const { t } = useTheme();
  const [width, setWidth] = useState(0);

  const axisFont = useFont(MONO_400, AXIS_FONT_SIZE);
  const layout = lineLayout(
    buckets,
    series.map((s) => s.id),
    width,
    height,
  );
  const ticks = lineAxisTicks(buckets, tickFormat);

  return (
    <View
      style={styles.host}
      testID="line-chart"
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 && layout.n > 0 && (
        <Canvas
          style={{ width, height }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={ariaTitle}
        >
          {layout.ticks.map((tick) => {
            const ty = lineY(tick, layout.dMin, layout.dMax, height);
            const label = valueFormat(tick);
            return (
              <Group key={`grid-${tick}`}>
                <Line
                  p1={vec(LINE_M.l, ty)}
                  p2={vec(width - LINE_M.r, ty)}
                  color={t('border')}
                  style="stroke"
                  strokeWidth={1}
                />
                {axisFont && (
                  <SkiaText
                    x={Math.max(0, LINE_M.l - 5 - axisFont.measureText(label).width)}
                    y={ty + 3}
                    text={label}
                    font={axisFont}
                    color={t('fg-4')}
                  />
                )}
              </Group>
            );
          })}
          {layout.series.map((s, i) => {
            const color = t(series[i].color);
            const last = s.points[s.points.length - 1];
            return (
              <Group key={s.id}>
                {s.path && (
                  <Path
                    path={s.path}
                    color={color}
                    style="stroke"
                    strokeWidth={2}
                    strokeJoin="round"
                    strokeCap="round"
                  />
                )}
                {last && (
                  <Group>
                    <Circle c={vec(last.x, last.y)} r={3.5} color={color} />
                    <Circle
                      c={vec(last.x, last.y)}
                      r={3.5}
                      color={t('bg-1')}
                      style="stroke"
                      strokeWidth={2}
                    />
                  </Group>
                )}
              </Group>
            );
          })}
        </Canvas>
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

const styles = StyleSheet.create({
  host: { width: '100%' },
  rule: { height: 1 },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  axisLabel: { fontFamily: fonts.mono(400), fontSize: 9.5, ...MONO_FEATURES },
});
