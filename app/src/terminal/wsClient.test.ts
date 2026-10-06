import {
  BACKOFF_S,
  POLICY_CLOSE_CODE,
  SESSION_EXPIRED,
  TerminalSocket,
  type AppStateSource,
  type TtydSocket,
} from './wsClient';
import { FLOW_HIGH, FLOW_LIMIT, FLOW_LOW, encodeHandshake } from './ttydProtocol';
import { HUB_ORIGIN } from '../lib/api';

const ORIGIN = 'https://hub.test';

class FakeSocket implements TtydSocket {
  static made: FakeSocket[] = [];
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array | string }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly protocols: string[],
    readonly options?: { headers: Record<string, string> },
  ) {
    FakeSocket.made.push(this);
  }

  send(data: Uint8Array | ArrayBuffer | string) {
    this.sent.push(data as Uint8Array);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // --- drive the socket from the server side -------------------------------
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(data: ArrayBuffer | Uint8Array | string) {
    this.onmessage?.({ data });
  }

  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  fail() {
    this.onerror?.();
  }

  /** Everything the client sent after the handshake frame. */
  get frames(): number[][] {
    return this.sent.slice(1).map((f) => Array.from(f));
  }
}

interface Harness {
  client: TerminalSocket;
  data: [number[], boolean][];
  statuses: [string, string | undefined][];
  locks: string[];
  titles: string[];
  appState: (state: string) => void;
}

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function harness(opts: { token?: string; authHeaders?: () => Record<string, string> } = {}): Harness {
  const data: [number[], boolean][] = [];
  const statuses: [string, string | undefined][] = [];
  const locks: string[] = [];
  const titles: string[] = [];
  let appListener: (s: string) => void = () => {};
  const appState: AppStateSource = {
    addEventListener: (_type, listener) => {
      appListener = listener;
      return { remove: () => { appListener = () => {}; } };
    },
  };
  const client = new TerminalSocket({
    origin: ORIGIN,
    onData: (bytes, needsAck) => data.push([Array.from(bytes), needsAck]),
    onStatus: (s, detail) => statuses.push([s, detail]),
    onLock: (detail) => locks.push(detail),
    onTitle: (t) => titles.push(t),
    socketFactory: (url, protocols, options) => new FakeSocket(url, protocols, options),
    appState,
    authHeaders: opts.authHeaders,
  });
  (global.fetch as jest.Mock).mockResolvedValue(jsonRes({ token: opts.token ?? '' }));
  return { client, data, statuses, locks, titles, appState: (s) => appListener(s) };
}

/** Connect and bring the socket up; returns the live fake. */
async function connected(h: Harness, cols = 80, rows = 24): Promise<FakeSocket> {
  await h.client.connect(cols, rows);
  const sock = FakeSocket.made[FakeSocket.made.length - 1];
  sock.open();
  return sock;
}

beforeEach(() => {
  FakeSocket.made = [];
  global.fetch = jest.fn();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.resetAllMocks();
});

describe('handshake', () => {
  it('probes /terminal/token with cookies, then upgrades wss with the tty subprotocol', async () => {
    const h = harness();
    const sock = await connected(h);

    expect(global.fetch).toHaveBeenCalledWith(`${ORIGIN}/terminal/token`, {
      credentials: 'include',
    });
    expect(sock.url).toBe('wss://hub.test/terminal/ws');
    expect(sock.protocols).toEqual(['tty']);
    expect(sock.binaryType).toBe('arraybuffer');
    expect(h.statuses).toEqual([
      ['connecting', undefined],
      ['connected', undefined],
    ]);
  });

  it('sends the opcode-less auth JSON as the first frame, carrying the probed token', async () => {
    const h = harness({ token: 'abc123' });
    const sock = await connected(h, 100, 40);
    expect(Array.from(sock.sent[0])).toEqual(Array.from(encodeHandshake('abc123', 100, 40)));
  });

  it('derives wss:// and the token path from HUB_ORIGIN when no origin is injected', () => {
    const client = new TerminalSocket({ onData: () => {}, onStatus: () => {}, onLock: () => {} });
    expect(client.tokenUrl).toBe(`${HUB_ORIGIN}/terminal/token`);
    expect(client.wsUrl).toBe(`${HUB_ORIGIN.replace(/^http/, 'ws')}/terminal/ws`);
    expect(client.wsUrl.startsWith('wss://')).toBe(true);
  });

  it('treats a token-probe network failure as non-fatal and connects with an empty token', async () => {
    const h = harness();
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    const sock = await connected(h);
    expect(Array.from(sock.sent[0])).toEqual(Array.from(encodeHandshake('', 80, 24)));
    expect(h.locks).toEqual([]);
  });

  it('tolerates a token payload with no token field', async () => {
    const h = harness();
    (global.fetch as jest.Mock).mockResolvedValue(jsonRes({}));
    const sock = await connected(h);
    expect(Array.from(sock.sent[0])).toEqual(Array.from(encodeHandshake('', 80, 24)));
  });
});

