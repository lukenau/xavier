// The /api/live socket with a heartbeat and a reconnect ladder. Same cookie
// story as chat/wsClient.ts: RN-iOS attaches `hub_chat_session` to the wss
// upgrade. A drop mid-reply re-dials and asks the server to resume from the
// turn's cursor, so the reply is still spoken. Two closes end the client
// instead, because retrying cannot fix them: 1008, the chat session expired or
// was revoked ('locked'), and 4403, the server refused this Origin ('refused').
import { HUB_ORIGIN } from '../api';
import { helloFrame, parseLiveFrame, type LiveServerFrame, type LiveTts } from './protocol';

export interface LiveSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'locked' | 'refused';

export interface LiveClient {
  sendAudio(pcm: ArrayBuffer): void;
  playback(turnId: number, playedMs: number): void;
  drained(turnId: number): void;
  interrupt(): void;
  /** A call or Siri took the audio: stop speaking, keep Xavier's run. */
  hold(): void;
  /** A line for the server's Live log (mic errors, watchdog restarts). */
  diag(message: string): void;
  stop(): void;
}

const OPEN = 1;
/** chat/ws.py and live_session.py both close 1008 (policy violation) on a
 * session they will not accept. */
export const POLICY_CLOSE_CODE = 1008;
/** live_session.py's own code for an Origin it refuses (ORIGIN_REFUSED). */
export const ORIGIN_REFUSED_CODE = 4403;
const PING_MS = 10_000;
/** iOS can leave a socket half-open for minutes after a Wi-Fi/cellular
 * handoff with no close event; silence this long means it is dead. */
const DEAD_AFTER_MS = 25_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000];

export function connectLive(opts: {
  threadId: string;
  aec: boolean;
  /** Capture rate when it is not 16 kHz (the native engine sends 24 kHz). */
  micRate?: number;
  tts: LiveTts;
  onFrame(frame: LiveServerFrame): void;
  onStatus(status: LiveStatus): void;
  socketFactory?: (url: string) => LiveSocket;
}): LiveClient {
  const make = opts.socketFactory ?? ((u: string) => new (WebSocket as unknown as new (u: string) => LiveSocket)(u));
  let ws: LiveSocket;
  let stopped = false;
  let attempt = 0;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // The cursor of the turn whose reply is still owed (cleared once the
  // server is back to listening).
  let owedSeq: number | undefined;
  let lastRx = Date.now();

  const sendJson = (payload: Record<string, unknown>): void => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(payload));
  };

  function lost(): void {
    clearInterval(ping);
    if (stopped) return;
    opts.onStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    retry = setTimeout(dial, delay);
  }

  function dial(): void {
    // Read per dial: the server address is a live setting (Config › Server address).
    ws = make(`${HUB_ORIGIN.replace(/^http/, 'ws')}/api/live`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      attempt = 0;
      ws.send(helloFrame(opts.threadId, opts.aec, opts.tts, owedSeq, opts.micRate));
      lastRx = Date.now();
      clearInterval(ping);
      const self = ws;
      ping = setInterval(() => {
        if (Date.now() - lastRx > DEAD_AFTER_MS) {
          self.onclose = null;
          self.onmessage = null;
          self.close();
          lost();
          return;
        }
        sendJson({ type: 'ping' });
      }, PING_MS);
      opts.onStatus('open');
    };
    ws.onmessage = (ev) => {
      lastRx = Date.now();
      if (typeof ev.data !== 'string' && !(ev.data instanceof ArrayBuffer)) return;
      const frame = parseLiveFrame(ev.data);
      if (!frame) return;
      if (frame.type === 'turn') owedSeq = frame.seq;
      else if (frame.type === 'state' && frame.value === 'listening') owedSeq = undefined;
      else if (frame.type === 'ended') stopped = true;
      opts.onFrame(frame);
    };
    ws.onclose = (ev) => {
      const code = ev?.code;
      if ((code === POLICY_CLOSE_CODE || code === ORIGIN_REFUSED_CODE) && !stopped) {
        stopped = true;
        clearInterval(ping);
        opts.onStatus(code === POLICY_CLOSE_CODE ? 'locked' : 'refused');
        return;
      }
      lost();
    };
    ws.onerror = () => {};
  }

  opts.onStatus('connecting');
  dial();

  return {
    sendAudio(pcm) {
      if (!stopped && ws.readyState === OPEN) ws.send(pcm);
    },
    playback(turnId, playedMs) {
      sendJson({ type: 'playback', turn_id: turnId, played_ms: playedMs });
    },
    drained(turnId) {
      sendJson({ type: 'drained', turn_id: turnId });
    },
    interrupt() {
      owedSeq = undefined;
      sendJson({ type: 'interrupt' });
    },
    hold() {
      sendJson({ type: 'hold' });
    },
    diag(message) {
      sendJson({ type: 'diag', message: message.slice(0, 300) });
    },
    stop() {
      if (stopped && ws.readyState !== OPEN) return;
      stopped = true;
      clearInterval(ping);
      clearTimeout(retry);
      sendJson({ type: 'stop' });
      ws.close(1000, 'stop');
    },
  };
}
