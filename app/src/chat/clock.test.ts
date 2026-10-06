import { clockOf } from './clock';

const NOW = new Date('2026-09-28T18:30:00Z');

it('is just the time for a message from today', () => {
  const s = clockOf('2026-09-28T14:05:00Z', NOW);
  expect(s).toMatch(/\d{1,2}:05/);
  expect(s).not.toMatch(/Sep|Mon/);
});

it('names the day for a message from another day this year', () => {
  expect(clockOf('2026-09-22T14:05:00Z', NOW)).toMatch(/Sep 22 · .*:05/);
});

it('names the year for a message from another year', () => {
  expect(clockOf('2025-12-31T14:05:00Z', NOW)).toMatch(/2025.*:05/);
});

it('says nothing for a stamp it cannot read', () => {
  expect(clockOf('', NOW)).toBe('');
  expect(clockOf('not a date', NOW)).toBe('');
});
