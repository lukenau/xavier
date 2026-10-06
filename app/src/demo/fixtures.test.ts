// The demo bridge once sent the spend summary's sessions as an object, and the Home
// spend tile and the Cost header printed "[object Object]".
const FIXTURES = require('./fixtures.json') as { routes: Record<string, { body: { sessions: unknown } }> };

test('every recorded spend summary counts its sessions with a number', () => {
  const summaries = Object.entries(FIXTURES.routes).filter(([route]) => route.startsWith('GET /spend/summary'));
  expect(summaries).toHaveLength(4);
  for (const [, response] of summaries) {
    expect(typeof response.body.sessions).toBe('number');
  }
});
