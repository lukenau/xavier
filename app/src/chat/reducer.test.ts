import {
  applyLocalMessage,
  chatReducer,
  discardLocalMessage,
  initialChatState,
  mergeThreadSnapshot,
  type ChatState,
} from './reducer';
import { turnStateOf } from './turnState';
import type {
  ApprovalAnsweredFrame,
  AttentionUpsertFrame,
  ChatFrame,
  ChatMessage,
  MessageUpsertFrame,
  PartDeltaFrame,
  PartUpsertFrame,
  SnapshotRequiredFrame,
  Thread,
  ToolCallPart,
} from './types';

const THREAD = 't1';

function reduceAll(frames: ChatFrame[], state: ChatState = initialChatState): ChatState {
  return frames.reduce(chatReducer, state);
}

// --- streaming text assembled from deltas -----------------------------------
describe('streaming text turn assembled from deltas', () => {
  it('appends each delta onto the live part, in order', () => {
    const start: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'assistant',
      author_type: 'agent',
      status: 'streaming',
      run_id: 'run1',
      parts: [{ type: 'text', text: '' }],
    };
    const d1: PartDeltaFrame = { type: 'part.delta', seq: 2, thread_id: THREAD, message_id: 'm1', idx: 0, delta: 'Hello' };
    const d2: PartDeltaFrame = { type: 'part.delta', seq: 3, thread_id: THREAD, message_id: 'm1', idx: 0, delta: ' world' };

    const state = reduceAll([start, d1, d2]);
    const message = state.threads[THREAD].messages[0];
    expect(message.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('ignores a delta for an index that does not exist yet', () => {
    const start: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'assistant',
      author_type: 'agent',
      status: 'streaming',
      run_id: null,
      parts: [{ type: 'text', text: '' }],
    };
    const state1 = chatReducer(initialChatState, start);
    const badDelta: PartDeltaFrame = { type: 'part.delta', seq: 2, thread_id: THREAD, message_id: 'm1', idx: 5, delta: 'x' };
    const state2 = chatReducer(state1, badDelta);
    expect(state2).toBe(state1); // total: no crash, no change
  });
});

// --- tool call: running -> complete with args and result --------------------
describe('tool call going running to complete', () => {
  it('replaces the part in place, preserving unrelated fields via the new frame', () => {
    const running: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'assistant',
      author_type: 'agent',
      status: 'streaming',
      run_id: 'run1',
      parts: [{ type: 'tool_call', tool_call_id: 'tc1', tool_name: 'bash', args: { cmd: 'ls' }, status: 'running' }],
    };
    const complete: PartUpsertFrame = {
      type: 'part.upsert',
      seq: 2,
      thread_id: THREAD,
      message_id: 'm1',
      idx: 0,
      part: {
        type: 'tool_call',
        tool_call_id: 'tc1',
        tool_name: 'bash',
        args: { cmd: 'ls' },
        status: 'complete',
        result: 'file1\nfile2',
        duration_ms: 120,
      },
    };

    const state = reduceAll([running, complete]);
    const part = state.threads[THREAD].messages[0].parts[0] as ToolCallPart;
    expect(part.status).toBe('complete');
    expect(part.result).toBe('file1\nfile2');
    expect(part.duration_ms).toBe(120);
  });

  it('ignores a part.upsert for a message that has not arrived yet', () => {
    const frame: PartUpsertFrame = {
      type: 'part.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'ghost',
      idx: 0,
      part: { type: 'text', text: 'x' },
    };
    const state = chatReducer(initialChatState, frame);
    expect(state).toBe(initialChatState);
  });
});

