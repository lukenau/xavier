import {
  clusterFailures,
  countsLine,
  deliverLabel,
  dayLabel,
  groupJobs,
  jobDot,
  jobPills,
  quickAsks,
  quietLine,
  quietSummary,
  quietTotal,
  runDot,
  runPills,
  scheduleLine,
  spanLabel,
} from './model';
import type { AutomationJob, RunSummary } from './types';

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'c0ffee000001:2026-09-28_21-00-20',
    job_id: 'c0ffee000001',
    job_name: 'ops-watch',
    category: 'ops',
    run_time: '2026-09-29T01:00:20Z',
    day: '2026-09-28',
    status: 'ok',
    severity: 'info',
    preview: 'backup stale',
    items: 0,
    unchanged: false,
    new_lines: 0,
    streak: 1,
    since: '2026-09-29T01:00:20Z',
    read: false,
    replies: 0,
    ...overrides,
  };
}

function job(overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: 'c0ffee000001',
    name: 'ops-watch',
    category: 'ops',
    schedule: '0 21 * * *',
    deliver: 'hub:ops',
    state: 'active',
    mode: 'script',
    next_run_at: null,
    last_status: 'ok',
    last_error: null,
    notify: 'push',
    snoozed_until: null,
    origin_thread: null,
    latest: run(),
    last_run: { run_time: '2026-09-29T01:00:20Z', status: 'ok' },
    unread: 0,
    needs_you: false,
    followups: 0,
    section: 'earlier',
    counts_30d: { runs: 30, reported: 11, silent: 19, failed: 0 },
    ...overrides,
  };
}

describe('groupJobs', () => {
  const jobs = [
    job({ id: 'a', section: 'needs_you', category: 'ops' }),
    job({ id: 'b', section: 'new', category: 'money' }),
    job({ id: 'c', section: 'earlier', category: 'personal' }),
    job({ id: 'o', section: 'earlier', category: 'ops', standing: true }),
    job({ id: 'd', section: 'quiet', category: 'background' }),
    job({ id: 'e', section: 'needs_you', category: 'background' }),
  ];

  test('every job lands in exactly one section', () => {
    const s = groupJobs(jobs, 'all');
    expect(s.needsYou.map((j) => j.id)).toEqual(['a', 'e']);
    expect(s.fresh.map((j) => j.id)).toEqual(['b']);
    expect(s.upToDate.map((j) => j.id)).toEqual(['c']);
    expect(s.stillOpen.map((j) => j.id)).toEqual(['o']);
    expect(s.quiet.map((j) => j.id)).toEqual(['d']);
    expect(s.needsYou.length + s.fresh.length + s.stillOpen.length + s.upToDate.length + s.quiet.length).toBe(jobs.length);
  });

  test('a category filter narrows every section but Needs you', () => {
    const s = groupJobs(jobs, 'money');
    expect([s.needsYou, s.fresh, s.stillOpen, s.upToDate, s.quiet].map((l) => l.map((j) => j.id))).toEqual([['a', 'e'], ['b'], [], [], []]);
  });

  test('an unknown section from a newer server is shown, folded, not dropped', () => {
    expect(groupJobs([job({ section: 'something-new' })], 'all').quiet).toHaveLength(1);
  });
});

