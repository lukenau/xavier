// ttyd wire protocol, ported byte-for-byte from apps/hub/src/lib/ttyd.ts
// (verified against ttyd 1.7.4, the version running on this host). Pure: no
// sockets, no React, no react-native — wsClient.ts is the only consumer that
// touches I/O, and everything here is unit-testable on a plain Node runtime.
//
// Frames are 1 ASCII opcode byte + payload. The handshake is the one exception:
// a bare UTF-8 JSON object with no opcode prefix.

export const TTYD_SUBPROTOCOL = 'tty';

/** client → server */
export const CLIENT_OP = {
  INPUT: '0',
  RESIZE: '1',
  PAUSE: '2',
  RESUME: '3',
} as const;

/** server → client */
export const SERVER_OP = {
  OUTPUT: '0',
  TITLE: '1',
  PREFS: '2',
} as const;

// Hermes does not ship TextEncoder/TextDecoder (react-native 0.86 carries no
// polyfill for either — grepped), and a codec that exists in jest's Node env
// but not on device is the one class of bug this host cannot catch. So both
// directions are hand-rolled, and the tests pin them against fixtures produced
// by Node's TextEncoder running the PWA's exact expressions.
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    // An unpaired surrogate is not encodable; WHATWG (and TextEncoder) emit
    // U+FFFD instead of a raw CESU-8 triple.
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;

    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    // WHATWG's lead-byte table. The per-lead bounds on the FIRST continuation
    // byte are what reject overlongs (0xc0/0xc1, 0xe0 80, 0xf0 80), surrogates
    // (0xed a0) and >U+10FFFF (0xf4 90, 0xf5+) structurally — with them there is
    // no such thing as a decoded surrogate or an out-of-range code point, so no
    // post-hoc range check is needed. Without them this silently yields lone
    // surrogates, which cannot be re-encoded and poison any string they reach.
    let needed: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      needed = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      needed = 2;
      if (b0 === 0xe0) lo = 0xa0;
      else if (b0 === 0xed) hi = 0x9f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      needed = 3;
      if (b0 === 0xf0) lo = 0x90;
      else if (b0 === 0xf4) hi = 0x8f;
    } else {
      out += '\ufffd';
      i += 1;
      continue;
    }

    let cp = b0 & (needed === 1 ? 0x1f : needed === 2 ? 0x0f : 0x07);
    let k = 1;
    for (; k <= needed; k += 1) {
      // -1 for "past the end": truncation is just an out-of-range byte.
      const b = i + k < bytes.length ? bytes[i + k] : -1;
      if (b < lo || b > hi) break;
      cp = (cp << 6) | (b & 0x3f);
      lo = 0x80;
      hi = 0xbf;
    }
    if (k <= needed) {
      // One replacement, resync AT the offending byte rather than past the whole
      // sequence — that is what makes the U+FFFD count match TextDecoder's.
      out += '\ufffd';
      i += k;
      continue;
    }
    i += needed + 1;
    if (cp < 0x10000) out += String.fromCharCode(cp);
    else {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  return out;
}

function frame(opcode: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = opcode.charCodeAt(0);
  out.set(body, 1);
  return out;
}

/** Opcode-less: ttyd reads the first frame after the upgrade as the auth JSON.
 * Key order is part of the wire format the PWA has been sending for a year. */
export function encodeHandshake(token: string, columns: number, rows: number): Uint8Array {
  return utf8Encode(JSON.stringify({ AuthToken: token, columns, rows }));
}

export function encodeInput(text: string): Uint8Array {
  return frame(CLIENT_OP.INPUT, utf8Encode(text));
}

export function encodeResize(columns: number, rows: number): Uint8Array {
  return frame(CLIENT_OP.RESIZE, utf8Encode(JSON.stringify({ columns, rows })));
}

export function encodePause(): Uint8Array {
  return frame(CLIENT_OP.PAUSE, new Uint8Array(0));
}

export function encodeResume(): Uint8Array {
  return frame(CLIENT_OP.RESUME, new Uint8Array(0));
}

export type ServerFrame =
  | { kind: 'output'; data: Uint8Array }
  | { kind: 'title'; title: string }
  | { kind: 'prefs'; data: Uint8Array }
  | { kind: 'unknown'; opcode: string; data: Uint8Array };

/** `null` for an empty frame — ttyd sends none, but the PWA drops them and a
 * zero-length read must not be mistaken for opcode '\0'. Text frames are
 * re-encoded to bytes and parsed identically (hub-api's bridge forwards
 * upstream str frames as text, so this branch is reachable in production). */
export function decodeServerFrame(data: ArrayBuffer | Uint8Array | string): ServerFrame | null {
  const buf =
    typeof data === 'string'
      ? utf8Encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  if (buf.length === 0) return null;
  const opcode = String.fromCharCode(buf[0]);
  const payload = buf.subarray(1);
  if (opcode === SERVER_OP.OUTPUT) return { kind: 'output', data: payload };
  if (opcode === SERVER_OP.TITLE) return { kind: 'title', title: utf8Decode(payload) };
  if (opcode === SERVER_OP.PREFS) return { kind: 'prefs', data: payload };
  return { kind: 'unknown', opcode, data: payload };
}

// --- flow control -----------------------------------------------------------
// ttyd's own client default, mirrored from XtermView.tsx:15-17,97-117. The
// renderer acknowledges a write only for the chunk that crosses FLOW_LIMIT;
// more than FLOW_HIGH acks outstanding pauses the pty, fewer than FLOW_LOW
// resumes it. Native port difference: the ack arrives over the WebView bridge
// instead of xterm's write callback, so the accounting lives here.
export const FLOW_LIMIT = 100_000;
export const FLOW_HIGH = 10;
export const FLOW_LOW = 4;

export class FlowController {
  written = 0;
  pending = 0;
  paused = false;

  /** Account for an output chunk. `needsAck` tells the renderer to call back;
   * `pause` tells the caller to send opcode '2' after handing over the bytes. */
  onOutput(byteLength: number): { needsAck: boolean; pause: boolean } {
    this.written += byteLength;
    if (this.written <= FLOW_LIMIT) return { needsAck: false, pause: false };
    this.written = 0;
    this.pending += 1;
    if (!this.paused && this.pending > FLOW_HIGH) {
      this.paused = true;
      return { needsAck: true, pause: true };
    }
    return { needsAck: true, pause: false };
  }

  /** One renderer acknowledgement. `resume` tells the caller to send opcode '3'. */
  onAck(): { resume: boolean } {
    this.pending -= 1;
    if (this.paused && this.pending < FLOW_LOW) {
      this.paused = false;
      return { resume: true };
    }
    return { resume: false };
  }

  /** A new socket is a new ttyd flow window: outstanding acks from the dead
   * connection will never arrive, and a `paused` flag carried across would
   * suppress the pause we owe the new one. (The PWA leaks this state across
   * reconnects; not reproducing that.) */
  reset(): void {
    this.written = 0;
    this.pending = 0;
    this.paused = false;
  }
}