// --- approval arriving and being answered ------------------------------------
describe('an approval arriving and being answered', () => {
  const attentionFrame: AttentionUpsertFrame = {
    type: 'attention.upsert',
    seq: 1,
    thread_id: THREAD,
    attention_id: 'att1',
    kind: 'approval',
    request_id: 'req1',
    run_id: 'run1',
    summary: 'terminal: ls',
    message_id: 'm1',
  };
  const messageFrame: MessageUpsertFrame = {
    type: 'message.upsert',
    seq: 2,
    thread_id: THREAD,
    message_id: 'm1',
    role: 'assistant',
    author_type: 'agent',
    status: 'complete',
    run_id: 'run1',
    parts: [{ type: 'tool_call', tool_name: 'terminal', state: 'approval_requested', choices: ['once', 'deny'] }],
  };
  const answeredFrame: ApprovalAnsweredFrame = {
    type: 'approval.answered',
    thread_id: THREAD,
    run_id: 'run1',
    request_id: 'req1',
    choice: 'once',
  };

  it('opens the attention row on arrival', () => {
    const state = reduceAll([attentionFrame, messageFrame]);
    expect(state.threads[THREAD].attention).toEqual([
      expect.objectContaining({ id: 'att1', kind: 'approval', state: 'open', request_id: 'req1' }),
    ]);
    const part = state.threads[THREAD].messages[0].parts[0] as ToolCallPart;
    expect(part.state).toBe('approval_requested');
  });

  it('resolves both the attention row and the linked tool_call part once answered', () => {
    const state = reduceAll([attentionFrame, messageFrame, answeredFrame]);
    expect(state.threads[THREAD].attention[0].state).toBe('answered');
    const part = state.threads[THREAD].messages[0].parts[0] as ToolCallPart;
    expect(part.state).toBe('answered');
    expect(part.resolved_choice).toBe('once');
  });

  it('is a no-op when nothing matches the answered frame', () => {
    const state = chatReducer(initialChatState, answeredFrame);
    expect(state).toBe(initialChatState);
  });
});

