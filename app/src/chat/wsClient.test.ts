import {
  BACKOFF_S,
  ChatSocketClient,
  POLICY_CLOSE_CODE,
  PROBE_MS,
  SESSION_EXPIRED,
  STALL_CHECK_MS,
  STALL_MS,
  type AppStateSource,
  type ChatSocket,
} from './wsClient';

class FakeChatSocket implements ChatSocket {
  static made: FakeChatSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeChatSocket.made.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

// Every client a test makes is closed after it: connect() arms a real stall
// interval that only close() clears, and a suite that leaves one running
// cannot exit on its own.
const clients: ChatSocketClient[] = [];
afterEach(() => {
  for (const c of clients) c.close();
  clients.length = 0;
});

function makeClient(overrides: Partial<ConstructorParameters<typeof ChatSocketClient>[0]> = {}) {
  FakeChatSocket.made = [];
  const onFrame = jest.fn();
  const onStatus = jest.fn();
  const onLock = jest.fn();
  const client = new ChatSocketClient({
    onFrame,
    onStatus,
    onLock,
    origin: 'https://hub.test',
    socketFactory: (url) => new FakeChatSocket(url),
    ...overrides,
  });
  clients.push(client);
  return { client, onFrame, onStatus, onLock };
}

describe('subscribe cursor semantics', () => {
  it('honours a later, LOWER afterSeq instead of clamping to a previously requested higher one', () => {
    // Reproduces the bug: useChatBootstrap subscribes every thread from its
    // already-caught-up last_seq (nothing to catch up on), then
    // useThreadDetail asks for a genuine full replay from 0 to recover any
    // attention.upsert (e.g. a pending approval) older than that snapshot.
    // A cursor that clamps upward silently turns the second ask into a
    // no-op resend of the first.
    const { client } = makeClient();
    client.connect();
    const ws = FakeChatSocket.made[0];
    ws.open();

    client.subscribe('t1', 5); // bootstrap: resume from last_seq
    client.subscribe('t1', 0); // ThreadScreen: full replay

    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'subscribe', thread_id: 't1', after_seq: 5 },
      { type: 'subscribe', thread_id: 't1', after_seq: 0 },
    ]);
  });

  it('honours the lower ask even when the socket is not open yet (sent via the onopen resume loop)', () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeChatSocket.made[0];
    // Not open yet — subscribe() only records the cursor.

    client.subscribe('t1', 5);
    client.subscribe('t1', 0);
    ws.open(); // flushes the resume loop from `cursors`

    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'subscribe', thread_id: 't1', after_seq: 0 },
    ]);
  });

  it('still resumes from the highest seq actually observed after a reconnect', () => {
    const { client } = makeClient();
    client.connect();
    let ws = FakeChatSocket.made[0];
    ws.open();

    client.subscribe('t1', 0);
    ws.deliver({ type: 'message.upsert', seq: 7, thread_id: 't1', message_id: 'm1', role: 'user', author_type: 'human', status: 'complete', run_id: null, parts: [] });

    ws.serverClose(1006);
    client.connect(); // simulate the reconnect
    ws = FakeChatSocket.made[1];
    ws.open();

    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'subscribe', thread_id: 't1', after_seq: 7 });
  });
});

