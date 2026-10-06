// Opening a thread after an approval was raised in it still draws the card.
// The socket resumes from the snapshot's cursor, past the frame that raised
// it, so the snapshot has to bring it (the user's wiring test, 2026-09-30).
import TestRenderer, { act } from 'react-test-renderer';
import { useChatStore, selectPendingApprovals } from './store';
import { useThreadDetail } from './hooks';
import type { ChatThreadDetailResponse, Thread } from './types';

let mockData: ChatThreadDetailResponse | undefined;
jest.mock('../lib/query', () => ({ usePoll: () => ({ data: mockData, error: null }) }));
jest.mock('./lock', () => ({ useChatLock: () => jest.fn() }));
jest.mock('./cache', () => ({ loadTail: () => Promise.resolve(null), saveTail: () => Promise.resolve() }));
jest.mock('./socket', () => ({ getChatSocket: () => ({ connect: jest.fn(), subscribe: jest.fn() }) }));
jest.mock('../lib/api', () => ({ api: {}, ApiError: class extends Error {}, newClientMsgId: () => 'x' }));

const thread = {
  id: 'thr_w', kind: 'chat', title: 'Wiring test', status: 'idle', pinned: false, archived: false,
  last_seq: 8, created_at: '', updated_at: '', last_read_seq: 0, unread: 0, preview: null,
  preview_role: null, hermes_session_id: null, origin_thread_id: null, origin_message_id: null,
} as Thread;

function Probe() {
  useThreadDetail('thr_w');
  return null;
}

afterEach(() => useChatStore.getState().reset());

test('the open approval in a thread snapshot becomes a signable card', () => {
  mockData = {
    thread,
    messages: [],
    attention: [{
      attention_id: 'att_1', kind: 'approval', request_id: 'req_9', run_id: 'run_9',
      summary: 'terminal: curl', message_id: null, state: 'open', expires_at_derived: null, created_at: '',
    }],
  };
  act(() => {
    TestRenderer.create(<Probe />);
  });
  const cards = selectPendingApprovals(useChatStore.getState().chat);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ thread_id: 'thr_w', request_id: 'req_9', run_id: 'run_9' });
});

test('a snapshot from an older hub-api, with no attention, still loads', () => {
  mockData = { thread, messages: [] };
  act(() => {
    TestRenderer.create(<Probe />);
  });
  expect(selectPendingApprovals(useChatStore.getState().chat)).toHaveLength(0);
});