// --- out-of-order seq ----------------------------------------------------------
describe('out-of-order seq', () => {
  it('sorts messages by seq regardless of arrival order', () => {
    const second: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 2,
      thread_id: THREAD,
      message_id: 'm2',
      role: 'assistant',
      author_type: 'agent',
      status: 'complete',
      run_id: null,
      parts: [{ type: 'text', text: 'two' }],
    };
    const first: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'user',
      author_type: 'human',
      status: 'complete',
      run_id: null,
      parts: [{ type: 'text', text: 'one' }],
    };
    const state = reduceAll([second, first]); // arrives out of order
    expect(state.threads[THREAD].messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(state.threads[THREAD].messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

// --- duplicate frame (idempotent) ----------------------------------------------
describe('a duplicate frame is idempotent', () => {
  it('re-applying the identical message.upsert frame does not create a second message', () => {
    const frame: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'assistant',
      author_type: 'agent',
      status: 'complete',
      run_id: null,
      parts: [{ type: 'text', text: 'hi' }],
    };
    const once = chatReducer(initialChatState, frame);
    const twice = chatReducer(once, frame);
    expect(twice.threads[THREAD].messages).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it('re-applying the identical attention.upsert frame does not duplicate the row', () => {
    const frame: AttentionUpsertFrame = {
      type: 'attention.upsert',
      seq: 1,
      thread_id: THREAD,
      attention_id: 'att1',
      kind: 'mention',
      request_id: null,
      run_id: null,
      summary: 'hey',
      message_id: null,
    };
    const once = chatReducer(initialChatState, frame);
    const twice = chatReducer(once, frame);
    expect(twice.threads[THREAD].attention).toHaveLength(1);
    expect(twice).toEqual(once);
  });
});

// --- message.upsert merges onto the existing row --------------------------------
describe('message.upsert onto a row that already exists', () => {
  /** The row `/send` handed back: the ONLY source of forward_status. */
  function sentRow(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'msg_abc123',
      thread_id: THREAD,
      seq: 7,
      version: 7,
      role: 'user',
      author_type: 'human',
      run_id: null,
      status: 'complete',
      client_msg_id: 'cid1',
      cron_run_id: null,
      created_at: '2026-09-22T10:00:00Z',
      updated_at: '2026-09-22T10:00:01Z',
      parts: [{ type: 'text', text: 'hello' }],
      forward_status: 'forwarded',
      ...overrides,
    };
  }

  /** A later upsert of the same row — the server touching it again. It
   * carries no forward_status, and here no client_msg_id or timestamps
   * either (events written before 2026-09-29 have none). */
  const replay: MessageUpsertFrame = {
    type: 'message.upsert',
    seq: 8,
    message_seq: 7,
    thread_id: THREAD,
    message_id: 'msg_abc123',
    role: 'user',
    author_type: 'human',
    status: 'complete',
    run_id: null,
    parts: [{ type: 'text', text: 'hello' }],
  };

  it('keeps forward_status, client_msg_id and the timestamps the frame does not carry', () => {
    const seeded = applyLocalMessage(initialChatState, THREAD, sentRow());
    const row = chatReducer(seeded, replay).threads[THREAD].messages[0];

    expect(row.forward_status).toBe('forwarded');
    expect(row.client_msg_id).toBe('cid1');
    expect(row.created_at).toBe('2026-09-22T10:00:00Z');
    expect(row.updated_at).toBe('2026-09-22T10:00:01Z');
  });

  it('does not regress the turn indicator from working back to waiting', () => {
    const seeded = applyLocalMessage(initialChatState, THREAD, sentRow());
    expect(turnStateOf(seeded.threads[THREAD].messages)).toBe('working');

    const replayed = chatReducer(seeded, replay);
    expect(turnStateOf(replayed.threads[THREAD].messages)).toBe('working');
  });

  it('leaves "undelivered" reachable for a message the socket has touched', () => {
    const seeded = applyLocalMessage(
      initialChatState,
      THREAD,
      sentRow({ forward_status: 'pending', forward_reason: 'gateway unreachable' }),
    );
    const replayed = chatReducer(seeded, replay);

    expect(replayed.threads[THREAD].messages[0].forward_reason).toBe('gateway unreachable');
    expect(turnStateOf(replayed.threads[THREAD].messages)).toBe('undelivered');
  });

  it('still overlays every field the frame DOES carry', () => {
    const seeded = applyLocalMessage(
      initialChatState,
      THREAD,
      sentRow({ id: 'm1', status: 'streaming', role: 'assistant', author_type: 'agent', run_id: null, parts: [] }),
    );
    const done: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 9,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'assistant',
      author_type: 'agent',
      status: 'complete',
      run_id: 'runB',
      parts: [{ type: 'text', text: 'done' }],
    };
    const row = chatReducer(seeded, done).threads[THREAD].messages[0];

    expect(row.status).toBe('complete');
    expect(row.run_id).toBe('runB');
    // The event's seq is the row's new version, never its place.
    expect(row.seq).toBe(7);
    expect(row.version).toBe(9);
    expect(row.parts).toEqual([{ type: 'text', text: 'done' }]);
  });
});

// --- snapshot_required clears local state ---------------------------------------
describe('snapshot_required', () => {
  it('clears messages and attention but keeps the thread row', () => {
    const message: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'user',
      author_type: 'human',
      status: 'complete',
      run_id: null,
      parts: [{ type: 'text', text: 'hi' }],
    };
    const attention: AttentionUpsertFrame = {
      type: 'attention.upsert',
      seq: 2,
      thread_id: THREAD,
      attention_id: 'att1',
      kind: 'mention',
      request_id: null,
      run_id: null,
      summary: 'hey',
      message_id: null,
    };
    const patched = chatReducer(chatReducer(chatReducer(initialChatState, message), attention), {
      type: 'thread.patch',
      seq: 3,
      thread_id: THREAD,
      title: 'Kept',
    });

    const gap: SnapshotRequiredFrame = { type: 'snapshot_required', seq: 4, thread_id: THREAD };
    const state = chatReducer(patched, gap);

    expect(state.threads[THREAD].messages).toEqual([]);
    expect(state.threads[THREAD].attention).toEqual([]);
    expect(state.threads[THREAD].thread.title).toBe('Kept');
  });

  it('is a no-op for a thread that does not exist yet, beyond stubbing it', () => {
    const gap: SnapshotRequiredFrame = { type: 'snapshot_required', seq: 1, thread_id: 'ghost' };
    const state = chatReducer(initialChatState, gap);
    expect(state.threads.ghost.messages).toEqual([]);
    expect(state.threads.ghost.attention).toEqual([]);
  });

  it('keeps a failed local send — the server never saw it, so no REST read can bring it back', () => {
    const failed: ChatMessage = {
      id: 'local:cid1',
      thread_id: THREAD,
      seq: 1_700_000_000_000,
      version: 0,
      role: 'user',
      author_type: 'human',
      run_id: null,
      status: 'error',
      client_msg_id: 'cid1',
      cron_run_id: null,
      created_at: '2026-09-22T10:00:00Z',
      updated_at: '2026-09-22T10:00:00Z',
      parts: [{ type: 'text', text: 'the words the user typed' }],
    };
    const server: MessageUpsertFrame = {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'msg_abc123',
      role: 'assistant',
      author_type: 'agent',
      status: 'complete',
      run_id: null,
      parts: [{ type: 'text', text: 'server row, refetchable' }],
    };
    const seeded = applyLocalMessage(chatReducer(initialChatState, server), THREAD, failed);

    const gap: SnapshotRequiredFrame = { type: 'snapshot_required', seq: 4, thread_id: THREAD };
    const state = chatReducer(seeded, gap);

    expect(state.threads[THREAD].messages).toEqual([failed]);
  });
});

// --- unknown frame type ----------------------------------------------------------
describe('an unknown frame type', () => {
  it('is ignored, returning the exact same state reference', () => {
    const seeded = chatReducer(initialChatState, {
      type: 'message.upsert',
      seq: 1,
      thread_id: THREAD,
      message_id: 'm1',
      role: 'user',
      author_type: 'human',
      status: 'complete',
      run_id: null,
      parts: [{ type: 'text', text: 'hi' }],
    });
    const bogus = { type: 'something.new', seq: 99, thread_id: THREAD } as unknown as ChatFrame;
    const state = chatReducer(seeded, bogus);
    expect(state).toBe(seeded);
  });
});

// --- heartbeat -----------------------------------------------------------------
describe('heartbeat', () => {
  it('is a pure no-op', () => {
    const state = chatReducer(initialChatState, { type: 'heartbeat' });
    expect(state).toBe(initialChatState);
  });
});

// --- applyLocalMessage / discardLocalMessage (the composer's send path) ---------
describe('applyLocalMessage / discardLocalMessage', () => {
  function localMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'local:cid1',
      thread_id: THREAD,
      seq: 1_700_000_000_000,
      version: 0,
      role: 'user',
      author_type: 'human',
      run_id: null,
      status: 'sending',
      client_msg_id: 'cid1',
      cron_run_id: null,
      created_at: '',
      updated_at: '',
      parts: [{ type: 'text', text: 'hello' }],
      ...overrides,
    };
  }

  it('echoes a local message into an empty thread (optimistic send)', () => {
    const state = applyLocalMessage(initialChatState, THREAD, localMsg());
    expect(state.threads[THREAD].messages).toEqual([localMsg()]);
  });

  it('reconciliation: dropping the placeholder and upserting the real row leaves exactly one message', () => {
    const withEcho = applyLocalMessage(initialChatState, THREAD, localMsg());
    const real: ChatMessage = {
      ...localMsg(),
      id: 'msg_abc123',
      seq: 3,
      status: 'complete',
      forward_status: 'pending',
      forward_reason: 'gateway not configured',
    };
    const dropped = discardLocalMessage(withEcho, THREAD, 'local:cid1');
    const reconciled = applyLocalMessage(dropped, THREAD, real);

    expect(reconciled.threads[THREAD].messages).toEqual([real]);
  });

  it('re-applying the SAME local message id in place is idempotent (upsert-by-id, same as every other case)', () => {
    const once = applyLocalMessage(initialChatState, THREAD, localMsg());
    const failed = applyLocalMessage(once, THREAD, localMsg({ status: 'error' }));
    expect(failed.threads[THREAD].messages).toHaveLength(1);
    expect(failed.threads[THREAD].messages[0].status).toBe('error');
  });

  it('discardLocalMessage on an unknown id is a same-reference no-op', () => {
    const state = applyLocalMessage(initialChatState, THREAD, localMsg());
    const same = discardLocalMessage(state, THREAD, 'nope');
    expect(same).toBe(state);
  });

  it('discardLocalMessage on a thread that does not exist yet is a same-reference no-op', () => {
    const same = discardLocalMessage(initialChatState, 'ghost', 'local:cid1');
    expect(same).toBe(initialChatState);
  });
});

