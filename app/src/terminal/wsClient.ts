// Terminal transport. React Native owns this socket, not the WebView: RN-iOS
// rewrites wss→https and attaches NSHTTPCookieStorage cookies to the upgrade,
// and RN `fetch` writes Set-Cookie into that same store — so the HttpOnly
// `hub_term_session` cookie minted by POST /api/terminal/session rides the
// handshake with no cookie syncing and no JS access to it. The renderer (Task
// 23) only draws bytes and acks writes.
//
// Everything here is injectable (socket factory, fetch, AppState, timers) so
// the whole reconnect / re-lock ladder is exercised against a fake socket.
import { AppState } from 'react-native';
import { HUB_ORIGIN } from '../lib/api';
import {
  FlowController,
  TTYD_SUBPROTOCOL,
  decodeServerFrame,
  encodeHandshake,
  encodeInput,
  encodePause,
  encodeResize,
  encodeResume,
} from './ttydProtocol';

export type TtydStatus = 'connecting' | 'connected' | 'closed' | 'error';

/** The re-lock keyword. XtermView keys its lock branch on this exact string and
 * so does `TerminalSocket`; changing it silently disables every re-lock path. */
export const SESSION_EXPIRED = 'session expired';

/** Seconds, indexed by attempt and clamped at the tail (XtermView.tsx:18). */
export const BACKOFF_S = [1, 2, 4, 8, 15];

/** ttyd closes 1008 when hub-api rejects the cookie (app.py terminal_ws). */
export const POLICY_CLOSE_CODE = 1008;

const OPEN = 1;

// RN's WebSocket takes a third `options` argument ({headers, ...}) that the DOM
// lib's constructor signature does not know about. Read LAZILY, inside the
// factory: at module scope this throws on import in any runtime without the
// global, and Task 23 imports this module.
type NativeWebSocketCtor = new (
  url: string,
  protocols?: string[],
  options?: { headers: Record<string, string> },
) => TtydSocket;

export interface TtydSocket {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array | string }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  send(data: Uint8Array | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
}

export interface AppStateSource {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

export interface TerminalSocketOptions {
  /** Raw output bytes. `needsAck` means the renderer must call `ack()` once the
   * chunk is on screen — that is what drives ttyd's pause/resume window. */
  onData: (bytes: Uint8Array, needsAck: boolean) => void;
  onStatus: (status: TtydStatus, detail?: string) => void;
  /** Fired instead of a reconnect when the session is gone (see §re-lock). */
  onLock: (detail: string) => void;
  onTitle?: (title: string) => void;
  origin?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (
    url: string,
    protocols: string[],
    options?: { headers: Record<string, string> },
  ) => TtydSocket;
  appState?: AppStateSource;
  /** DEVICE-TEST GATE. Expected to stay unset: the cookie is supposed to ride
   * the upgrade from NSHTTPCookieStorage. Delete this hook and its wiring once
   * one device run shows the POSITIVE signal — the upgrade accepted and the pty
   * streaming with this unset. (Do not gate on "no 1008": uvicorn turns the
   * bridge's pre-accept close into a 403 handshake rejection, which clients see
   * as 1006, so a failure looks the same as a network drop.) Until then it is
   * the cheap escape: return `{ Cookie: 'hub_term_session=…' }` or an
   * `Authorization` header and RN adds it to the handshake request. */
  authHeaders?: () => Record<string, string> | undefined;
}

export class TerminalSocket {
  private ws: TtydSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private cols = 80;
  private rows = 24;
  /** Bumped by close()/connect(); a connect whose token fetch resolves after a
   * newer one started (or after teardown) drops its socket instead of leaking. */
  private generation = 0;
  private readonly flow = new FlowController();
  private readonly opts: TerminalSocketOptions;
  private readonly origin: string;
  private readonly doFetch: typeof fetch;
  private readonly makeSocket: NonNullable<TerminalSocketOptions['socketFactory']>;

  constructor(opts: TerminalSocketOptions) {
    this.opts = opts;
    this.origin = opts.origin ?? HUB_ORIGIN;
    this.doFetch = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.makeSocket =
      opts.socketFactory ??
      ((url, protocols, options) =>
        new (WebSocket as unknown as NativeWebSocketCtor)(url, protocols, options));
  }

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  get tokenUrl(): string {
    return `${this.origin}/terminal/token`;
  }