describe('clusterFailures', () => {
  const failing = (id: string, fingerprint: string) =>
    job({ id, name: id, section: 'needs_you', needs_you: true, latest: run({ severity: 'failed', fingerprint, preview: 'Script exited with code 28' }) });

  test('jobs failing one way become one entry, where the first of them stood', () => {
    const jobs = [
      job({ id: 'ops', section: 'needs_you', latest: run({ severity: 'warn', fingerprint: 'w' }) }),
      failing('candle-1', 'x'),
      failing('brief-verify', 'y'),
      failing('candle-2', 'x'),
      failing('candle-3', 'x'),
    ];
    const entries = clusterFailures(jobs);
    expect(entries.map((e) => (e.kind === 'job' ? e.job.id : `cluster:${e.jobs.map((j) => j.id).join(',')}`))).toEqual([
      'ops',
      'cluster:candle-1,candle-2,candle-3',
      'brief-verify',
    ]);
    expect(entries[1]).toMatchObject({ preview: 'Script exited with code 28' });
  });

  test('two are not a pattern, and a warning is never clustered', () => {
    expect(clusterFailures([failing('a', 'x'), failing('b', 'x')]).map((e) => e.kind)).toEqual(['job', 'job']);
    const warnings = ['a', 'b', 'c'].map((id) => job({ id, latest: run({ severity: 'warn', fingerprint: 'same' }) }));
    expect(clusterFailures(warnings).map((e) => e.kind)).toEqual(['job', 'job', 'job']);
  });

  test('a run with no fingerprint stands alone', () => {
    const jobs = ['a', 'b', 'c'].map((id) => job({ id, latest: run({ severity: 'failed', fingerprint: '' }) }));
    expect(clusterFailures(jobs)).toHaveLength(3);
  });
});

describe('pills', () => {
  test('a warning counts its issues', () => {
    expect(runPills(run({ severity: 'warn', items: 4 }))).toEqual([{ label: '4 issues', tone: 'warn' }]);
    expect(runPills(run({ severity: 'warn', items: 1 }))[0].label).toBe('1 issue');
    expect(runPills(run({ severity: 'warn', items: 0 }))[0].label).toBe('Warning');
  });

  test('a repeat says how long it has been the same, a change says what is new', () => {
    expect(runPills(run({ unchanged: true, streak: 3 }))).toEqual([{ label: 'Same for 3 runs', tone: 'plain' }]);
    expect(runPills(run({ new_lines: 1 }))).toEqual([{ label: '1 new line', tone: 'accent' }]);
    expect(runPills(run({ new_lines: 3 }))[0].label).toBe('3 new lines');
  });

  test('alerts, failures and replies', () => {
    expect(runPills(run({ severity: 'alert', replies: 2 }))).toEqual([
      { label: 'Alert', tone: 'down' },
      { label: '2 replies', tone: 'petrol' },
    ]);
    expect(runPills(run({ severity: 'failed', replies: 1 }))).toEqual([
      { label: 'Failed', tone: 'down' },
      { label: '1 reply', tone: 'petrol' },
    ]);
  });

  test('a job adds what is true of the job', () => {
    const labels = jobPills(
      job({ state: 'paused', notify: 'quiet', snoozed_until: '2026-10-01T00:00:00Z', unread: 3, origin_thread: { id: 't', title: 'statements' } }),
    ).map((p) => p.label);
    expect(labels).toEqual(['3 unread', 'Paused', 'Snoozed', 'Quiet', 'Set up in a chat']);
    // A job row never says "new lines": that is a diff, and it read as unread.
    expect(jobPills(job({ latest: run({ new_lines: 3 }) })).map((p) => p.label)).toEqual([]);
    expect(jobPills(job({ latest: null }))).toEqual([]);
  });
});

describe('a job row says where it stands now', () => {
  test('an alert a later run cleared says Cleared, not Alert', () => {
    const cleared = job({ standing: false, latest: run({ severity: 'alert' }) });
    expect(jobPills(cleared).map((p) => p.label)).toEqual(['Cleared']);
    const standing = job({ standing: true, latest: run({ severity: 'alert', unchanged: true, streak: 7 }) });
    expect(jobPills(standing).map((p) => p.label)).toEqual(['Alert', 'Same for 7 runs']);
  });

  test('a seen alert that is still true is Still open, not Up to date', () => {
    const s = groupJobs([job({ id: 'cw', section: 'earlier', standing: true }), job({ id: 'ok', section: 'earlier' })], 'all');
    expect(s.stillOpen.map((j) => j.id)).toEqual(['cw']);
    expect(s.upToDate.map((j) => j.id)).toEqual(['ok']);
  });
});

