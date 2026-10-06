// Telegram-routing logic: the curated labels, the target list, and the
// multi-edit staging that makes this page the only one in the config tree
// that saves more than one change per Face-ID assertion.
import type { TopicsConfig } from '../../lib/types';
import {
  changedEntries,
  driftCheckedSuffix,
  FRIENDLY,
  footerNote,
  friendly,
  pluralRoutes,
  savePayload,
  stageEdit,
  targetOptions,
  topicLabel,
} from './routing';

const ROUTES: Record<string, string> = {
  'ops-watch': 'ops',
  'cron-watch': 'ops',
  'Daily Briefing — Personal': 'brief',
};

describe('friendly', () => {
  test('a curated job gets its label and cadence', () => {
    expect(friendly('ops-watch')).toEqual({ label: 'Ops watch', sub: 'nightly estate check · 21:00' });
    expect(friendly('Daily Briefing — Personal')).toEqual({
      label: 'Daily briefing',
      sub: 'personal · 7:35 daily',
    });
  });

  test('an unknown job keeps its raw name and reads as a plain cron job', () => {
    expect(friendly('some-new-job')).toEqual({ label: 'some-new-job', sub: 'cron job' });
  });

  test('the two host-side pseudo-routes are curated too', () => {
    // They are not cron jobs; the server marks them `pseudo` and the footer
    // explains them, so they must not fall through to the generic label.
    expect(FRIENDLY.healthcheck.sub).toBe('host script · every 5m');
    expect(FRIENDLY['imessage-approvals'].label).toBe('iMessage approvals');
  });
});

describe('targetOptions', () => {
  test('every topic, capitalised with its thread id, then the two pseudo-targets last', () => {
    expect(targetOptions({ brief: 2, ops: 15 })).toEqual([
      { value: 'brief', label: 'Brief · 2' },
      { value: 'ops', label: 'Ops · 15' },
      { value: 'dm', label: 'DM (no topic)' },
      { value: 'local', label: 'Local (no send)' },
    ]);
  });

  test('a topic with thread 0 shows no thread suffix', () => {
    // topicLabel's `thread ? …` guard: 0 is the General topic, which has no
    // thread id of its own.
    expect(topicLabel('general', 0)).toBe('General');
    expect(topicLabel('general')).toBe('General');
  });
});

describe('stageEdit / changedEntries — several routes per save', () => {
  test('picking a new target records it, and more than one at a time', () => {
    let edits = stageEdit({}, 'ops-watch', 'local', ROUTES);
    edits = stageEdit(edits, 'cron-watch', 'dm', ROUTES);
    expect(edits).toEqual({ 'ops-watch': 'local', 'cron-watch': 'dm' });
    expect(changedEntries(edits, ROUTES)).toEqual([
      ['ops-watch', 'local'],
      ['cron-watch', 'dm'],
    ]);
  });

  test('picking the ORIGINAL target again drops the edit entirely', () => {
    const edits = stageEdit(stageEdit({}, 'ops-watch', 'local', ROUTES), 'ops-watch', 'ops', ROUTES);
    expect(edits).toEqual({});
    expect(changedEntries(edits, ROUTES)).toEqual([]);
  });

  test('a route missing from the config file compares against empty, not undefined', () => {
    expect(stageEdit({}, 'brand-new', '', ROUTES)).toEqual({});
    expect(changedEntries({ 'brand-new': 'local' }, ROUTES)).toEqual([['brand-new', 'local']]);
  });

  test('the save payload is the WHOLE routes map with the edits applied', () => {
    // The gate binds the challenge to the canonical JSON of this object, so
    // sending only the diff would fail verification server-side.
    const config: TopicsConfig = { chat_id: '0000000000', topics: { ops: 15 }, routes: ROUTES };
    expect(savePayload(config, [['ops-watch', 'local']])).toEqual({
      chat_id: '0000000000',
      topics: { ops: 15 },
      routes: { ...ROUTES, 'ops-watch': 'local' },
    });
  });
});

describe('footer copy', () => {
  test('the drift stamp only appears when the live snapshot exists', () => {
    expect(driftCheckedSuffix(null)).toBe('');
    expect(driftCheckedSuffix('2026-09-10T14:05:00Z')).toMatch(/^ Drift checked .+\.$/);
  });

  test('the note counts configured topics', () => {
    expect(footerNote(5, null)).toBe(
      'Topics live in the Telegram DM (5 configured). “Local” keeps a job\'s output in the Hub feed only. ' +
        'Healthcheck + iMessage approvals are host-side senders that read the same config.',
    );
  });

  test('pluralisation is per-count', () => {
    expect(pluralRoutes(1, 'drifted')).toBe('1 route drifted');
    expect(pluralRoutes(2, 're-targeted')).toBe('2 routes re-targeted');
  });
});
