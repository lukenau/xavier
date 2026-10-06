import { STALE_RUN_MS, turnStateOf } from './turnState';
import type { ChatMessage, Part } from './types';

// Every fixture row is stamped at this instant and every call reads the clock
// from here, so "is this run still moving" is exercised deliberately rather
// than depending on when the suite runs.
const NOW = Date.parse('2026-09-22T12:00:00Z');
const AT = new Date(NOW).toISOString();

let n = 0;
const msg = (role: ChatMessage['role'], status: string, parts: Part[] = [{ type: 'text', text: 'x' }]): ChatMessage => {
  n += 1;
  return {
    id: `m${n}`, thread_id: 't', seq: n, role, author_type: role === 'user' ? 'human' : 'agent',
    run_id: null, status, client_msg_id: null, cron_run_id: null,
    created_at: AT, updated_at: AT, parts,
  } as ChatMessage;
};

test('a streaming row in the newest run means it is working', () => {
  expect(turnStateOf([msg('user', 'complete'), msg('assistant', 'streaming')], NOW)).toBe('working');
});

test('my message with nothing after it and no acknowledgement is waiting', () => {
  expect(turnStateOf([msg('assistant', 'complete'), msg('user', 'complete')], NOW)).toBe('waiting');
});

test('the agent having the last word is idle', () => {
  expect(turnStateOf([msg('user', 'complete'), msg('assistant', 'complete')], NOW)).toBe('idle');
  expect(turnStateOf([], NOW)).toBe('idle');
});

test('a finished turn after a streaming one is idle again', () => {
  expect(turnStateOf([msg('assistant', 'complete'), msg('user', 'complete'), msg('assistant', 'complete')], NOW)).toBe('idle');
});

test('a message hub-api could not hand on is not "waiting" — nothing is coming', () => {
  const stuck = { ...msg('user', 'complete'), forward_status: 'pending', forward_reason: 'gateway unreachable' };
  expect(turnStateOf([stuck as ChatMessage], NOW)).toBe('undelivered');
});

test('the gateway taking the message is already "working" — not a grey dot', () => {
  const accepted = { ...msg('user', 'complete'), forward_status: 'forwarded' };
  expect(turnStateOf([accepted as ChatMessage], NOW)).toBe('working');
});

test('only an unacknowledged send is "waiting"', () => {
  // The POST is still in flight, or the row predates forward_status.
  expect(turnStateOf([msg('user', 'sending')], NOW)).toBe('waiting');
});

// --- a run the gateway died mid-way through -------------------------------------
// That row keeps `status: 'streaming'` for good — nothing ever finalizes it.
// Scanning the whole transcript pinned the ring, the Stop button and
// CommandSheet's gate to "working" days later.
const inRun = (runId: string | null, role: ChatMessage['role'], status: string): ChatMessage =>
  ({ ...msg(role, status), run_id: runId }) as ChatMessage;

test('a stale streaming row does not pin the thread to working once a newer send lands', () => {
  const dead = inRun('runA', 'assistant', 'streaming');
  const asked = inRun(null, 'user', 'complete');
  expect(turnStateOf([dead, asked], NOW)).toBe('waiting');
});

test('a stale streaming row does not survive a later finished turn', () => {
  const dead = inRun('runA', 'assistant', 'streaming');
  const asked = inRun(null, 'user', 'complete');
  const answered = inRun('runB', 'assistant', 'complete');
  expect(turnStateOf([dead, asked, answered], NOW)).toBe('idle');
});

test('a stale streaming row never masks the undelivered state of a newer send', () => {
  const dead = inRun('runA', 'assistant', 'streaming');
  const stuck = { ...inRun(null, 'user', 'complete'), forward_status: 'pending' } as ChatMessage;
  expect(turnStateOf([dead, stuck], NOW)).toBe('undelivered');
});

test('the newest run streaming IS working, stale row or no', () => {
  const dead = inRun('runA', 'assistant', 'streaming');
  const asked = inRun(null, 'user', 'complete');
  const live = inRun('runB', 'assistant', 'streaming');
  expect(turnStateOf([dead, asked, live], NOW)).toBe('working');
});

test('a tool card landing after the run\'s streaming prose row keeps it working', () => {
  // store.py keeps the streaming text row at its own seq while a tool_call
  // message from the SAME run is inserted above it — so the tail row of a live
  // run is routinely not the streaming one.
  const prose = inRun('runB', 'assistant', 'streaming');
  const tool = inRun('runB', 'assistant', 'complete');
  expect(turnStateOf([prose, tool], NOW)).toBe('working');
});


test('a run that stopped moving is not working, whatever its rows say', () => {
  // The turn was interrupted or the gateway died in it: the streamed rows stay
  // `streaming` for good and the ring used to spin until the user sent something
  // else (2026-09-22).
  const dead = inRun('runA', 'assistant', 'streaming');
  expect(turnStateOf([dead], NOW)).toBe('working');
  expect(turnStateOf([dead], NOW + STALE_RUN_MS + 1)).toBe('idle');
});

test('a long turn that is still writing stays working', () => {
  const old = inRun('runA', 'assistant', 'complete');
  const moving = { ...inRun('runA', 'assistant', 'streaming'), updated_at: new Date(NOW + STALE_RUN_MS).toISOString() };
  expect(turnStateOf([old, moving], NOW + STALE_RUN_MS + 1000)).toBe('working');
});