describe('dots', () => {
  test('what is wrong wins over what is unread', () => {
    expect(jobDot(job({ needs_you: true, latest: run({ severity: 'warn' }) }))).toBe('status-warn');
    expect(jobDot(job({ needs_you: true, latest: run({ severity: 'alert' }) }))).toBe('status-down');
    expect(jobDot(job({ unread: 1 }))).toBe('accent');
    expect(jobDot(job())).toBe('fg-4');
  });

  test('a run he has opened goes quiet, and so does a repeat', () => {
    expect(runDot(run({ severity: 'warn' }))).toBe('status-warn');
    expect(runDot(run({ severity: 'warn', read: true }))).toBe('fg-4');
    expect(runDot(run({ unchanged: true }))).toBe('fg-4');
    expect(runDot(run())).toBe('accent');
  });
});

describe('lines', () => {
  test('a job with nothing to show says why', () => {
    expect(quietLine(job())).toBe('backup stale');
    expect(quietLine(job({ latest: null, counts_30d: { runs: 50, reported: 0, silent: 50, failed: 0 } }))).toBe(
      '50 runs in 30 days, nothing to report',
    );
    expect(quietLine(job({ latest: null, counts_30d: { runs: 0, reported: 0, silent: 0, failed: 0 } }))).toBe(
      'Has not run yet',
    );
    expect(
      quietLine(job({ latest: null, state: 'removed', counts_30d: { runs: 0, reported: 0, silent: 0, failed: 0 } })),
    ).toBe('No runs on record');
  });

  test('schedule and counts', () => {
    expect(scheduleLine(job())).toBe('0 21 * * * · script');
    expect(scheduleLine(job({ state: 'paused', mode: 'agent', schedule: null }))).toBe('agent · paused');
    expect(countsLine(job())).toBe('30 runs · 11 reported · 19 silent');
    expect(countsLine(job({ counts_30d: { runs: 1, reported: 0, silent: 0, failed: 1 } }))).toBe(
      '1 run · 0 reported · 0 silent · 1 failed',
    );
  });

  test('where a job sends is named, not quoted', () => {
    expect(deliverLabel('discord:100000000000000001,hub:ops')).toBe('Discord, Hub');
    expect(deliverLabel('local')).toBe('Nowhere, output is kept on file');
    expect(deliverLabel('origin')).toBe('The chat it was set up in');
    expect(deliverLabel(null)).toBe('Nowhere');
  });

  test('a day is a calendar day, not an instant', () => {
    const now = new Date(2026, 8, 29, 0, 5);
    expect(dayLabel('2026-09-29', now)).toBe('Today');
    expect(dayLabel('2026-09-28', now)).toBe('Yesterday');
    expect(dayLabel('2026-09-21', now)).toMatch(/Sep/);
  });

  test('the quiet runs of a day are one line', () => {
    const quiet = [
      { job_id: 'a', name: 'inbox-sweep', count: 121, silent: 121 },
      { job_id: 'b', name: 'oura-sync', count: 2, silent: 2 },
      { job_id: 'c', name: 'brief-derive', count: 1, silent: 1 },
      { job_id: 'd', name: 'brief-verify', count: 1, silent: 1 },
      { job_id: 'e', name: 'notes-sync-supermemory', count: 1, silent: 0 },
    ];
    expect(quietSummary(quiet)).toBe('inbox-sweep ×121 · oura-sync ×2 · brief-derive · 2 more');
    expect(quietTotal(quiet)).toBe(126);
    expect(quietSummary([])).toBe('');
  });

  test('a folded stretch says how many and when', () => {
    const label = spanLabel({ kind: 'span', span: 'silent', count: 19, from: '2026-09-02T12:00:00Z', to: '2026-09-21T12:00:00Z' });
    expect(label).toMatch(/^19 silent runs · Sep 2 – Sep 21$/);
    expect(spanLabel({ kind: 'span', span: 'unchanged', count: 1, from: '2026-09-22T12:00:00Z', to: '2026-09-22T12:00:00Z' })).toMatch(
      /^1 run, same output · Sep 22$/,
    );
  });

  test('one-tap asks follow what the run is', () => {
    expect(quickAsks({ severity: 'warn' })[0]).toBe('What should I do about this?');
    expect(quickAsks({ severity: 'failed' })).not.toContain('Run it again');
    expect(quickAsks({ severity: 'info' })).toEqual(['Summarize this', 'Anything I need to do?']);
  });
});
