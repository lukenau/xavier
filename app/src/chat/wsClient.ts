// Chat transport — ported from src/terminal/wsClient.ts's reconnect ladder,
// stripped of everything that was ttyd-specific (the pty byte framing,
// pause/resume flow control, the /terminal/token round trip) and given
// chat's own shape instead: one socket, N per-thread `subscribe` cursors, and
// plain JSON frames both ways (chat/ws.py).
//
// Same cookie story as the terminal: RN-iOS rewrites wss→https and attaches
// NSHTTPCookieStorage cookies to the upgrade, and RN `fetch` writes Set-Cookie
// into that same store, so the HttpOnly `hub_chat_session` cookie minted by
// POST /api/chat/session (chat/session.py) rides the handshake with no
// syncing and no JS access to it. Unlike the terminal there is no token step
// first — chat/ws.py accepts or 1008s purely on the cookie already in the
// upgrade request — so `connect()` here is synchronous where the terminal's
// is async.
import { AppState } from 'react-native';
import { HUB_ORIGIN } from '../lib/api';
import type { ChatFrame, SubscribeMessage } from './types';

export type ChatConnStatus = 'connecting' | 'connected' | 'closed' | 'error';

/** The re-lock keyword — mirrors terminal/wsClient.ts's SESSION_EXPIRED so
 * screens can share one `unlockErrorMessage`-shaped branch if they want to. */
export const SESSION_EXPIRED = 'session expired';

/** Seconds, same ladder and same tail-clamp as the terminal socket. */
export const BACKOFF_S = [1, 2, 4, 8, 15];

/** chat/ws.py closes 1008 (policy violation) with no cookie, a garbage
 * cookie, or a cookie revoked mid-connection — the exact code
 * test_chat_gate.py asserts on all three paths. */
export const POLICY_CLOSE_CODE = 1008;

/** A socket that reads OPEN but has carried nothing — not even a heartbeat,
 * which chat/ws.py sends every 15s when idle — for this long is dead. iOS
 * suspends a backgrounded socket without telling the app, and `readyState`
 * keeps saying OPEN until the OS gets round to closing it, which can take
 * minutes ("a reply disappears, then flashes back on reopen", 2026-09-28).
 *
 * 25s, not 45s: a reply that stopped partway sat there for up to 55s (45s of
 * silence plus a check every 10s) before the app reconnected and replayed the
 * rest — "renders parts of a message, pauses, then doesn't show the rest until
 * I close and reopen the chat" (the user, 2026-10-01). The event log for that
 * thread had every delta, in order, with no gaps, and the server logged 15
 * abnormal (1006) client disconnects in 3 hours, so the words were never lost;
 * the socket was. A live stream never goes quiet for longer than the 15s
 * heartbeat, so 25s is a missed beat plus margin, and a reconnect that was not
 * needed costs one cheap resubscribe from the cursor. */
export const STALL_MS = 25_000;
export const STALL_CHECK_MS = 5_000;
/** On foreground every subscription is re-sent as a probe; the server answers
 * each with `synced`. None within this long and the socket is dead. */
export const PROBE_MS = 10_000;

const OPEN = 1;

// Read the global lazily, inside the factory default: at module scope this
// throws on import in any runtime without it, same reasoning as the
// terminal's NativeWebSocketCtor.
type NativeWebSocketCtor = new (url: string) => ChatSocket;

