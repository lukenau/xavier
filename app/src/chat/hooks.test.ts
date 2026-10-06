// sendChatMessage/retryPayload are the pure(ish) core of the composer's send
// path — the dependency seam (SendChatMessageDeps) lets these be exercised
// directly, with fakes standing in for the store setters and the HTTP call,
// without rendering useSendMessage's hook (no other hook in this dir gets a
// render-based test either — see hooks.ts's own header comment: this module
// is glue between REST reads and the store, and the store/reducer paths it
// calls are what's unit-tested).
import { retryPayload, sendChatMessage, type SendChatMessageDeps } from './hooks';
import type { ChatMessage } from './types';

const THREAD = 't1';

function fakeDeps(chatSend: SendChatMessageDeps['chatSend']) {
  const store = new Map<string, ChatMessage>();
  const upsertLocalMessage = jest.fn((_threadId: string, message: ChatMessage) => {
    store.set(message.id, message);
  });
  const removeLocalMessage = jest.fn((_threadId: string, messageId: string) => {
    store.delete(messageId);
  });
  const deps: SendChatMessageDeps = { upsertLocalMessage, removeLocalMessage, chatSend };
  return { deps, store, upsertLocalMessage, removeLocalMessage };
}

describe('sendChatMessage: optimistic echo, then reconcile with the real row', () => {
  it('echoes immediately with status "sending", then replaces it with /send\'s real message', async () => {
    const real: ChatMessage = {
      id: 'msg_real1',
      thread_id: THREAD,
      seq: 7,
      version: 7,
      role: 'user',
      author_type: 'human',
      run_id: null,
      status: 'complete',
      client_msg_id: 'cid1',
      cron_run_id: null,
      created_at: '2026-09-17T00:00:00Z',
      updated_at: '2026-09-17T00:00:00Z',
      parts: [{ type: 'text', text: 'hello' }],
      forward_status: 'pending',
      forward_reason: 'gateway not configured',
    };
    const chatSend = jest.fn().mockResolvedValue({ message: real, deduped: false });
    const { deps, store, upsertLocalMessage, removeLocalMessage } = fakeDeps(chatSend);

    const promise = sendChatMessage(deps, THREAD, 'hello', 'cid1');

    // The echo lands synchronously, before the POST resolves.
    expect(upsertLocalMessage).toHaveBeenCalledTimes(1);
    expect(store.get('local:cid1')).toMatchObject({
      id: 'local:cid1',
      role: 'user',
      author_type: 'human',
      status: 'sending',
      client_msg_id: 'cid1',
      parts: [{ type: 'text', text: 'hello' }],
    });

    await promise;

    expect(chatSend).toHaveBeenCalledWith(THREAD, 'hello', 'cid1', undefined, undefined);
    expect(removeLocalMessage).toHaveBeenCalledWith(THREAD, 'local:cid1');
    // The placeholder is gone; only the reconciled, server-real row remains.
    expect(store.has('local:cid1')).toBe(false);
    expect(store.get('msg_real1')).toEqual(real);
    expect(store.size).toBe(1);
  });

  it('a dedup hit (deduped: true) still reconciles to the returned row, never leaving two copies', async () => {
    const existing: ChatMessage = {
      id: 'msg_existing',
      thread_id: THREAD,
      seq: 3,
      version: 3,
      role: 'user',
      author_type: 'human',
      run_id: null,
      status: 'complete',
      client_msg_id: 'cid1',
      cron_run_id: null,
      created_at: '2026-09-17T00:00:00Z',
      updated_at: '2026-09-17T00:00:00Z',
      parts: [{ type: 'text', text: 'hello' }],
      forward_status: 'forwarded',
    };
    const chatSend = jest.fn().mockResolvedValue({ message: existing, deduped: true });
    const { deps, store } = fakeDeps(chatSend);

    await sendChatMessage(deps, THREAD, 'hello', 'cid1');

    expect(store.size).toBe(1);
    expect(store.get('msg_existing')).toEqual(existing);
  });
});