// --- mergeThreadSnapshot (REST hydration, not a WS frame) -----------------------
describe('mergeThreadSnapshot', () => {
  it('folds a REST thread + message-history read into the same shape frames produce', () => {
    const thread: Thread = {
      id: THREAD,
      kind: 'chat',
      title: 'Ops',
      status: 'idle',
      pinned: true,
      archived: false,
      last_seq: 1,
      created_at: '2026-09-17T00:00:00Z',
      updated_at: '2026-09-17T00:00:00Z',
      last_read_seq: 0,
      unread: 1,
      preview: 'ran the backup',
      preview_role: 'assistant',
      hermes_session_id: null,
      origin_thread_id: null,
      origin_message_id: null,
    };
    const state = mergeThreadSnapshot(initialChatState, thread, [
      {
        id: 'm1',
        thread_id: THREAD,
        seq: 1,
        version: 1,
        role: 'assistant',
        author_type: 'agent',
        run_id: null,
        status: 'complete',
        client_msg_id: null,
        cron_run_id: null,
        created_at: '2026-09-17T00:00:00Z',
        updated_at: '2026-09-17T00:00:00Z',
        parts: [{ type: 'text', text: 'hi' }],
      },
    ]);
    expect(state.threads[THREAD].thread).toEqual(thread);
    expect(state.threads[THREAD].messages).toHaveLength(1);

    // A second identical snapshot is idempotent, same as every frame case.
    const again = mergeThreadSnapshot(state, thread, state.threads[THREAD].messages);
    expect(again).toEqual(state);
  });
});

