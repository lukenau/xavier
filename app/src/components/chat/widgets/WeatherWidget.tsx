// Weather, in the two shapes the user asked for: the next few hours, and the days
// ahead. "i like the data visualizations that apple uses ... it just makes
// things easier to see, lowering cognitive load" (2026-09-22).
//
// What is borrowed from Apple is the information design, not the look:
//
// * The day's bar is drawn INSIDE the range the whole forecast covers, so a
//   cold day is a short bar on the left and a warm one sits right. The shape
//   of the week reads before a single number does — which is the whole point.
// * Today carries a dot at the current temperature, the one reading that
//   answers "and right now?".
// * Numbers sit in fixed columns with tabular figures, so the eye runs down
//   them instead of re-finding them on each row.
//
// Apple splits conditions and precipitation across two tabs. A tab is a thing
// to find and press, which a transcript should not ask of you, so the two are
// separate widgets instead: `view: 'conditions'` is temperature, `view:
// 'precip'` is Apple's rain screen — the day's hours as a sparkline, then the
// inches and the chance ("build precipitation weather charts as well please
// not just that one overall widget", the user 2026-09-23). Xavier can draw both.
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { WeatherDay, WeatherHour, WeatherWidget as WeatherWidgetT } from '../../../chat/widget';
import { bar, degrees, heatColor, nowAt, temperatureScale, waterColor } from '../../../chat/weatherLayout';
import { WeatherGlyph } from './WeatherGlyph';
import { METRICS, columns, compositeMetrics, hourTick, selectDays, selectHours, type MetricId } from '../../../chat/weatherMetrics';

