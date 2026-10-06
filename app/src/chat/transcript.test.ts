import { formatElapsed, groupTranscript, type TranscriptItem } from './transcript';
import type { ChatMessage, Part } from './types';

type AgentsItem = Extract<TranscriptItem, { kind: 'agents' }>;

/** A child's lifecycle row: `start` while it runs, `stop` landed in place. */
const child = (id: string, phase: 'start' | 'stop', over: Record<string, unknown> = {}): Part =>
  ({
    type: 'tool_call',
    tool_call_id: `subagent:${id}`,
    tool_name: 'delegate_task',
    args: { role: 'leaf' },
    status: phase === 'start' ? 'running' : 'complete',
    subagent: { child_session_id: id, child_role: 'leaf', phase, tool_call_count: null },
    ...over,
  }) as Part;

/** The parent's dispatch record — the only place the goals are named. */
const record = (goals: string[]): Part =>
  ({
    type: 'tool_call',
    tool_call_id: 'tc-dispatch',
    tool_name: 'delegate_task',
    status: 'complete',
    args: { tasks: goals.map((g) => ({ goal: g })) },
    result: JSON.stringify({ status: 'dispatched', mode: 'background', count: goals.length, goals }),
  }) as Part;

let n = 0;
function msg(role: ChatMessage['role'], parts: Part[], over: Partial<ChatMessage> = {}): ChatMessage {
  n += 1;
  return {
    id: `m${n}`, thread_id: 't', seq: n, version: n, role, author_type: role === 'user' ? 'human' : 'agent',
    run_id: 'r1', status: 'complete', client_msg_id: null, cron_run_id: null,
    created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z', parts, ...over,
  };
}
const tool = (over: Partial<Part> = {}): Part =>
  ({ type: 'tool_call', tool_name: 'terminal', status: 'complete', duration_ms: 1000, ...over }) as Part;
const text = (t = 'hi'): Part => ({ type: 'text', text: t });

test('a turn of quiet tool calls collapses into one activity item', () => {
  const items = groupTranscript([
    msg('user', [text('go')]),
    msg('assistant', [{ type: 'reasoning', text: '' }, tool()]),
    msg('assistant', [tool({ duration_ms: 7000 })]),
    msg('assistant', [tool({ duration_ms: 500 })]),
    msg('assistant', [text('done')]),
  ]);
  expect(items.map((i) => i.kind)).toEqual(['message', 'activity', 'message']);
  const activity = items[1];
  if (activity.kind !== 'activity') throw new Error('expected activity');
  expect(activity.toolCount).toBe(3);
  expect(activity.durationMs).toBe(8500);
  expect(activity.parts).toHaveLength(4);
});

test('an error never collapses — it stays its own row, in place', () => {
  const items = groupTranscript([
    msg('assistant', [tool()]),
    msg('assistant', [tool({ status: 'error', error: 'boom' })]),
    msg('assistant', [tool()]),
  ]);
  expect(items.map((i) => i.kind)).toEqual(['activity', 'message', 'activity']);
});

test('an approval request never collapses', () => {
  const items = groupTranscript([
    msg('assistant', [tool()]),
    msg('assistant', [tool({ state: 'approval_requested', status: 'running' })]),
  ]);
  expect(items.map((i) => i.kind)).toEqual(['activity', 'message']);
});

test('a running call stays visible rather than folding away mid-turn', () => {
  const items = groupTranscript([msg('assistant', [tool({ status: 'running', duration_ms: null })])]);
  expect(items.map((i) => i.kind)).toEqual(['message']);
});

test('a streaming message is never swallowed', () => {
  const items = groupTranscript([msg('assistant', [tool()], { status: 'streaming' })]);
  expect(items.map((i) => i.kind)).toEqual(['message']);
});

test('user messages and prose are untouched', () => {
  const items = groupTranscript([msg('user', [text('a')]), msg('assistant', [text('b')])]);
  expect(items.map((i) => i.kind)).toEqual(['message', 'message']);
});

test('an empty transcript groups to nothing', () => {
  expect(groupTranscript([])).toEqual([]);
});

// Prose after a heartbeat used to leave the heartbeat on screen above it.
// That is what the user hit on 2026-10-01 — an empty "Working" card stuck in the
// thread after the turn, with the real messages under it — so a superseded
// heartbeat is now dropped entirely (transcript.dedupe.test.ts covers that,
// and that the prose itself still shows). What this test still pins is the
// collapse: many heartbeats, only the newest.
test('heartbeats collapse to the newest one', () => {
  const items = groupTranscript([
    msg('assistant', [text('⏳ Working — 1 min — iteration 2/60, starting')]),
    msg('assistant', [text('⏳ Working — 3 min — iteration 9/60, waiting for provider response')]),
  ]);
  expect(items.map((i) => i.kind)).toEqual(['progress']);
  const p = items[0];
  if (p.kind !== 'progress') throw new Error('expected progress');
  expect(p.progress.iteration).toBe(9);
  expect(p.progress.elapsed).toBe('3 min');
});

