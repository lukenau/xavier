import { parseProgress } from './progress';

test('reads the gateway heartbeat the user saw', () => {
  expect(parseProgress('⏳ Working — 3 min — iteration 9/60, waiting for provider response (streaming)')).toEqual({
    elapsed: '3 min',
    iteration: 9,
    totalIterations: 60,
    detail: 'waiting for provider response (streaming)',
  });
});

test('copes with the shapes that carry less', () => {
  expect(parseProgress('Still working — 45s')).toEqual({
    elapsed: '45s', iteration: null, totalIterations: null, detail: null,
  });
  expect(parseProgress('⏳ Working')).toEqual({
    elapsed: null, iteration: null, totalIterations: null, detail: null,
  });
});

test('ordinary prose is never mistaken for a heartbeat', () => {
  expect(parseProgress('I am working through the list now and will report back')).not.toBeNull();
  expect(parseProgress('Done. The cron was failing quietly for six hours.')).toBeNull();
  expect(parseProgress('')).toBeNull();
  // A long paragraph that happens to contain the word is prose, not status.
  expect(parseProgress(`Working on it. ${'x'.repeat(250)}`)).toBeNull();
});
