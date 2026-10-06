// The Chat tab's badge count (A11). It is read straight off the store by
// app/_layout.tsx, outside any screen that could wrap it in useMemo — so it
// has to be a primitive, and it has to agree with the list's own Needs-you
// section, which groups on `selectNeedsYouThreadIds`.
import { selectNeedsYouCount, selectNeedsYouThreadIds, selectPendingApprovals, useChatStore } from './store';
import type { AttentionInboxItem, AttentionUpsertFrame, ChatFrame, Thread } from './types';

function thread(id: string): Thread {
  return {
    id,
    kind: 'chat',
    title: null,
    status: 'idle',
    pinned: false,
    archived: false,
    last_seq: 1,
    created_at: '2026-09-22T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 0,
    unread: 1,
    preview: null,
    preview_role: null,
    hermes_session_id: null,
    origin_thread_id: null,
    origin_message_id: null,
  };
}

function attention(threadId: string, attentionId: string): AttentionUpsertFrame {
  return {
    type: 'attention.upsert',
    seq: 2,
    thread_id: threadId,
    attention_id: attentionId,
    kind: 'approval',
    request_id: 'r1',
    run_id: 'run1',
    summary: 'terminal: ls',
    message_id: null,
  };
}

afterEach(() => useChatStore.getState().reset());

test('counts threads that are waiting on the user, not attention rows', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  store.hydrateSnapshot(thread('brief'), []);
  store.applyFrame(attention('ops', 'att_1'));
  store.applyFrame(attention('ops', 'att_2'));
  expect(selectNeedsYouCount(useChatStore.getState())).toBe(1);
  store.applyFrame(attention('brief', 'att_3'));
  expect(selectNeedsYouCount(useChatStore.getState())).toBe(2);
});

test('an empty store badges nothing', () => {
  expect(selectNeedsYouCount(useChatStore.getState())).toBe(0);
});

test('an answered row stops counting', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  store.applyFrame(attention('ops', 'att_1'));
  store.applyFrame({
    type: 'approval.answered',
    thread_id: 'ops',
    run_id: 'run1',
    request_id: 'r1',
    choice: 'once',
  });
  expect(selectNeedsYouCount(useChatStore.getState())).toBe(0);
});

test('agrees with the thread list — the badge and the Needs-you section cannot disagree', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  store.hydrateSnapshot(thread('brief'), []);
  store.applyFrame(attention('brief', 'att_1'));
  const state = useChatStore.getState();
  expect(selectNeedsYouCount(state)).toBe(selectNeedsYouThreadIds(state.chat).size);
});

test('the same state returns the same number — a primitive is safe to select on directly', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  const state = useChatStore.getState();
  expect(selectNeedsYouCount(state)).toBe(selectNeedsYouCount(state));
});

// --- the server's own list of what is open ---------------------------------------
function inboxRow(id: string, threadId: string): AttentionInboxItem {
  return {
    id,
    thread_id: threadId,
    thread_title: null,
    thread_kind: 'chat',
    kind: 'question',
    summary: 'which one?',
    created_at: '2026-09-29T00:00:00Z',
    expires_at_derived: null,
  };
}

test('a row the server no longer lists stops badging — the resolving frame never had to arrive', () => {
  // "the chat tab … always has a red circle, even if there aren't new
  // messages" (the user, 2026-09-29): the row was answered while the socket was
  // dead, and nothing else ever told this client.
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  store.applyFrame(attention('ops', 'att_1'));
  expect(selectNeedsYouCount(useChatStore.getState())).toBe(1);
  store.reconcileAttention([]);
  expect(selectNeedsYouCount(useChatStore.getState())).toBe(0);
  expect(useChatStore.getState().chat.threads.ops.attention[0].state).toBe('answered');
});

test('a row the server lists that this client never saw badges its thread, without a signable card', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  store.reconcileAttention([inboxRow('att_9', 'ops'), inboxRow('att_10', 'brief')]);
  const state = useChatStore.getState();
  expect(selectNeedsYouCount(state)).toBe(2);
  expect(selectNeedsYouThreadIds(state.chat)).toEqual(new Set(['ops', 'brief']));
  expect(selectPendingApprovals(state.chat)).toEqual([]);
});

test('a list that changes nothing leaves the state untouched', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  store.applyFrame(attention('ops', 'att_1'));
  const before = useChatStore.getState().chat;
  store.reconcileAttention([inboxRow('att_1', 'ops')]);
  expect(useChatStore.getState().chat).toBe(before);
});

// --- iMessage drafts ride the approvals selector ---------------------------------
test('a draft approval is selectable, with its recipient / body / draft id read from the tool call', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  const frames: ChatFrame[] = [
    {
      type: 'attention.upsert', seq: 2, thread_id: 'ops', attention_id: 'att_d', kind: 'imessage_draft',
      request_id: 'rd', run_id: 'runD', summary: 'iMessage draft', message_id: 'md', expires_at_derived: null,
    },
    {
      type: 'message.upsert', seq: 3, thread_id: 'ops', message_id: 'md', role: 'assistant', author_type: 'agent',
      status: 'complete', run_id: 'runD',
      parts: [
        {
          type: 'tool_call', tool_name: 'draft_imessage', state: 'approval_requested', choices: ['once', 'deny'],
          args: { to: 'Mom', text: 'running late', draft_id: 9 },
        },
      ],
    },
  ];
  store.applyFrames(frames);
  const cards = selectPendingApprovals(useChatStore.getState().chat);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    thread_id: 'ops', attention_id: 'att_d', request_id: 'rd', run_id: 'runD',
    draft: { to: 'Mom', text: 'running late', draft_id: 9 },
  });
});

test('a draft-kind row with no readable args still selects as a draft, never as a plain approval', () => {
  const store = useChatStore.getState();
  store.hydrateSnapshot(thread('ops'), []);
  store.applyFrame({
    type: 'attention.upsert', seq: 2, thread_id: 'ops', attention_id: 'att_d2', kind: 'imessage_draft',
    request_id: 'rd2', run_id: 'runD2', summary: 'to Mom: forgot the keys', message_id: null, expires_at_derived: null,
  });
  const cards = selectPendingApprovals(useChatStore.getState().chat);
  expect(cards).toHaveLength(1);
  expect(cards[0].draft).toEqual({ to: null, text: null, draft_id: null });
});