describe('the thread row keeps up with what arrives', () => {
  const thread = {
    id: 't1', kind: 'chat', title: null, status: 'idle', pinned: false, archived: false,
    last_seq: 1, created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 0, unread: 0,
  } as never;

  it('moves last_seq and updated_at when a message lands', () => {
    const seeded = mergeThreadSnapshot(initialChatState, thread, []);
    const before = seeded.threads.t1.thread.updated_at;
    const after = chatReducer(seeded, {
      type: 'message.upsert', seq: 9, thread_id: 't1', message_id: 'm1', role: 'assistant',
      author_type: 'agent', status: 'complete', run_id: null, parts: [{ type: 'text', text: 'hi' }],
      client_msg_id: null,
    } as never);
    expect(after.threads.t1.thread.last_seq).toBe(9);
    expect(after.threads.t1.thread.updated_at).not.toBe(before);
  });

  it('never moves the cursor backwards', () => {
    const seeded = mergeThreadSnapshot(initialChatState, { ...(thread as object), last_seq: 12 } as never, []);
    const after = chatReducer(seeded, {
      type: 'message.upsert', seq: 3, thread_id: 't1', message_id: 'm2', role: 'assistant',
      author_type: 'agent', status: 'complete', run_id: null, parts: [], client_msg_id: null,
    } as never);
    expect(after.threads.t1.thread.last_seq).toBe(12);
  });
});