export interface ChatSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface AppStateSource {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

export interface ChatSocketOptions {
  /** One parsed frame at a time, in the order the socket delivered them. */
  onFrame: (frame: ChatFrame) => void;
  onStatus: (status: ChatConnStatus, detail?: string) => void;
  /** Fired instead of a reconnect when the cookie is gone (1008). */
  onLock: (detail: string) => void;
  origin?: string;
  socketFactory?: (url: string) => ChatSocket;
  appState?: AppStateSource;
}

function isChatFrame(value: unknown): value is ChatFrame {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function hasSeq(frame: ChatFrame): frame is ChatFrame & { seq: number; thread_id: string } {
  return 'seq' in frame && 'thread_id' in frame;
}

export class ChatSocketClient {
  private ws: ChatSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Bumped by close()/connect(); a socket whose events resolve after a newer
   * one started (or after teardown) is dropped instead of leaking. */
  private generation = 0;
  private readonly opts: ChatSocketOptions;
  private readonly origin: string;
  private readonly makeSocket: NonNullable<ChatSocketOptions['socketFactory']>;
  /** thread_id -> last seq this client has seen (or been asked to resume
   * from). Reconnecting resubscribes every entry here from its own cursor —
   * `handle_subscribe` on the server replays exactly the events after it. */
  private readonly cursors = new Map<string, number>();
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;

  constructor(opts: ChatSocketOptions) {
    this.opts = opts;
    this.origin = opts.origin ?? HUB_ORIGIN;
    this.makeSocket =
      opts.socketFactory ?? ((url) => new (WebSocket as unknown as NativeWebSocketCtor)(url));
  }

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  get wsUrl(): string {
    return `${this.origin.replace(/^http/, 'ws')}/api/chat/ws`;
  }

  /** No-op while a socket is open or dialling. Screens call this from effects
   * that re-run on every refetch (window focus, pull-to-refresh, unlock), and
   * when it tore down and re-dialled unconditionally each of those cut the
   * live socket mid-stream (2026-09-22). */
  connect(): void {
    if (this.ws && this.ws.readyState <= OPEN) return;
    this.reconnect();
  }

  /** Always drops any existing socket and dials fresh — the backoff ladder,
   * operator retry and foreground resume, where the old socket is suspect. */
  reconnect(): void {
    // Every entry point cancels the armed backoff first, so a direct
    // connect() from a screen cannot race the ladder into a double connection.
    this.clearTimer();
    this.closeSocket();
    const generation = this.generation;
    this.setStatus('connecting');

    const ws = this.makeSocket(this.wsUrl);
    this.ws = ws;
    this.lastFrameAt = Date.now();
    this.armStallCheck();

    ws.onopen = () => {
      if (this.ws !== ws || generation !== this.generation) return;
      this.lastFrameAt = Date.now();
      this.setStatus('connected');
      // Resume every thread this client cares about from where it left off.
      for (const [threadId, seq] of this.cursors) this.sendSubscribe(threadId, seq);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('closed', ev.code === POLICY_CLOSE_CODE ? SESSION_EXPIRED : undefined);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setStatus('error');
    };
  }

  /** Subscribe (or resume) one thread from `afterSeq`. Safe to call before the
   * socket is open — the cursor is recorded immediately and sent once
   * `onopen` fires, and again on every future reconnect.
   *
   * ALWAYS takes the caller's own `afterSeq`, even when it is LOWER than the
   * cursor on file: a thread screen that has just applied a snapshot asks
   * from that snapshot's version on purpose, so the server replays what
   * landed after it — including anything this socket sent while a row was
   * stale. Every replayed frame is gated by version in the reducer, so
   * asking again is never a duplicate. `handleMessage` still advances the
   * cursor as frames arrive, so a later reconnect resumes from the highest
   * point actually reached. */
  subscribe(threadId: string, afterSeq = 0): void {
    this.cursors.set(threadId, afterSeq);
    if (this.connected) this.sendSubscribe(threadId, afterSeq);
  }

  /** Subscribe only a thread this client has no cursor for. The thread list
   * calls this on every poll; before it, each poll re-subscribed every thread
   * from the list's own `last_seq` and had the server replay, again, what an
   * open thread screen had already been sent. */
  subscribeIfNew(threadId: string, afterSeq = 0): void {
    if (this.cursors.has(threadId)) return;
    this.subscribe(threadId, afterSeq);
  }

  cursor(threadId: string): number | undefined {
    return this.cursors.get(threadId);
  }

  /** Drops a thread from the resume set — a screen navigating away from a
   * thread it no longer needs live updates for. Does not touch the socket
   * itself: chat/ws.py has no `unsubscribe` message, so this is purely local
   * bookkeeping that stops a future reconnect from re-subscribing it. */
  unsubscribe(threadId: string): void {
    this.cursors.delete(threadId);
  }

  /** Deliberate teardown, not a drop — cancels any pending reconnect. */
  close(): void {
    this.clearTimer();
    this.closeSocket();
  }

  /** Foreground reconnect, same as the terminal socket: a backgrounded app's
   * socket dies silently, and waiting out a 15s backoff tail after reopening
   * reads as broken. Returns the detach function. */
  attachAppState(): () => void {
    const source: AppStateSource = this.opts.appState ?? AppState;
    const sub = source.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (!this.connected) {
        this.reconnect();
        return;
      }
      // A socket that still reads OPEN after a stint in the background may be
      // dead. Every subscription is re-sent — a caught-up thread costs the
      // server one empty scan — and the `synced` answers are the proof of
      // life; none in time and the socket is re-dialled.
      for (const [threadId, seq] of this.cursors) this.sendSubscribe(threadId, seq);
      this.armProbe();
    });
    return () => sub.remove();
  }

  /** Operator-driven retry — skips the ladder. */
  retryNow(): void {
    if (this.connected) return;
    this.reconnect();
  }

  private sendSubscribe(threadId: string, afterSeq: number): void {
    const msg: SubscribeMessage = { type: 'subscribe', thread_id: threadId, after_seq: afterSeq };
    this.send(msg);
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // malformed frame: ignore, never crash
    }
    if (!isChatFrame(parsed)) return;
    this.lastFrameAt = Date.now();
    if (parsed.type === 'synced') this.clearProbe();
    if (hasSeq(parsed)) {
      const current = this.cursors.get(parsed.thread_id) ?? -1;
      if (parsed.seq > current) this.cursors.set(parsed.thread_id, parsed.seq);
    }
    this.opts.onFrame(parsed);
  }

  private send(payload: SubscribeMessage): void {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify(payload));
  }

  private setStatus(status: ChatConnStatus, detail?: string): void {
    this.opts.onStatus(status, detail);
    if (status === 'connected') this.attempt = 0;
    if (status !== 'closed' && status !== 'error') return;
    if (detail === SESSION_EXPIRED) {
      // No reconnect: the cookie is gone, every retry would 1008 in a loop.
      this.clearTimer();
      this.opts.onLock(detail);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_S[Math.min(this.attempt, BACKOFF_S.length - 1)] * 1000;
    this.attempt += 1;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      // Forced: after an 'error' the socket can still read CONNECTING, and a
      // guarded connect() would stall the ladder on it.
      this.reconnect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private closeSocket(): void {
    this.generation += 1;
    this.clearStallCheck();
    this.clearProbe();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= OPEN) ws.close();
  }

  private armStallCheck(): void {
    this.clearStallCheck();
    this.stallTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastFrameAt > STALL_MS) this.reconnect();
    }, STALL_CHECK_MS);
  }

  private clearStallCheck(): void {
    if (this.stallTimer === null) return;
    clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  private armProbe(): void {
    this.clearProbe();
    if (this.cursors.size === 0) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      this.reconnect();
    }, PROBE_MS);
  }

  private clearProbe(): void {
    if (this.probeTimer === null) return;
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }
}