  get wsUrl(): string {
    return `${this.origin.replace(/^http/, 'ws')}/terminal/ws`;
  }

  async connect(columns = this.cols, rows = this.rows): Promise<void> {
    this.cols = columns;
    this.rows = rows;
    // Every entry point cancels the armed backoff first, so a direct connect()
    // from the screen cannot race the ladder into a double connection.
    this.clearTimer();
    this.closeSocket();
    const generation = this.generation;
    this.setStatus('connecting');

    // ttyd serves its auth token at <base>/token; with no --credential (this
    // host) the value is empty and the handshake works either way. The 401 is
    // the load-bearing part: it is hub-api's proxy saying the cookie is gone,
    // and the only expiry signal that survives the bridge (Starlette's
    // pre-accept close(1008) reaches clients as an abnormal 1006).
    let token = '';
    try {
      const res = await this.doFetch(this.tokenUrl, { credentials: 'include' });
      if (res.ok) token = ((await res.json()) as { token?: string })?.token ?? '';
      else if (res.status === 401) {
        this.setStatus('error', SESSION_EXPIRED);
        return;
      }
    } catch {
      // Non-fatal: an offline probe must not mask the socket's own failure.
    }
    if (generation !== this.generation) return;

    const headers = this.opts.authHeaders?.();
    const ws = this.makeSocket(
      this.wsUrl,
      [TTYD_SUBPROTOCOL],
      headers && Object.keys(headers).length > 0 ? { headers } : undefined,
    );
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.flow.reset();

    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(encodeHandshake(token, this.cols, this.rows));
      this.setStatus('connected');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleFrame(ev.data);
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

  /** Composer / key-bar / hardware keystrokes → pty. */
  write(text: string): void {
    this.send(encodeInput(text));
  }

  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rows = rows;
    this.send(encodeResize(columns, rows));
  }

  /** Renderer acknowledging a chunk that was flagged `needsAck`. */
  ack(): void {
    if (this.flow.onAck().resume) this.send(encodeResume());
  }

  /** Cancels any pending reconnect: a deliberate teardown, not a drop. */
  close(): void {
    this.clearTimer();
    this.closeSocket();
  }

  /** Foreground reconnect. RN's AppState 'active' replaces the PWA's
   * `visibilitychange`: a backgrounded app's socket dies silently, and waiting
   * out a 15 s backoff tail after the user reopens the tab reads as broken.
   * Returns the detach function — `close()` deliberately does NOT detach, so a
   * screen that unmounts must call both. */
  attachAppState(): () => void {
    const source: AppStateSource = this.opts.appState ?? AppState;
    const sub = source.addEventListener('change', (state) => {
      if (state !== 'active' || this.connected) return;
      void this.connect();
    });
    return () => sub.remove();
  }

  /** Operator-driven retry from the status pill — skips the ladder. */
  retryNow(): void {
    if (this.connected) return;
    void this.connect();
  }

  private handleFrame(data: ArrayBuffer | Uint8Array | string): void {
    const frame = decodeServerFrame(data);
    if (!frame) return;
    if (frame.kind === 'output') {
      const { needsAck, pause } = this.flow.onOutput(frame.data.length);
      this.opts.onData(frame.data, needsAck);
      if (pause) this.send(encodePause());
      return;
    }
    if (frame.kind === 'title') this.opts.onTitle?.(frame.title);
    // 'prefs' (ttyd --client-option) and anything unknown: the app owns its theme.
  }

  private send(payload: Uint8Array): void {
    if (!this.connected || !this.ws) return;
    this.ws.send(payload);
  }

  private setStatus(status: TtydStatus, detail?: string): void {
    this.opts.onStatus(status, detail);
    if (status === 'connected') this.attempt = 0;
    if (status !== 'closed' && status !== 'error') return;
    if (detail === SESSION_EXPIRED) {
      // No reconnect: the cookie is gone, every retry would 401/1008 in a loop.
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
      void this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private closeSocket(): void {
    this.generation += 1;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= OPEN) ws.close();
  }
}