export function WeatherWidget({ widget }: { widget: WeatherWidgetT }) {
  const { t, scheme } = useTheme();
  const scale = temperatureScale(widget.days.length > 0 ? widget.days : [{ low: widget.temp ?? 0, high: widget.temp ?? 1 }]);
  // Every day's sparkline is drawn against the wettest hour in the set, so a
  // drizzle does not look like a downpour on its own row.
  const peak = Math.max(10, ...widget.days.flatMap((d) => (d.precip_hours.length > 0 ? d.precip_hours : [d.precip])));

  return (
    <Card style={styles.card}>
      {widget.place || widget.temp !== null ? (
        <View style={styles.head}>
          <View style={styles.headText}>
            {widget.place ? (
              <Text style={[styles.place, { color: t('fg-0') }]} numberOfLines={1}>
                {widget.place}
              </Text>
            ) : null}
            {widget.summary ? (
              <Text style={[styles.summary, { color: t('fg-2') }]} numberOfLines={2}>
                {widget.summary}
              </Text>
            ) : null}
          </View>
          {widget.temp !== null ? (
            <View style={styles.headNow}>
              <Text style={[styles.now, { color: t('fg-0') }, MONO_FEATURES]}>{degrees(widget.temp)}</Text>
              {widget.feels_like !== null ? (
                <Text style={[styles.feels, { color: t('fg-3') }, MONO_FEATURES]}>
                  {`feels ${degrees(widget.feels_like)}`}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {widget.sections.length > 0 ? (
        <View style={styles.sections}>
          {widget.sections.map((section, i) => {
            const hrs = selectHours(widget.hours, { day: section.day, from: section.from, count: section.hours });
            const days = selectDays(widget.days, section.days);
            return (
              <View key={`${section.type}-${i}`} style={styles.section} testID={`weather-section-${i}`}>
                {section.title ? (
                  <Text style={[styles.sectionTitle, { color: t('fg-2') }]} numberOfLines={1}>
                    {section.title}
                  </Text>
                ) : null}
                {section.type === 'days'
                  ? days.map((day, di) => (
                      <DayRow key={`${day.label}-${di}`} day={day} scale={scale} now={null} />
                    ))
                  : null}
                {section.type === 'precip'
                  ? days.map((day, di) => <PrecipRow key={`${day.label}-${di}`} day={day} peak={peak} />)
                  : null}
                {section.type === 'hourly' && hrs.length > 0 ? (
                  <HourlyMetric hours={hrs} metric={section.metric} />
                ) : null}
                {section.type === 'composite' && hrs.length > 0 ? (
                  <View style={styles.composite}>
                    {(section.metrics.length > 0 ? section.metrics : compositeMetrics(hrs)).map((id) => (
                      <HourlyMetric key={id} hours={hrs} metric={id} compact />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {widget.sections.length === 0 && widget.view === 'hourly' && widget.hours.length > 0 ? (
        <HourlyMetric hours={widget.hours} metric={widget.metric} />
      ) : null}

      {widget.sections.length === 0 && widget.view === 'composite' && widget.hours.length > 0 ? (
        <View style={styles.composite}>
          {compositeMetrics(widget.hours).map((id) => (
            <HourlyMetric key={id} hours={widget.hours} metric={id} compact />
          ))}
        </View>
      ) : null}

      {/* The rain view's hours are hours of RAIN — a temperature strip above a
          precipitation list is answering a question nobody asked (the user,
          2026-09-23). */}
      {widget.sections.length === 0 && widget.view === 'precip' && widget.hours.length > 0 ? (
        <HourlyMetric hours={widget.hours} metric="precip" />
      ) : null}

      {widget.sections.length === 0 && widget.view === 'conditions' && widget.hours.length > 0 ? (
        <HourStrip hours={widget.hours} />
      ) : null}

      {widget.sections.length === 0 && widget.days.length > 0 ? (
        <View style={styles.days}>
          {widget.days.map((day, i) =>
            widget.view === 'precip' ? (
              <PrecipRow key={`${day.label}-${i}`} day={day} peak={peak} />
            ) : (
              <DayRow key={`${day.label}-${i}`} day={day} scale={scale} now={i === 0 ? widget.temp : null} />
            ),
          )}
        </View>
      ) : null}
    </Card>
  );
}

// Hours scroll inside their own frame — the transcript never scrolls sideways.
function HourStrip({ hours }: { hours: WeatherHour[] }) {
  const { t, scheme } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.strip, { borderColor: t('border') }]}
      contentContainerStyle={styles.stripInner}
    >
      {hours.map((hour, i) => (
        <View key={`${hour.label}-${i}`} style={styles.hour} testID={`weather-hour-${i}`}>
          <Text style={[styles.hourLabel, { color: t('fg-3') }, MONO_FEATURES]} numberOfLines={1}>
            {hour.label}
          </Text>
          <WeatherGlyph condition={hour.condition} size={20} />
          <Text style={[styles.hourTemp, { color: t('fg-0') }, MONO_FEATURES]}>{degrees(hour.temp)}</Text>
          <Text style={[styles.hourRain, { color: hour.precip > 0 ? t('cat-transfer') : 'transparent' }, MONO_FEATURES]}>
            {`${Math.round(hour.precip)}%`}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function DayRow({
  day,
  scale,
  now,
}: {
  day: WeatherDay;
  scale: { min: number; max: number };
  now: number | null;
}) {
  const { t, scheme } = useTheme();
  const segments = bar(day, scale);
  const dot = nowAt(now, day, scale);

  return (
    <View style={styles.day} testID={`weather-day-${day.label}`}>
      <Text style={[styles.dayName, { color: t('fg-1') }]} numberOfLines={1}>
        {day.label}
      </Text>
      <View style={styles.daySky}>
        <WeatherGlyph condition={day.condition} size={17} />
        {day.precip > 0 ? (
          <Text style={[styles.dayRain, { color: waterColor(scheme) }, MONO_FEATURES]}>
            {`${Math.round(day.precip)}%`}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.dayLow, { color: t('fg-3') }, MONO_FEATURES]}>{day.low === null ? '' : degrees(day.low)}</Text>
      <View style={[styles.track, { backgroundColor: t('bg-3') }]}>
        {segments.map((segment, i) => (
          <View
            key={i}
            style={[
              styles.step,
              segment.filled ? { backgroundColor: heatColor(segment.heat, scheme) } : styles.stepEmpty,
            ]}
          />
        ))}
        {dot !== null ? (
          <View
            testID="weather-now-dot"
            style={[styles.dot, { left: `${dot * 100}%`, backgroundColor: t('fg-0'), borderColor: t('bg-1') }]}
          />
        ) : null}
      </View>
      <Text style={[styles.dayHigh, { color: t('fg-0') }, MONO_FEATURES]}>{day.high === null ? '' : degrees(day.high)}</Text>
    </View>
  );
}

/** One measure across one day, drawn the way the rest of this card is drawn.
 *
 * The app's own chart components were the obvious reuse and the wrong look:
 * they are built for money, and a weather card that renders like a stock chart
 * is not a weather card ("make sure they really look like weather widgets but
 * show the data clearly", the user 2026-09-23). So: a column per hour, coloured by
 * the same heat ramp the daily bars use, water-blue for anything to do with
 * rain, with night behind it and the day's peak called out. Same visual family
 * as the rest of the widget, no new drawing engine.
 */
function HourlyMetric({
  hours,
  metric: id,
  compact = false,
}: {
  hours: WeatherHour[];
  metric: MetricId;
  compact?: boolean;
}) {
  const { t, scheme } = useTheme();
  const metric = METRICS[id];
  const bars = columns(hours, metric);
  if (bars.length === 0) return null;

  const wet = id === 'precip' || id === 'humidity' || id === 'cloud';
  const height = compact ? 56 : 92;
  const now = bars[0];
  const peak = bars.find((c) => c.peak) ?? now;

  return (
    <View style={styles.metric} testID={`weather-metric-${id}`}>
      <View style={styles.metricHead}>
        <Text style={[styles.metricLabel, { color: t('fg-2') }]}>{metric.label}</Text>
        <Text style={[styles.metricNow, { color: t('fg-0') }, MONO_FEATURES]}>{metric.format(now.value)}</Text>
      </View>

      <View style={[styles.plot, { height, backgroundColor: t('bg-3') }]}>
        {bars.map((column, i) => (
          <View key={`${column.label}-${i}`} style={styles.slot}>
            {/* Night is drawn behind the hour rather than beside it, so the
                shape of the day is legible before any label is read. */}
            {column.night ? <View style={[styles.night, { backgroundColor: t('bg-0') }]} /> : null}
            <View
              style={[
                styles.column,
                {
                  height: `${column.height * 100}%`,
                  backgroundColor: wet ? waterColor(scheme) : heatColor(column.heat, scheme),
                  opacity: column.night && !wet ? 0.82 : 1,
                },
              ]}
            />
          </View>
        ))}
      </View>

      <View style={styles.axis}>
        {bars.map((column, i) => (
          <Text
            key={`${column.label}-${i}`}
            numberOfLines={1}
            style={[styles.axisLabel, { color: t('fg-3') }, MONO_FEATURES]}
          >
            {hourTick(column.label, i, bars.length)}
          </Text>
        ))}
      </View>

      {!compact ? (
        <Text style={[styles.metricFoot, { color: t('fg-3') }, MONO_FEATURES]}>
          {`peak ${metric.format(peak.value)} at ${peak.label}`}
        </Text>
      ) : null}
    </View>
  );
}

/** Apple's precipitation row: the day, its hours as a sparkline, the inches it
 * adds up to, and the chance. The sparkline is the part worth having — "60%
 * today" and "60%, all of it after 4pm" are different days. */
function PrecipRow({ day, peak }: { day: WeatherDay; peak: number }) {
  const { t, scheme } = useTheme();
  const water = waterColor(scheme);
  const hours = day.precip_hours.length > 0 ? day.precip_hours : [day.precip];
  const dry = day.precip === 0 && (day.precip_in ?? 0) === 0;

  return (
    <View style={styles.day} testID={`weather-precip-${day.label}`}>
      <Text style={[styles.dayName, { color: t('fg-1') }]} numberOfLines={1}>
        {day.label}
      </Text>
      <View style={[styles.spark, { backgroundColor: t('bg-3') }]}>
        {hours.map((chance, i) => (
          <View key={i} style={styles.sparkSlot}>
            <View
              style={[
                styles.sparkBar,
                {
                  height: `${Math.max(chance > 0 ? 8 : 0, Math.min(100, (chance / peak) * 100))}%`,
                  backgroundColor: water,
                },
              ]}
            />
          </View>
        ))}
      </View>
      <Text style={[styles.inches, { color: dry ? t('fg-3') : t('fg-0') }, MONO_FEATURES]}>
        {day.precip_in === null ? '' : `${day.precip_in.toFixed(day.precip_in >= 1 ? 1 : 2)}"`}
      </Text>
      <Text style={[styles.chance, { color: dry ? t('fg-3') : water }, MONO_FEATURES]}>
        {`${Math.round(day.precip)}%`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  place: { fontFamily: fonts.sans(600), fontSize: 14.5, lineHeight: 20, letterSpacing: -0.1 },
  summary: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 17 },
  headNow: { alignItems: 'flex-end', flexShrink: 0 },
  now: { fontFamily: fonts.mono(600), fontSize: 26, lineHeight: 30 },
  feels: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.3 },

  strip: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  stripInner: { paddingVertical: 9, gap: 2 },
  hour: { alignItems: 'center', width: 46, gap: 5 },
  hourLabel: { fontFamily: fonts.mono(550), fontSize: 9.5, letterSpacing: 0.4 },
  hourTemp: { fontFamily: fonts.mono(550), fontSize: 12.5 },
  hourRain: { fontFamily: fonts.mono(400), fontSize: 9 },

  composite: { gap: 14 },
  sections: { gap: 16 },
  section: { gap: 8 },
  sectionTitle: { fontFamily: fonts.sans(600), fontSize: 12.5, letterSpacing: -0.1 },
  metric: { gap: 4 },
  metricHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  metricLabel: { fontFamily: fonts.sans(550), fontSize: 12.5 },
  metricNow: { fontFamily: fonts.mono(600), fontSize: 13 },
  plot: { flexDirection: 'row', alignItems: 'flex-end', borderRadius: 6, overflow: 'hidden', gap: 1.5, paddingHorizontal: 2, paddingTop: 2 },
  slot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  night: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: 0.5 },
  column: { width: '100%', borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  axis: { flexDirection: 'row', gap: 1.5, paddingHorizontal: 2 },
  axisLabel: { flex: 1, fontSize: 8.5, textAlign: 'center' },
  metricFoot: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 0.3 },

  days: { gap: 7 },
  day: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dayName: { width: 42, fontFamily: fonts.sans(550), fontSize: 12.5 },
  daySky: { width: 40, alignItems: 'center', gap: 1 },
  dayRain: { fontFamily: fonts.mono(550), fontSize: 8.5 },
  dayLow: { width: 30, textAlign: 'right', fontFamily: fonts.mono(400), fontSize: 12 },
  // The bar is the widest thing in the row on purpose: it is what the row is
  // for, and the numbers are the footnote.
  track: { flex: 1, minWidth: 0, flexDirection: 'row', height: 7, borderRadius: 3.5, overflow: 'hidden' },
  step: { flex: 1, height: '100%' },
  stepEmpty: { backgroundColor: 'transparent' },
  dot: { position: 'absolute', top: -1.5, width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginLeft: -5 },
  dayHigh: { width: 32, textAlign: 'right', fontFamily: fonts.mono(600), fontSize: 12.5 },

  // Precipitation: the sparkline takes the room the temperature bar had, for
  // the same reason — it is what the row is for.
  spark: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-end', height: 22, borderRadius: 4, overflow: 'hidden', gap: 1, paddingHorizontal: 2, paddingBottom: 1 },
  sparkSlot: { flex: 1, justifyContent: 'flex-end' },
  sparkBar: { width: '100%', borderRadius: 1 },
  inches: { width: 42, textAlign: 'right', fontFamily: fonts.mono(550), fontSize: 11.5 },
  chance: { width: 38, textAlign: 'right', fontFamily: fonts.mono(600), fontSize: 12 },
});
