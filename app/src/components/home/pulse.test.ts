// The pulse's two numbers, kept honest against the CSS keyframes
// (globals.css:40-43). The animation itself needs a device; these are the
// envelope and the geometry it is built from.
import { PULSE_DUTY, pulseScale } from './pulse';

test('the grow-and-fade occupies the first half of the cycle, not all of it', () => {
  // `0%,100% { … 0 0 0 0 … }  50% { … 0 0 0 6px transparent … }` — full
  // spread AND full transparency are both reached at the halfway mark, so a
  // single timing stretched over the whole duration reads at half speed.
  expect(PULSE_DUTY).toBe(0.5);
});

test('a halo scales to (radius + spread) / radius — the CSS spread is 6px', () => {
  expect(pulseScale(23)).toBeCloseTo(29 / 23, 10); // the 46px Xavier avatar
  expect(pulseScale(3.5)).toBeCloseTo(9.5 / 3.5, 10); // the 7px live dot
  expect(pulseScale(10, 5)).toBe(1.5);
});