test('a batch of frames folds into one state, in order', () => {
  const thread = {
    id: 't9', kind: 'chat', title: null, status: 'idle', pinned: false, archived: false,
    last_seq: 0, created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 0, unread: 0,
  } as never;
  const seeded = mergeThreadSnapshot(initialChatState, thread, []);
  const frames = [1, 2, 3].map((seq) => ({
    type: 'message.upsert', seq, thread_id: 't9', message_id: `m${seq}`, role: 'assistant',
    author_type: 'agent', status: 'complete', run_id: null,
    parts: [{ type: 'text', text: `m${seq}` }], client_msg_id: null,
  })) as never[];
  const folded = frames.reduce(chatReducer, seeded);
  expect(folded.threads.t9.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  expect(folded.threads.t9.thread.last_seq).toBe(3);
});

describe('a refetch that changes nothing changes nothing', () => {
  // the user, 2026-09-22: "sometimes when i open an older chat thread it flickers a
  // bit or things move around in a flash". Every snapshot used to hand every
  // row a new identity.
  const thread = (): Thread => ({
    id: THREAD, kind: 'chat', title: 't', status: 'idle', pinned: false, archived: false,
    last_seq: 1, created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 1, unread: 0, preview: null, preview_role: null,
    hermes_session_id: null, origin_thread_id: null, origin_message_id: null,
  });
  const row = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: 'm1', thread_id: THREAD, seq: 1, version: 1, role: 'assistant', author_type: 'agent', run_id: 'r1',
    status: 'complete', client_msg_id: null, cron_run_id: null,
    created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:01Z',
    parts: [{ type: 'text', text: 'hello' }], ...over,
  } as ChatMessage);

  it('keeps the same message objects when the server repeats itself', () => {
    const first = mergeThreadSnapshot(initialChatState, thread(), [row()]);
    const again = mergeThreadSnapshot(first, thread(), [row()]);
    expect(again.threads[THREAD].messages[0]).toBe(first.threads[THREAD].messages[0]);
  });

  it('still takes a row the server actually changed', () => {
    const first = mergeThreadSnapshot(initialChatState, thread(), [row()]);
    const edited = row({ version: 2, updated_at: '2026-09-22T00:00:09Z', parts: [{ type: 'text', text: 'hello there' }] });
    const again = mergeThreadSnapshot(first, thread(), [edited]);
    expect(again.threads[THREAD].messages[0]).toEqual(edited);
  });

  it('takes a row whose status moved even at the same timestamp', () => {
    const first = mergeThreadSnapshot(initialChatState, thread(), [row({ status: 'streaming' })]);
    const done = row({ version: 2, status: 'complete' });
    const again = mergeThreadSnapshot(first, thread(), [done]);
    expect(again.threads[THREAD].messages[0].status).toBe('complete');
  });

  // A cached tail (chat/cache.ts) can outlive the ids it was written under: a
  // re-seeded demo box, a restored store or a rebuilt chat DB hands back the same
  // conversation with fresh message ids. Matching on id alone left the cached row
  // beside its own replacement, and the thread printed every message twice.
  it('replaces a row the server reissued under a new id instead of stacking it', () => {
    const cached = mergeThreadSnapshot(initialChatState, thread(), [row()]);
    const reissued = row({ id: 'm1-reissued', seq: 1 });
    const after = mergeThreadSnapshot(cached, thread(), [reissued]);
    expect(after.threads[THREAD].messages).toHaveLength(1);
    expect(after.threads[THREAD].messages[0]).toEqual(reissued);
  });

  it('stacks a genuinely different message at a different seq', () => {
    const cached = mergeThreadSnapshot(initialChatState, thread(), [row()]);
    const next = row({ id: 'm2', seq: 2, parts: [{ type: 'text', text: 'second' }] });
    const after = mergeThreadSnapshot(cached, thread(), [next]);
    expect(after.threads[THREAD].messages.map((m) => m.seq)).toEqual([1, 2]);
  });
});