describe('connection lifecycle', () => {
  it('reconnects with the backoff ladder on an unexpected close', () => {
    jest.useFakeTimers();
    try {
      const { client, onStatus } = makeClient();
      client.connect();
      FakeChatSocket.made[0].serverClose(1006);
      expect(onStatus).toHaveBeenCalledWith('closed', undefined);

      jest.advanceTimersByTime(BACKOFF_S[0] * 1000);
      expect(FakeChatSocket.made).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('locks instead of reconnecting on a 1008 policy close', () => {
    jest.useFakeTimers();
    try {
      const { client, onStatus, onLock } = makeClient();
      client.connect();
      FakeChatSocket.made[0].serverClose(POLICY_CLOSE_CODE);
      expect(onStatus).toHaveBeenCalledWith('closed', SESSION_EXPIRED);
      expect(onLock).toHaveBeenCalledWith(SESSION_EXPIRED);

      jest.advanceTimersByTime(60_000);
      expect(FakeChatSocket.made).toHaveLength(1); // no reconnect attempt
    } finally {
      jest.useRealTimers();
    }
  });

  it('connect() on a live socket is a no-op, not a teardown', () => {
    // useChatBootstrap and useThreadDetail both connect() from effects keyed on
    // query.data, refetchOnWindowFocus is on, and lock.unlock() invalidates
    // both queries — so foregrounding, pull-to-refresh, tapping New and
    // unlocking each re-entered connect() mid-stream.
    const { client } = makeClient();
    client.connect();
    const ws = FakeChatSocket.made[0];
    ws.open();
    client.subscribe('t1', 0);

    client.connect();
    client.connect();

    expect(FakeChatSocket.made).toHaveLength(1);
    expect(ws.closeCalls).toBe(0);
    expect(client.connected).toBe(true);
  });

  it('connect() while still dialling does not restart the dial', () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeChatSocket.made[0]; // readyState 0 — CONNECTING

    client.connect();

    expect(FakeChatSocket.made).toHaveLength(1);
    expect(ws.closeCalls).toBe(0);
  });

  it('connect() still dials once the socket is gone', () => {
    const { client } = makeClient();
    client.connect();
    FakeChatSocket.made[0].serverClose(1006);

    client.connect();

    expect(FakeChatSocket.made).toHaveLength(2);
  });

  it('reconnect() forces a fresh dial even over a live socket', () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeChatSocket.made[0];
    ws.open();

    client.reconnect();

    expect(FakeChatSocket.made).toHaveLength(2);
    expect(ws.closeCalls).toBe(1);
  });

  it('reconnects on AppState foreground when not already connected', () => {
    const listeners: Array<(state: string) => void> = [];
    const appState: AppStateSource = {
      addEventListener: (_type, cb) => {
        listeners.push(cb);
        return { remove: () => {} };
      },
    };
    const { client } = makeClient({ appState });
    client.connect();
    FakeChatSocket.made[0].serverClose(1006);
    const detach = client.attachAppState();
    for (const fn of listeners) fn('active');
    expect(FakeChatSocket.made.length).toBeGreaterThanOrEqual(2);
    detach();
  });
});

describe('liveness', () => {
  function appStateSource() {
    const listeners: Array<(state: string) => void> = [];
    const appState: AppStateSource = {
      addEventListener: (_type, cb) => {
        listeners.push(cb);
        return { remove: () => {} };
      },
    };
    return { appState, foreground: () => listeners.forEach((fn) => fn('active')) };
  }

  it('subscribeIfNew never lowers a cursor the client already has', () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeChatSocket.made[0];
    ws.open();

    client.subscribe('t1', 40);
    client.subscribeIfNew('t1', 5); // the thread list, polling
    client.subscribeIfNew('t2', 5);

    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'subscribe', thread_id: 't1', after_seq: 40 },
      { type: 'subscribe', thread_id: 't2', after_seq: 5 },
    ]);
    expect(client.cursor('t1')).toBe(40);
  });

  it('re-dials a socket that reads open but has carried nothing for too long', () => {
    jest.useFakeTimers();
    try {
      const { client } = makeClient();
      client.connect();
      const ws = FakeChatSocket.made[0];
      ws.open();

      jest.advanceTimersByTime(STALL_MS - STALL_CHECK_MS);
      ws.deliver({ type: 'heartbeat' }); // proof of life resets the clock
      jest.advanceTimersByTime(STALL_MS - 1000);
      expect(FakeChatSocket.made).toHaveLength(1);

      jest.advanceTimersByTime(STALL_CHECK_MS * 2);
      expect(FakeChatSocket.made).toHaveLength(2);
      expect(ws.closeCalls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('on foreground, probes an open socket and re-dials when nothing answers', () => {
    jest.useFakeTimers();
    try {
      const { appState, foreground } = appStateSource();
      const { client } = makeClient({ appState });
      client.connect();
      const ws = FakeChatSocket.made[0];
      ws.open();
      client.subscribe('t1', 3);
      const detach = client.attachAppState();

      foreground();
      expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
        { type: 'subscribe', thread_id: 't1', after_seq: 3 },
        { type: 'subscribe', thread_id: 't1', after_seq: 3 },
      ]);
      jest.advanceTimersByTime(PROBE_MS + 1);
      expect(FakeChatSocket.made).toHaveLength(2);
      detach();
    } finally {
      jest.useRealTimers();
    }
  });

  it('on foreground, a synced answer keeps the socket', () => {
    jest.useFakeTimers();
    try {
      const { appState, foreground } = appStateSource();
      const { client } = makeClient({ appState });
      client.connect();
      const ws = FakeChatSocket.made[0];
      ws.open();
      client.subscribe('t1', 3);
      const detach = client.attachAppState();

      foreground();
      ws.deliver({ type: 'synced', thread_id: 't1', seq: 3 });
      jest.advanceTimersByTime(PROBE_MS + 1);
      expect(FakeChatSocket.made).toHaveLength(1);
      detach();
    } finally {
      jest.useRealTimers();
    }
  });
});
