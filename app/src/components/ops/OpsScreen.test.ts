// The top jump-off card on Ops: what it links to, in order. Pure-logic test —
// the rows are a constant so they can be read without standing up the whole
// screen's query plumbing.
import { OPS_NAV_ROWS } from './OpsScreen';

test('Feed, Agent spend, then Terminal', () => {
  expect(OPS_NAV_ROWS.map((r) => r.label)).toEqual(['Feed', 'Agent spend', 'Terminal']);
  expect(OPS_NAV_ROWS.map((r) => r.href)).toEqual(['/ops/feed', '/ops/cost', '/ops/terminal']);
});