// --- versions: what makes a frame news ------------------------------------------
describe('versions', () => {
  const thread = (): Thread => ({
    id: THREAD, kind: 'chat', title: 't', status: 'idle', pinned: false, archived: false,
    last_seq: 1, created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 1, unread: 0, preview: null, preview_role: null,
    hermes_session_id: null, origin_thread_id: null, origin_message_id: null,
  });
  const opened: MessageUpsertFrame = {
    type: 'message.upsert', seq: 10, thread_id: THREAD, message_id: 'm1', role: 'assistant',
    author_type: 'agent', status: 'streaming', run_id: 'r1', parts: [{ type: 'text', text: 'Found the job.' }],
  };
  const delta = (seq: number, text: string, offset?: number, length?: number): PartDeltaFrame => ({
    type: 'part.delta', seq, thread_id: THREAD, message_id: 'm1', idx: 0, delta: text, offset, length,
  });

  it('applies a delta once, however many times the socket replays it', () => {
    // Two writers on one connection replayed the same range, and every
    // overlap appended the same words again: "Found the job. Let me read…"
    // three times in one bubble (the user, 2026-09-28).
    const once = reduceAll([opened, delta(11, ' Let me read it.')]);
    const twice = chatReducer(once, delta(11, ' Let me read it.'));
    expect(twice).toBe(once);
    expect(twice.threads[THREAD].messages[0].parts).toEqual([{ type: 'text', text: 'Found the job. Let me read it.' }]);
  });

  it('ignores an upsert older than the row it holds, returning the same state', () => {
    const state = reduceAll([opened, delta(11, ' More.')]);
    expect(chatReducer(state, { ...opened, seq: 10 })).toBe(state);
  });

  it('keeps the row where it was: the event seq is the version, not the place', () => {
    const later: MessageUpsertFrame = {
      ...opened, seq: 20, message_id: 'm2', status: 'complete', run_id: null, parts: [{ type: 'text', text: 'a card' }],
    };
    const closed: MessageUpsertFrame = { ...opened, seq: 40, message_seq: 10, status: 'complete' };
    const state = reduceAll([opened, later, closed]);
    expect(state.threads[THREAD].messages.map((m) => [m.id, m.seq, m.version, m.status])).toEqual([
      ['m1', 10, 40, 'complete'],
      ['m2', 20, 20, 'complete'],
    ]);
  });

  it('marks the row stale, and appends nothing, when a delta does not fit the text it holds', () => {
    // Cut from a 26-character text; this row holds 14 — something was missed.
    const state = chatReducer(reduceAll([opened]), delta(11, ' Let me read it.', 26, 42));
    const row = state.threads[THREAD].messages[0];
    expect(row.stale).toBe(true);
    expect(row.parts).toEqual([{ type: 'text', text: 'Found the job.' }]);
    expect(row.version).toBe(10);
  });

  it("appends when the delta fits, measured in the app's own units", () => {
    const state = chatReducer(reduceAll([opened]), delta(11, ' 👋', 14, 17));
    expect(state.threads[THREAD].messages[0].parts).toEqual([{ type: 'text', text: 'Found the job. 👋' }]);
    expect(state.threads[THREAD].messages[0].stale).toBeUndefined();
  });

  it('clears stale once a delta fits again — the same length is the same text', () => {
    const stale = chatReducer(reduceAll([opened]), delta(11, ' Let me read it.', 26, 42));
    expect(stale.threads[THREAD].messages[0].stale).toBe(true);
    const healed = chatReducer(stale, delta(12, ' Ok.', 14, 18));
    const row = healed.threads[THREAD].messages[0];
    expect(row.stale).toBeUndefined();
    expect(row.parts).toEqual([{ type: 'text', text: 'Found the job. Ok.' }]);
    expect(row.version).toBe(12);
  });

  it("keeps /send's own row over the socket's insert frame at the same version — forward_status lives only there", () => {
    // The socket's message.upsert for the new row lands first (one poll tick
    // away); the POST response, with forward_status, lands after. Same
    // version: the review found the gate discarding the response, and
    // "Sent — waiting" never became "Working…".
    const inserted: MessageUpsertFrame = {
      type: 'message.upsert', seq: 7, thread_id: THREAD, message_id: 'msg_s1', role: 'user',
      author_type: 'human', status: 'complete', run_id: null, parts: [{ type: 'text', text: 'hello' }],
      client_msg_id: 'cid1',
    };
    const fromSocket = chatReducer(initialChatState, inserted);
    const response: ChatMessage = {
      id: 'msg_s1', thread_id: THREAD, seq: 7, version: 7, role: 'user', author_type: 'human', run_id: null,
      status: 'complete', client_msg_id: 'cid1', cron_run_id: null, created_at: '2026-09-29T00:00:00Z',
      updated_at: '2026-09-29T00:00:00Z', parts: [{ type: 'text', text: 'hello' }], forward_status: 'forwarded',
    };
    const row = applyLocalMessage(fromSocket, THREAD, response).threads[THREAD].messages[0];
    expect(row.forward_status).toBe('forwarded');
    expect(row.version).toBe(7);
  });

  it('lets the snapshot replace a stale row', () => {
    const stale = chatReducer(reduceAll([opened]), delta(11, ' Let me read it.', 26, 42));
    const { stale: _stale, ...base } = stale.threads[THREAD].messages[0];
    const whole: ChatMessage = { ...base, parts: [{ type: 'text', text: 'Found the job. Let me read it.' }], version: 11 };
    expect(mergeThreadSnapshot(stale, thread(), [whole]).threads[THREAD].messages[0]).toBe(whole);
  });

  it('keeps a newer row whatever its position in the snapshot', () => {
    // reduce hands its callback an index as the third argument; a version
    // gate with a `force` third parameter took that index as true for every
    // row after the first (caught by tsc, 2026-09-30).
    const first: MessageUpsertFrame = { ...opened, seq: 1, message_id: 'm0', status: 'complete' };
    const live = reduceAll([first, opened, delta(11, ' Let me read it.', 14, 30)]);
    const row = live.threads[THREAD].messages[1];
    const older: ChatMessage = { ...row, parts: [{ type: 'text', text: 'Found the job.' }], version: 10 };
    const olderFirst: ChatMessage = { ...live.threads[THREAD].messages[0] };
    const merged = mergeThreadSnapshot(live, thread(), [olderFirst, older]);
    expect(merged.threads[THREAD].messages[1]).toBe(row);
  });

  it('keeps a row newer than the snapshot, and the same object for an equal one', () => {
    const live = reduceAll([opened, delta(11, ' Let me read it.', 14, 30)]);
    const row = live.threads[THREAD].messages[0];
    const older: ChatMessage = { ...row, parts: [{ type: 'text', text: 'Found the job.' }], version: 10 };
    expect(mergeThreadSnapshot(live, thread(), [older]).threads[THREAD].messages[0]).toBe(row);
    expect(mergeThreadSnapshot(live, thread(), [{ ...row }]).threads[THREAD].messages[0]).toBe(row);
  });
});

