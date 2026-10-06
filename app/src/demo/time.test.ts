import { localDay, makeShifter } from './time';

const META = { generated_at: '2026-10-06T17:02:19Z', anchor_date: '2026-10-06' };

/** Ten days and five hours (and some minutes) after the recording, local noon-ish. */
const NOW = new Date(Date.parse(META.generated_at) + (10 * 24 + 5) * 3_600_000 + 17 * 60_000);

test('instants move by the whole hours elapsed, keeping their own format', () => {
  const shift = makeShifter(META, NOW);
  expect(shift.deltaMs).toBe((10 * 24 + 5) * 3_600_000);
  expect(shift.text('2026-10-06T16:47:19Z')).toBe('2026-10-16T21:47:19Z');
  expect(shift.text('2026-10-06T09:02:19+00:00')).toBe('2026-10-16T14:02:19+00:00');
  expect(shift.text('2026-10-06T17:02:25.092340+00:00')).toBe('2026-10-16T22:02:25.092340+00:00');
  // The cron log's space-separated wall clock, and an hourly bucket key.
  expect(shift.text('2026-10-06 07:02:25')).toBe('2026-10-16 12:02:25');
  expect(shift.text('2026-10-06T00:00')).toBe('2026-10-16T05:00');
});

test('nothing recorded as past lands in the future', () => {
  const shift = makeShifter(META, NOW);
  const moved = Date.parse(shift.text('2026-10-06T17:02:19Z'));
  expect(moved).toBeLessThanOrEqual(NOW.getTime());
  expect(NOW.getTime() - moved).toBeLessThan(3_600_000);
});

test('calendar days move to the same day relative to today on this phone', () => {
  const shift = makeShifter(META, NOW);
  expect(shift.text('2026-10-06')).toBe(localDay(NOW));
  // Embedded in a slug, a path or a title, and as an object key.
  expect(shift.text('/my-pages/briefing-2026-10-06/')).toBe(`/my-pages/briefing-${localDay(NOW)}/`);
  const moved = shift.value({ by_day: { '2026-10-05': 1 } });
  expect(Object.keys(moved.by_day)).toHaveLength(1);
  expect(Object.keys(moved.by_day)[0] < localDay(NOW)).toBe(true);
});

test('epoch numbers move only under timestamp names, and the input is not mutated', () => {
  const shift = makeShifter(META, NOW);
  const input = { ts: 1_791_306_139, last_active: 1_791_305_544, started_at: 1_791_300_744, size: 1_791_306_139 };
  const out = shift.value(input);
  expect(out.ts - input.ts).toBe(shift.deltaMs / 1000);
  expect(out.last_active - input.last_active).toBe(shift.deltaMs / 1000);
  expect(out.started_at - input.started_at).toBe(shift.deltaMs / 1000);
  expect(out.size).toBe(input.size);
  expect(input.ts).toBe(1_791_306_139);
});

test('a moved request path moves back to the recorded one', () => {
  const shift = makeShifter(META, NOW);
  const path = '/files/browse?root=sites&path=my-pages/briefing-2026-10-06';
  expect(shift.unshiftText(shift.text(path))).toBe(path);
});

test('a calendar event keeps its wall-clock time on its moved day', () => {
  const shift = makeShifter(META, NOW);
  const moved = new Date(shift.floatingWallClock('2026-10-06T09:30:00+00:00'));
  expect(localDay(moved)).toBe(localDay(NOW));
  expect(moved.getHours()).toBe(9);
  expect(moved.getMinutes()).toBe(30);
});