describe('re-lock triggers', () => {
  it('a 401 from /terminal/token locks without opening a socket or scheduling a retry', async () => {
    const h = harness();
    (global.fetch as jest.Mock).mockResolvedValue(jsonRes({ detail: 'terminal locked' }, 401));

    await h.client.connect(80, 24);

    expect(FakeSocket.made).toHaveLength(0);
    expect(h.statuses).toEqual([
      ['connecting', undefined],
      ['error', SESSION_EXPIRED],
    ]);
    expect(h.locks).toEqual([SESSION_EXPIRED]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('close code 1008 locks and does not reconnect', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.serverClose(POLICY_CLOSE_CODE);

    expect(h.statuses.at(-1)).toEqual(['closed', SESSION_EXPIRED]);
    expect(h.locks).toEqual([SESSION_EXPIRED]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('the lock detail is the exact string the UI branches on', () => {
    expect(SESSION_EXPIRED).toBe('session expired');
  });

  it('a 401 arriving mid-session (reconnect probe) locks the second time too', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.serverClose(1006);
    (global.fetch as jest.Mock).mockResolvedValue(jsonRes({}, 401));

    await jest.advanceTimersByTimeAsync(BACKOFF_S[0] * 1000);

    expect(FakeSocket.made).toHaveLength(1);
    expect(h.locks).toEqual([SESSION_EXPIRED]);
  });

  it('a 1008 close after a pending backoff timer cancels that timer', async () => {
    const h = harness();
    const first = await connected(h);
    first.fail(); // schedules a 1s retry
    first.serverClose(POLICY_CLOSE_CODE);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
    expect(h.locks).toEqual([SESSION_EXPIRED]);
  });

  it('any other close code reconnects instead of locking', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.serverClose(1006);
    expect(h.locks).toEqual([]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.made).toHaveLength(2);
  });
});

describe('reconnect ladder', () => {
  it('walks [1,2,4,8,15]s across successive failures and holds at the tail', async () => {
    const h = harness();
    let sock = await connected(h);

    // Each rung's socket is never opened, so the ladder keeps climbing.
    const rungs = [...BACKOFF_S, 15, 15];
    for (const [i, seconds] of rungs.entries()) {
      sock.serverClose(1006);
      await jest.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(FakeSocket.made).toHaveLength(i + 1); // one tick short: nothing yet
      await jest.advanceTimersByTimeAsync(1);
      expect(FakeSocket.made).toHaveLength(i + 2);
      sock = FakeSocket.made[i + 1];
    }
    expect(BACKOFF_S).toEqual([1, 2, 4, 8, 15]);
  });

  it('resets the ladder after a successful connect', async () => {
    const h = harness();
    let sock = await connected(h);
    sock.serverClose(1006);
    await jest.advanceTimersByTimeAsync(BACKOFF_S[0] * 1000);
    sock = FakeSocket.made[1];
    sock.open(); // attempt → 0
    sock.serverClose(1006);

    await jest.advanceTimersByTimeAsync(BACKOFF_S[0] * 1000 - 1);
    expect(FakeSocket.made).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(FakeSocket.made).toHaveLength(3);
  });

  it('retryNow() skips the ladder and cancels the pending timer', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.serverClose(1006);
    h.client.retryNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('retryNow() is a no-op while connected', async () => {
    const h = harness();
    await connected(h);
    h.client.retryNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('a direct connect() disarms the ladder instead of racing it', async () => {
    // Task 23 calls connect() once the WebView reports its grid; if a backoff
    // is already armed, the timer would fire a second connection behind it.
    const h = harness();
    const sock = await connected(h);
    sock.serverClose(1006);
    await h.client.connect(100, 40);
    expect(FakeSocket.made).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('close() cancels a pending reconnect', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.serverClose(1006);
    h.client.close();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });
});

describe('AppState foreground reconnect', () => {
  it("reconnects immediately on 'active' and drops the queued backoff", async () => {
    const h = harness();
    const detach = h.client.attachAppState();
    const sock = await connected(h);
    sock.serverClose(1006);

    h.appState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(2);
    detach();
  });

  it("ignores 'active' while the socket is up, and every non-active state", async () => {
    const h = harness();
    h.client.attachAppState();
    await connected(h);
    h.appState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(1);

    FakeSocket.made[0].serverClose(1006);
    h.appState('background');
    h.appState('inactive');
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('close() does NOT detach — the caller must hold the detach fn', async () => {
    const h = harness();
    h.client.attachAppState();
    const sock = await connected(h);
    sock.serverClose(1006);
    h.client.close();

    h.appState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(2); // still listening after close()
  });

  it('the returned detach stops further foreground reconnects', async () => {
    const h = harness();
    const detach = h.client.attachAppState();
    const sock = await connected(h);
    sock.serverClose(1006);
    h.client.close();
    detach();
    h.appState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(1);
  });
});

describe('input path', () => {
  it("write() emits '0' + UTF-8 and resize() emits '1' + JSON", async () => {
    const h = harness();
    const sock = await connected(h);
    h.client.write('ls\r');
    h.client.resize(120, 51);
    expect(sock.frames).toEqual([
      [48, 108, 115, 13],
      [
        49, 123, 34, 99, 111, 108, 117, 109, 110, 115, 34, 58, 49, 50, 48, 44, 34, 114, 111, 119,
        115, 34, 58, 53, 49, 125,
      ],
    ]);
  });

  it('drops writes while disconnected rather than throwing', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.serverClose(1006);
    expect(() => {
      h.client.write('ls\r');
      h.client.resize(10, 10);
      h.client.ack();
    }).not.toThrow();
    expect(sock.frames).toEqual([]);
  });

  it('drops writes issued after the socket exists but before it opens', async () => {
    const h = harness();
    await h.client.connect(80, 24);
    const sock = FakeSocket.made[0];
    expect(sock.readyState).toBe(0);
    h.client.write('ls\r');
    h.client.resize(10, 10);
    expect(sock.sent).toEqual([]);
    sock.open();
    expect(sock.sent).toHaveLength(1); // the handshake, and nothing replayed
  });

  it('a resize while down still seeds the next handshake', async () => {
    const h = harness();
    const first = await connected(h);
    first.serverClose(1006);
    h.client.resize(133, 44);
    await jest.advanceTimersByTimeAsync(BACKOFF_S[0] * 1000);
    const second = FakeSocket.made[1];
    second.open();
    expect(Array.from(second.sent[0])).toEqual(Array.from(encodeHandshake('', 133, 44)));
  });
});

describe('output path', () => {
  it('hands raw output bytes to the renderer and decodes titles', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.deliver(new Uint8Array([48, 104, 105]));
    sock.deliver(new Uint8Array([49, 88, 97, 118, 105, 101, 114]));
    expect(h.data).toEqual([[[104, 105], false]]);
    expect(h.titles).toEqual(['Xavier']);
  });

  it('ignores preference frames and empty frames', async () => {
    const h = harness();
    const sock = await connected(h);
    sock.deliver(new Uint8Array([50, 123, 125]));
    sock.deliver(new Uint8Array([]));
    expect(h.data).toEqual([]);
  });

  it('ignores a late onopen from a superseded CONNECTING socket', async () => {
    // RN can still deliver onopen on a socket the client has already replaced.
    // Without the guard this handshakes on a dead socket, reports 'connected'
    // and resets the backoff ladder.
    const h = harness();
    await h.client.connect(80, 24);
    const stale = FakeSocket.made[0];
    expect(stale.readyState).toBe(0); // never opened
    h.client.retryNow();
    await jest.advanceTimersByTimeAsync(0);
    const live = FakeSocket.made[1];

    const before = h.statuses.length;
    stale.open();

    expect(stale.sent).toEqual([]); // no handshake on the dead socket
    expect(h.statuses).toHaveLength(before); // no 'connected'
    expect(h.client.connected).toBe(false); // still the unopened live socket
    live.open();
    expect(h.statuses.at(-1)).toEqual(['connected', undefined]);
  });

  it('ignores a late onerror from a socket the client has already replaced', async () => {
    const h = harness();
    const stale = await connected(h);
    stale.serverClose(1006);
    await jest.advanceTimersByTimeAsync(BACKOFF_S[0] * 1000);
    FakeSocket.made[1].open();

    const before = h.statuses.length;
    stale.fail();

    expect(h.statuses).toHaveLength(before);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(2); // no ghost reconnect scheduled
  });

  it('ignores frames from a socket the client has already replaced', async () => {
    const h = harness();
    const stale = await connected(h);
    stale.serverClose(1006);
    await jest.advanceTimersByTimeAsync(BACKOFF_S[0] * 1000);
    FakeSocket.made[1].open();

    stale.deliver(new Uint8Array([48, 104, 105]));
    stale.serverClose(POLICY_CLOSE_CODE);
    expect(h.data).toEqual([]);
    expect(h.locks).toEqual([]);
  });
});

describe('flow control, driven through the live client', () => {
  const bigFrame = (() => {
    const f = new Uint8Array(FLOW_LIMIT + 2);
    f[0] = 48; // opcode '0'
    return f;
  })();

  it('pauses ttyd once unacked chunks exceed FLOW_HIGH, resumes below FLOW_LOW', async () => {
    const h = harness();
    const sock = await connected(h);

    for (let i = 0; i < FLOW_HIGH; i += 1) sock.deliver(bigFrame);
    expect(sock.frames).toEqual([]); // nothing paused yet at exactly FLOW_HIGH
    expect(h.data.every(([, needsAck]) => needsAck)).toBe(true);

    sock.deliver(bigFrame); // pending → 11 > 10
    expect(sock.frames).toEqual([[50]]); // opcode '2' pause

    // 11 → 4 keeps it paused; the ack that lands on 3 resumes.
    for (let i = 0; i < FLOW_HIGH + 1 - FLOW_LOW; i += 1) h.client.ack();
    expect(sock.frames).toEqual([[50]]);
    h.client.ack();
    expect(sock.frames).toEqual([[50], [51]]); // opcode '3' resume
  });

  it('marks small chunks as needing no ack until the 100 KB window closes', async () => {
    const h = harness();
    const sock = await connected(h);
    const small = new Uint8Array([48, 120]);
    sock.deliver(small);
    expect(h.data).toEqual([[[120], false]]);
    sock.deliver(bigFrame);
    expect(h.data[1][1]).toBe(true);
  });

  it('starts a reconnected socket with a fresh flow window', async () => {
    const h = harness();
    const first = await connected(h);
    for (let i = 0; i < FLOW_HIGH + 1; i += 1) first.deliver(bigFrame);
    expect(first.frames).toEqual([[50]]);

    first.serverClose(1006);
    await jest.advanceTimersByTimeAsync(BACKOFF_S[0] * 1000);
    const second = FakeSocket.made[1];
    second.open();

    // Stale pending acks must not carry over: FLOW_HIGH chunks alone are not a pause.
    for (let i = 0; i < FLOW_HIGH; i += 1) second.deliver(bigFrame);
    expect(second.frames).toEqual([]);
    second.deliver(bigFrame);
    expect(second.frames).toEqual([[50]]);
  });
});

describe('cookie assumption and its fallback', () => {
  it('passes no options when authHeaders is unset — the cookie is expected to ride the upgrade', async () => {
    const h = harness();
    const sock = await connected(h);
    expect(sock.options).toBeUndefined();
  });

  it('passes an explicit header when the device test says the cookie did not ride', async () => {
    const h = harness({ authHeaders: () => ({ Cookie: 'hub_term_session=tok' }) });
    const sock = await connected(h);
    expect(sock.options).toEqual({ headers: { Cookie: 'hub_term_session=tok' } });
  });

  it('an empty header map is still no options', async () => {
    const h = harness({ authHeaders: () => ({}) });
    const sock = await connected(h);
    expect(sock.options).toBeUndefined();
  });
});

describe('teardown during an in-flight connect', () => {
  it('close() before the token probe resolves leaves no socket behind', async () => {
    const h = harness();
    let release: (r: Response) => void = () => {};
    (global.fetch as jest.Mock).mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const pending = h.client.connect(80, 24);
    h.client.close();
    release(jsonRes({ token: '' }));
    await pending;

    expect(FakeSocket.made).toHaveLength(0);
  });

  it('a second connect() supersedes the first rather than racing it', async () => {
    const h = harness();
    const releases: ((r: Response) => void)[] = [];
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise<Response>((resolve) => releases.push(resolve)),
    );

    const first = h.client.connect(80, 24);
    const second = h.client.connect(90, 30);
    releases[0](jsonRes({ token: '' }));
    releases[1](jsonRes({ token: '' }));
    await Promise.all([first, second]);

    expect(FakeSocket.made).toHaveLength(1);
    FakeSocket.made[0].open();
    expect(Array.from(FakeSocket.made[0].sent[0])).toEqual(Array.from(encodeHandshake('', 90, 30)));
  });

  it('does not re-close a socket that is already closing', async () => {
    // RN can move readyState to CLOSING/CLOSED before onclose lands, so the
    // client can still hold a reference to a socket that is already gone.
    const h = harness();
    const sock = await connected(h);
    sock.readyState = 3;
    h.client.close();
    expect(sock.closeCalls).toBe(0);
  });

  it('close() shuts the live socket exactly once', async () => {
    const h = harness();
    const sock = await connected(h);
    h.client.close();
    h.client.close();
    expect(sock.closeCalls).toBe(1);
    expect(h.client.connected).toBe(false);
  });
});