test('a delegated task never collapses — it has a role and a report to show', () => {
  const items = groupTranscript([
    msg('assistant', [tool()]),
    msg('assistant', [
      tool({
        tool_name: 'delegate_task',
        args: { role: 'researcher', goal: 'read the docs' },
        subagent: { child_session_id: 'c1', child_role: 'researcher', phase: 'stop', tool_call_count: 4 },
      }),
    ]),
    msg('assistant', [tool()]),
  ]);
  expect(items.map((i) => i.kind)).toEqual(['activity', 'agents', 'activity']);
});

// --- a delegation is one block ------------------------------------------------
test('four starts and their dispatch record fold into one block, named from the record', () => {
  // The shape of 2026-09-29: four "leaf" children with no goal of their own,
  // then the parent's dispatch record naming the four goals in order.
  const items = groupTranscript([
    msg('assistant', [text('Dispatching four.')]),
    msg('assistant', [child('c1', 'start')]),
    msg('assistant', [child('c2', 'start')]),
    msg('assistant', [child('c3', 'start')]),
    msg('assistant', [child('c4', 'start')]),
    msg('assistant', [record(['meetings', 'email', 'calendar', 'slack'])]),
    msg('assistant', [tool()]),
  ]);
  expect(items.map((i) => i.kind)).toEqual(['message', 'agents', 'activity']);
  const block = items[1] as AgentsItem;
  expect(block.agents.map((a) => a.goal)).toEqual(['meetings', 'email', 'calendar', 'slack']);
  expect(block.running).toBe(4);
  expect(block.failed).toBe(0);
});

test('a stop landed on its start turns the block done, spanning the two stamps', () => {
  const items = groupTranscript([
    msg('assistant', [child('c1', 'stop', { duration_ms: 87_000 })], {
      created_at: '2026-09-29T21:14:00Z',
      updated_at: '2026-09-29T21:15:27Z',
    }),
    msg('assistant', [record(['meetings'])], { created_at: '2026-09-29T21:14:01Z', updated_at: '2026-09-29T21:14:01Z' }),
  ]);
  const block = items[0] as AgentsItem;
  expect(block.kind).toBe('agents');
  expect(block.running).toBe(0);
  expect(block.startedAt).toBe('2026-09-29T21:14:00.000Z');
  expect(block.endedAt).toBe('2026-09-29T21:15:27.000Z');
});

test('a dispatch record ahead of its children joins them', () => {
  const items = groupTranscript([
    msg('assistant', [record(['a', 'b'])]),
    msg('assistant', [child('c1', 'start')]),
    msg('assistant', [child('c2', 'start')]),
  ]);
  expect(items.map((i) => i.kind)).toEqual(['agents']);
  expect((items[0] as AgentsItem).agents.map((a) => a.goal)).toEqual(['a', 'b']);
});

test('a dispatch record with no children beside it is quiet work like any other', () => {
  const items = groupTranscript([msg('assistant', [tool()]), msg('assistant', [record(['a'])]), msg('assistant', [tool()])]);
  expect(items.map((i) => i.kind)).toEqual(['activity']);
  expect((items[0] as Extract<TranscriptItem, { kind: 'activity' }>).toolCount).toBe(3);
});

test('a failed child is counted, not hidden', () => {
  const items = groupTranscript([msg('assistant', [child('c1', 'stop', { status: 'error', error: 'timed out' })])]);
  expect((items[0] as AgentsItem).failed).toBe(1);
});

test('formatElapsed reads as a clock past a minute', () => {
  expect(formatElapsed(12)).toBe('12s');
  expect(formatElapsed(87)).toBe('1m 27s');
  expect(formatElapsed(600)).toBe('10m 00s');
});

test('an activity row reports how long the stretch took, not just the tools', () => {
  // Three quick tools spread over twenty-two seconds of the model deciding
  // between them. Summing the tools said "1s", which made the rest of the
  // time look like work that had gone missing.
  const items = groupTranscript([
    msg('assistant', [tool({ duration_ms: 100 })], { created_at: '2026-09-22T15:18:47Z', updated_at: '2026-09-22T15:18:47Z' }),
    msg('assistant', [tool({ duration_ms: 100 })], { created_at: '2026-09-22T15:18:56Z', updated_at: '2026-09-22T15:18:56Z' }),
    msg('assistant', [tool({ duration_ms: 200 })], { created_at: '2026-09-22T15:19:01Z', updated_at: '2026-09-22T15:19:09Z' }),
  ]);
  const activity = items[0];
  if (activity.kind !== 'activity') throw new Error('expected activity');
  expect(activity.durationMs).toBe(22_000);
});

test('a string duration adds nothing rather than concatenating', () => {
  const items = groupTranscript([
    msg('assistant', [tool({ duration_ms: 500 }), tool({ duration_ms: '900' as unknown as number })]),
  ]);
  const activity = items[0];
  if (activity.kind !== 'activity') throw new Error('expected activity');
  expect(activity.durationMs).toBe(500);
});
