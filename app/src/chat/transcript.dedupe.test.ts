// One reply, shown once.
//
// Shape taken from the real incident (the user, 2026-10-01, "messages are double
// sending"): run aa2597a8 closed msg_73e27296 with 1721 characters of prose at
// 01:26:10, then opened msg_ea506f1a two seconds later carrying byte-identical
// prose. Both rows are real and both are in the store — the server writes them
// — so the transcript is where the second one stops being shown.
import { groupTranscript } from './transcript';
import type { ChatMessage, Part } from './types';

let n = 0;
function msg(role: ChatMessage['role'], parts: Part[], over: Partial<ChatMessage> = {}): ChatMessage {
  n += 1;
  return {
    id: `m${n}`, thread_id: 't', seq: n, version: n, role, author_type: role === 'user' ? 'human' : 'agent',
    run_id: 'r1', status: 'complete', client_msg_id: null, cron_run_id: null,
    created_at: '2026-10-01T01:26:10Z', updated_at: '2026-10-01T01:26:10Z', parts, ...over,
  };
}
const text = (t: string): Part => ({ type: 'text', text: t });
const tool = (over: Partial<Part> = {}): Part =>
  ({ type: 'tool_call', tool_name: 'terminal', status: 'complete', duration_ms: 1000, ...over }) as Part;

/** Every piece of prose the transcript would actually render, in order. */
function shown(messages: ChatMessage[]): ChatMessage[] {
  return groupTranscript(messages).flatMap((item) => (item.kind === 'message' ? [item.message] : []));
}

function prose(messages: ChatMessage[]): string[] {
  return shown(messages)
    .flatMap((m) => m.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text'))
    .map((p) => p.text);
}

const REPLY = 'Fixed. The cron section was printing each job’s error string raw, '.repeat(24);

test('the same reply streamed twice in one run is shown once', () => {
  const out = prose([
    msg('user', [text('fix the formatting on this')], { author_type: 'human' }),
    msg('assistant', [text(REPLY)]),
    msg('assistant', [text(REPLY)]),
  ]);
  expect(out.filter((t) => t === REPLY)).toHaveLength(1);
});

test('the same text in a DIFFERENT run is left alone', () => {
  const out = prose([
    msg('assistant', [text(REPLY)], { run_id: 'r1' }),
    msg('assistant', [text(REPLY)], { run_id: 'r2' }),
  ]);
  expect(out.filter((t) => t === REPLY)).toHaveLength(2);
});

test('two different replies in one run both stay', () => {
  const out = prose([
    msg('assistant', [text('Now running it against the live jobs.json.')]),
    msg('assistant', [text(REPLY)]),
  ]);
  expect(out).toHaveLength(2);
});

test('a reply that merely starts the same is not a duplicate', () => {
  const out = prose([
    msg('assistant', [text(`${REPLY}`)]),
    msg('assistant', [text(`${REPLY} And one more thing.`)]),
  ]);
  expect(out).toHaveLength(2);
});

test('a repeated short note still counts, so long as the run and the text match', () => {
  const out = prose([msg('assistant', [text('Done.')]), msg('assistant', [text('Done.')])]);
  expect(out).toHaveLength(1);
});

test('a message carrying a tool call is never hidden, even with identical text beside it', () => {
  const items = groupTranscript([
    msg('assistant', [text(REPLY)]),
    msg('assistant', [text(REPLY), tool({ tool_name: 'read_file' })]),
  ]);
  // The second message is not prose-only, so it survives untouched.
  const kept = items.flatMap((item) => (item.kind === 'message' ? [item.message] : []));
  expect(kept.some((m) => m.parts.some((p) => p.type === 'tool_call'))).toBe(true);
});

test('user messages are never deduped, however identical', () => {
  const out = prose([
    msg('user', [text('again')], { author_type: 'human' }),
    msg('user', [text('again')], { author_type: 'human' }),
  ]);
  expect(out).toHaveLength(2);
});

test('a row with no run_id is never deduped', () => {
  const out = prose([
    msg('assistant', [text(REPLY)], { run_id: null }),
    msg('assistant', [text(REPLY)], { run_id: null }),
  ]);
  expect(out).toHaveLength(2);
});

// A heartbeat is live status, not history (the user, 2026-10-01: an empty
// "Working" card "blocks every later message until I close and reopen").
const beat = (t = '⏳ Working — 3 min — iteration 6/60, waiting for provider response (streaming)') =>
  msg('assistant', [text(t)]);

test('a heartbeat with messages after it stops rendering as Working', () => {
  const items = groupTranscript([beat(), msg('assistant', [text('Leaving it as a draft.')])]);
  expect(items.filter((i) => i.kind === 'progress')).toHaveLength(0);
});

test('the newest heartbeat still shows while it is the last thing', () => {
  const items = groupTranscript([msg('assistant', [text('Working on it.')]), beat()]);
  expect(items.filter((i) => i.kind === 'progress')).toHaveLength(1);
});

test('a superseded heartbeat never hides the messages after it', () => {
  const later = 'Leaving it as a draft. Nothing sent.';
  const items = groupTranscript([beat(), msg('assistant', [text(later)])]);
  const shownText = items.flatMap((i) => (i.kind === 'message' ? [i.message] : []))
    .flatMap((m) => m.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text'))
    .map((p) => p.text);
  expect(shownText).toContain(later);
});

test('the Working card keeps one key across heartbeats, so its pulse is not restarted', () => {
  const keyOf = (messages: ChatMessage[]) => groupTranscript(messages).find((i) => i.kind === 'progress')?.key;
  const one = keyOf([beat('⏳ Working — 1 min — iteration 2/60, starting')]);
  const two = keyOf([
    beat('⏳ Working — 1 min — iteration 2/60, starting'),
    beat('⏳ Working — 3 min — iteration 9/60, waiting for provider response'),
  ]);
  expect(one).toBeDefined();
  expect(two).toBe(one);
});