describe('sendChatMessage: a failed POST flips the echo to "error" instead of losing it', () => {
  it('never throws; the placeholder survives, retryable, under the SAME local id', async () => {
    const chatSend = jest.fn().mockRejectedValue(new Error('network down'));
    const { deps, store } = fakeDeps(chatSend);

    await expect(sendChatMessage(deps, THREAD, 'hello', 'cid1')).resolves.toBeUndefined();

    const placeholder = store.get('local:cid1');
    expect(placeholder).toMatchObject({ status: 'error', client_msg_id: 'cid1' });
    expect(placeholder?.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('retry reuses the SAME client_msg_id', () => {
  it('retryPayload extracts the original text + client_msg_id from a failed local message', () => {
    const failed: ChatMessage = {
      id: 'local:cid1',
      thread_id: THREAD,
      seq: 1,
      version: 0,
      role: 'user',
      author_type: 'human',
      run_id: null,
      status: 'error',
      client_msg_id: 'cid1',
      cron_run_id: null,
      created_at: '',
      updated_at: '',
      parts: [{ type: 'text', text: 'hello' }],
    };
    expect(retryPayload(failed)).toEqual({ text: 'hello', clientMsgId: 'cid1' });
  });

  it('is null for a message with no client_msg_id or no text part — never invents one to retry', () => {
    const noClientId: ChatMessage = {
      id: 'msg_x',
      thread_id: THREAD,
      seq: 1,
      version: 1,
      role: 'assistant',
      author_type: 'agent',
      run_id: null,
      status: 'complete',
      client_msg_id: null,
      cron_run_id: null,
      created_at: '',
      updated_at: '',
      parts: [{ type: 'text', text: 'hi' }],
    };
    expect(retryPayload(noClientId)).toBeNull();

    const noTextPart: ChatMessage = { ...noClientId, client_msg_id: 'cid1', parts: [{ type: 'tool_call' }] };
    expect(retryPayload(noTextPart)).toBeNull();
  });

  it('end-to-end: a retry after a failed send calls chatSend again with the identical client_msg_id', async () => {
    const chatSend = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        message: {
          id: 'msg_real1',
          thread_id: THREAD,
          seq: 9,
          role: 'user',
          author_type: 'human',
          run_id: null,
          status: 'complete',
          client_msg_id: 'cid1',
          cron_run_id: null,
          created_at: '',
          updated_at: '',
          parts: [{ type: 'text', text: 'hello' }],
          forward_status: 'pending',
        },
        deduped: false,
      });
    const { deps, store } = fakeDeps(chatSend);

    await sendChatMessage(deps, THREAD, 'hello', 'cid1');
    const failed = store.get('local:cid1');
    expect(failed?.status).toBe('error');

    const payload = retryPayload(failed!);
    expect(payload).toEqual({ text: 'hello', clientMsgId: 'cid1' });
    await sendChatMessage(deps, THREAD, payload!.text, payload!.clientMsgId);

    expect(chatSend).toHaveBeenCalledTimes(2);
    expect(chatSend).toHaveBeenNthCalledWith(1, THREAD, 'hello', 'cid1', undefined, undefined);
    expect(chatSend).toHaveBeenNthCalledWith(2, THREAD, 'hello', 'cid1', undefined, undefined);
    expect(store.has('local:cid1')).toBe(false);
    expect(store.get('msg_real1')).toBeDefined();
  });
});

describe('what actually reaches the API call', () => {
  // The mode was accepted by sendChatMessage and dropped before chatSend, so
  // the composer's chip never left the app: Queue and Redirect did nothing,
  // and Steer only looked like it worked because the gateway's own config
  // said steer (2026-09-23).
  function deps() {
    const chatSend = jest.fn().mockResolvedValue({
      message: { id: 'm1', thread_id: 't1', seq: 1, role: 'user', parts: [] },
    });
    return { upsertLocalMessage: jest.fn(), removeLocalMessage: jest.fn(), chatSend };
  }

  it('carries the mode to the request', async () => {
    const d = deps();
    await sendChatMessage(d as never, 't1', 'wait for me', 'c1', 'queue');
    expect(d.chatSend).toHaveBeenCalledWith('t1', 'wait for me', 'c1', 'queue', undefined);
  });

  it('carries attachments to the request', async () => {
    const d = deps();
    await sendChatMessage(d as never, 't1', 'look at this', 'c2', undefined, ['med_1', 'med_2']);
    expect(d.chatSend).toHaveBeenCalledWith('t1', 'look at this', 'c2', undefined, ['med_1', 'med_2']);
  });
});

describe('what the socket is asked to replay', () => {
  // The screen subscribed from seq 0 on every open, so the socket replayed the
  // thread's whole history — thousands of intermediate upserts and deltas —
  // and when that replay was cut short the newest row was left at an early
  // state: "only the first few words are loading" (the user, 2026-09-28).
  it('is documented at the call site to be the snapshot version, not zero', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('./hooks.ts'), 'utf8');
    expect(src).toContain('socket.subscribe(threadId, query.data.thread.last_seq)');
    expect(src).not.toContain('socket.subscribe(threadId, 0)');
  });

  it('is, for the thread list, only a first cursor — never a re-subscribe on every poll', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('./hooks.ts'), 'utf8');
    expect(src).toContain('socket.subscribeIfNew(thread.id, thread.last_seq)');
    expect(src).not.toContain('socket.subscribe(thread.id, thread.last_seq)');
  });

  it('folds the server\'s open attention rows into the store on every bootstrap poll', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('./hooks.ts'), 'utf8');
    expect(src).toContain("usePoll<ChatAttentionResponse>(['chat-attention'], api.chatAttention");
    expect(src).toContain('reconcileAttention(attention.data.attention)');
  });
});
