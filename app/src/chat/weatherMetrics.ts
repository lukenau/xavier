// One day, hour by hour, in whichever measure you asked for.
//
// the user, 2026-09-23: "make more single day hourly views of the different weather
// metrics and composite ones too". Apple gives each measure its own card —
// temperature, precipitation, wind, humidity, UV — and that separation is the
// point: one line per card reads instantly, five lines on one axis read as
// nothing.
//
// Nothing here draws. It turns a day's hours into the `{series, buckets}` shape
// the app's existing chart components already take, so an hourly view is the
// chart primitives the rest of the app uses rather than a second way to draw.
import type { WeatherDay, WeatherHour } from './widget';

export type MetricId = 'temp' | 'feels' | 'precip' | 'wind' | 'humidity' | 'uv' | 'cloud';

export interface Metric {
  id: MetricId;
  label: string;
  /** A line for something continuous, bars for something that arrives in
   * quantities — rain does not interpolate between 2pm and 3pm. */
  shape: 'line' | 'bars';
  unit: string;
  format: (value: number) => string;
  /** Read off the hour, or null when this forecast did not carry it. */
  read: (hour: WeatherHour) => number | null;
}

const pct = (v: number) => `${Math.round(v)}%`;
const deg = (v: number) => `${Math.round(v)}°`;

export const METRICS: Record<MetricId, Metric> = {
  temp: {
    id: 'temp', label: 'Temperature', shape: 'line', unit: '°', format: deg,
    read: (h) => h.temp,
  },
  feels: {
    id: 'feels', label: 'Feels like', shape: 'line', unit: '°', format: deg,
    read: (h) => h.feels_like,
  },
  precip: {
    id: 'precip', label: 'Chance of rain', shape: 'bars', unit: '%', format: pct,
    read: (h) => h.precip,
  },
  wind: {
    id: 'wind', label: 'Wind', shape: 'line', unit: 'mph', format: (v) => `${Math.round(v)} mph`,
    read: (h) => h.wind,
  },
  humidity: {
    id: 'humidity', label: 'Humidity', shape: 'line', unit: '%', format: pct,
    read: (h) => h.humidity,
  },
  uv: {
    id: 'uv', label: 'UV index', shape: 'bars', unit: '', format: (v) => String(Math.round(v)),
    read: (h) => h.uv,
  },
  cloud: {
    id: 'cloud', label: 'Cloud cover', shape: 'line', unit: '%', format: pct,
    read: (h) => h.cloud,
  },
};

export function metricOf(raw: unknown): MetricId | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, MetricId> = {
    temperature: 'temp',
    feels_like: 'feels',
    apparent: 'feels',
    rain: 'precip',
    precipitation: 'precip',
    chance_of_rain: 'precip',
    wind_speed: 'wind',
    gust: 'wind',
    rh: 'humidity',
    uv_index: 'uv',
    clouds: 'cloud',
    cloud_cover: 'cloud',
  };
  return (key in METRICS ? (key as MetricId) : aliases[key]) ?? null;
}

/** Which measures this day actually carries — a card for a measure the
 * forecast never sent would be an empty axis. */
export function availableMetrics(hours: WeatherHour[]): MetricId[] {
  return (Object.keys(METRICS) as MetricId[]).filter((id) =>
    hours.some((h) => METRICS[id].read(h) !== null),
  );
}

export interface ChartData {
  series: { id: string; label: string }[];
  buckets: { key: string; values: Record<string, number>; total: number }[];
}

/** One measure across the hours given. `total` is carried because the bar
 * chart reads it; the line chart ignores it. */
export function hourlyChart(hours: WeatherHour[], metric: Metric): ChartData {
  const buckets = hours
    .map((hour) => {
      const value = metric.read(hour);
      return value === null ? null : { key: hour.label, values: { [metric.id]: value }, total: value };
    })
    .filter((b): b is ChartData['buckets'][number] => b !== null);
  return { series: [{ id: metric.id, label: metric.label }], buckets };
}

/** The composite: temperature over the chance of rain, the two measures that
 * answer "what is today like" together. They keep separate axes — a
 * temperature and a percentage on one scale is a chart that lies. */
export function compositeMetrics(hours: WeatherHour[]): MetricId[] {
  const has = availableMetrics(hours);
  return (['temp', 'precip', 'wind', 'humidity'] as MetricId[]).filter((id) => has.includes(id));
}

/** Every third hour, so a 24-hour axis is readable at phone width. */
export function hourTick(key: string, index: number, total: number): string {
  const every = total > 16 ? 4 : total > 8 ? 2 : 1;
  return index % every === 0 ? key : '';
}

export interface HourColumn {
  label: string;
  /** 0..1 of the chart's height. */
  height: number;
  /** 0..1 along the heat ramp, for metrics drawn warm. */
  heat: number;
  value: number;
  night: boolean;
  peak: boolean;
}

/** The columns one metric draws across a day.
 *
 * A temperature column starts from the day's coldest hour rather than from
 * zero — 60° to 80° is the story, and a bar from absolute zero tells none of
 * it. A percentage or a wind speed does start at zero, because there the
 * distance from nothing IS the story.
 */
export function columns(hours: WeatherHour[], metric: Metric): HourColumn[] {
  const read = hours.map((h) => ({ hour: h, value: metric.read(h) }));
  const values = read.map((r) => r.value).filter((v): v is number => v !== null);
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const zeroBased = metric.id !== 'temp' && metric.id !== 'feels';
  const min = zeroBased ? 0 : Math.min(...values);
  const span = max - min || 1;

  return read
    .map(({ hour, value }) =>
      value === null
        ? null
        : {
            label: hour.label,
            // A floor, so an hour at the day's minimum is still a column
            // rather than a gap in the row.
            height: Math.max(0.08, (value - min) / span),
            heat: (value - min) / span,
            value,
            night: hour.night,
            peak: value === max,
          },
    )
    .filter((c): c is HourColumn => c !== null);
}

/** The hours a section draws: optionally one day's, optionally a window. */
export function selectHours(
  hours: WeatherHour[],
  opts: { day?: number | null; from?: number | null; count?: number | null },
): WeatherHour[] {
  let out = hours;
  if (opts.day !== undefined && opts.day !== null) out = out.filter((h) => h.day === opts.day);
  if (opts.from !== undefined && opts.from !== null && opts.from > 0) out = out.slice(opts.from);
  if (opts.count !== undefined && opts.count !== null && opts.count >= 0) out = out.slice(0, opts.count);
  return out;
}

/** The first `count` days, or all of them when count is null. */
export function selectDays(days: WeatherDay[], count?: number | null): WeatherDay[] {
  if (count === undefined || count === null || count < 0) return days;
  return days.slice(0, count);
}
