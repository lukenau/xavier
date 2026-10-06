// Keeps the bundled fixtures current. They were recorded once (fixtures.json's
// `meta`), but the demo is opened days or months later, and a hub whose every
// timestamp is weeks old reads as broken: health probes stale, the brief
// yesterday's, the calendar empty. So every date in a fixture moves forward by
// the time since it was recorded, as the fixtures are loaded.
//
// "Now" means three different things in this data, so there are three clocks:
//   - an instant (a run, a message, a probe) moves by the elapsed time, floored
//     to whole hours: hourly buckets stay on the hour, and nothing that had
//     happened when the fixtures were recorded lands in the future;
//   - a calendar day (a brief's date, a chart's day bucket, a page slug) moves
//     by the days between the recording day and today on this phone, so
//     "today" is today wherever the phone is;
//   - a calendar event keeps its wall-clock time on its moved day, in this
//     phone's timezone (`floatingWallClock`): the 09:30 standup stays at 09:30
//     rather than following UTC to 02:30.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A date, optionally followed by a time — ISO with `T`, or the space-separated
 * form the cron log uses — with optional seconds, fraction and zone. Global and
 * stateless in use (String.replace resets lastIndex). */
const STAMP = /(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?/g;

/** Number fields that hold epoch time (seconds or milliseconds). By name only:
 * a byte count can fall in the same numeric range as a timestamp. */
const EPOCH_KEY = /^(ts|mtime|modified|last_active)$|_at$/;

export interface FixtureMeta {
  generated_at: string;
  anchor_date: string;
}

export interface Shifter {
  deltaMs: number;
  deltaDays: number;
  /** Deep copy of `input` with every date in it moved forward. */
  value<T>(input: T): T;
  text(input: string): string;
  /** The inverse, for a request path that carries a moved date back in. */
  unshiftText(input: string): string;
  floatingWallClock(iso: string): string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** `2026-10-06T09:30:00+02:00`: an instant written in this phone's own offset. */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function makeShifter(meta: FixtureMeta, now: Date = new Date()): Shifter {
  const deltaMs = Math.floor((now.getTime() - Date.parse(meta.generated_at)) / HOUR_MS) * HOUR_MS;
  const deltaDays = dayNumber(localDay(now)) - dayNumber(meta.anchor_date);

  function moveText(input: string, dir: 1 | -1): string {
    return input.replace(
      STAMP,
      (whole, y: string, m: string, d: string, sep?: string, hh?: string, mi?: string, rest?: string, zone?: string) => {
        if (sep === undefined) return isoDay(Date.UTC(+y, +m - 1, +d) + dir * deltaDays * DAY_MS);
        // A whole-hour move changes only the date and the hour, in any zone:
        // minutes, seconds, fraction and offset are carried over as written.
        const moved = new Date(Date.UTC(+y, +m - 1, +d, Number(hh)) + dir * deltaMs);
        return `${isoDay(moved.getTime())}${sep}${pad(moved.getUTCHours())}:${mi}${rest ?? ''}${zone ?? ''}`;
      },
    );
  }

  function moveValue(input: unknown, dir: 1 | -1, key?: string): unknown {
    if (typeof input === 'string') return moveText(input, dir);
    if (typeof input === 'number') {
      if (!key || !EPOCH_KEY.test(key)) return input;
      if (input >= 1e9 && input < 1e10) return input + (dir * deltaMs) / 1000;
      if (input >= 1e12 && input < 1e13) return input + dir * deltaMs;
      return input;
    }
    if (Array.isArray(input)) return input.map((item) => moveValue(item, dir, key));
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) out[moveText(k, dir)] = moveValue(v, dir, k);
      return out;
    }
    return input;
  }

  return {
    deltaMs,
    deltaDays,
    value: <T>(input: T) => moveValue(input, 1) as T,
    text: (input) => moveText(input, 1),
    unshiftText: (input) => moveText(input, -1),
    floatingWallClock(iso) {
      const match = new RegExp(STAMP.source).exec(iso);
      if (!match || match[4] === undefined) return moveText(iso, 1);
      const [, y, m, d, , hh, mi, rest] = match;
      const seconds = rest ? Number(rest.slice(1, 3)) : 0;
      return localIso(new Date(+y, +m - 1, +d + deltaDays, Number(hh), Number(mi), seconds));
    },
  };
}