// --- a row the server withdrew ----------------------------------------------
// The gateway re-streamed a reply the thread already held (run aa2597a8,
// 2026-10-01, "messages are double sending"); hub-api takes the duplicate back
// with a `message.delete` rather than leaving two copies standing.
describe('message.delete', () => {
  const row = (id: string, seq: number, text: string): MessageUpsertFrame => ({
    type: 'message.upsert', seq, thread_id: THREAD, message_id: id, role: 'assistant', author_type: 'agent',
    status: 'complete', run_id: 'run1', parts: [{ type: 'text', text }],
  });
  const del = (id: string, seq: number): ChatFrame => ({ type: 'message.delete', seq, thread_id: THREAD, message_id: id, version: seq });

  it('removes the withdrawn row and keeps the one it duplicated', () => {
    const state = reduceAll([row('m1', 1, 'Fixed.'), row('m2', 2, 'Fixed.'), del('m2', 3)]);
    expect(state.threads[THREAD].messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('is the same state, by reference, for a row the client never held', () => {
    const before = reduceAll([row('m1', 1, 'Fixed.')]);
    expect(chatReducer(before, del('never-seen', 2))).toBe(before);
  });

  it('keeps a client-local row: the server has never seen one, so it cannot withdraw it', () => {
    const local = applyLocalMessage(initialChatState, THREAD, {
      id: 'local-1', thread_id: THREAD, seq: 0, version: 0, role: 'user', author_type: 'human', run_id: null,
      status: 'sending', client_msg_id: 'c1', cron_run_id: null, created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z', parts: [{ type: 'text', text: 'hello' }],
    } as ChatMessage);
    const after = chatReducer(local, del('m2', 5));
    expect(after.threads[THREAD].messages.map((m) => m.id)).toEqual(['local-1']);
  });
});

// --- an iMessage draft approval -------------------------------------------------
// A draft rides the SAME approval pipeline (chat/drafts.ts) under its own
// attention kind; answering it from the card must resolve BOTH the attention
// row and the linked tool_call, exactly as a generic approval does — otherwise
// the card and the inbox could not both clear on one tap.
describe('an iMessage draft approval', () => {
  const attentionFrame: AttentionUpsertFrame = {
    type: 'attention.upsert',
    seq: 1,
    thread_id: THREAD,
    attention_id: 'att_d1',
    kind: 'imessage_draft',
    request_id: 'req_d1',
    run_id: 'run_d1',
    summary: 'to Mom: running late',
    message_id: 'm_d1',
    expires_at_derived: null,
  };
  const messageFrame: MessageUpsertFrame = {
    type: 'message.upsert',
    seq: 2,
    thread_id: THREAD,
    message_id: 'm_d1',
    role: 'assistant',
    author_type: 'agent',
    status: 'complete',
    run_id: 'run_d1',
    parts: [
      {
        type: 'tool_call',
        tool_name: 'draft_imessage',
        state: 'approval_requested',
        choices: ['once', 'deny'],
        args: { to: 'Mom', text: 'running late' },
      },
    ],
  };
  const answeredFrame: ApprovalAnsweredFrame = {
    type: 'approval.answered',
    thread_id: THREAD,
    run_id: 'run_d1',
    request_id: 'req_d1',
    choice: 'once',
  };

  it('resolves the draft attention row and its tool_call once answered', () => {
    const state = reduceAll([attentionFrame, messageFrame, answeredFrame]);
    expect(state.threads[THREAD].attention[0].state).toBe('answered');
    const part = state.threads[THREAD].messages[0].parts[0] as ToolCallPart;
    expect(part.state).toBe('answered');
    expect(part.resolved_choice).toBe('once');
  });
});
