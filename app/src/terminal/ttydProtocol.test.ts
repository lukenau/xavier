// Byte fixtures below were produced by replaying apps/hub/src/lib/ttyd.ts's
// exact expressions through Node's TextEncoder (see the report). They are the
// contract: ttyd 1.7.4 on this host has been parsing these frames from the PWA
// in production, so any drift here is a regression, not a style choice.
import {
  CLIENT_OP,
  FLOW_HIGH,
  FLOW_LIMIT,
  FLOW_LOW,
  FlowController,
  SERVER_OP,
  TTYD_SUBPROTOCOL,
  decodeServerFrame,
  encodeHandshake,
  encodeInput,
  encodePause,
  encodeResize,
  encodeResume,
  utf8Decode,
  utf8Encode,
} from './ttydProtocol';

const bytes = (u8: Uint8Array) => Array.from(u8);

describe('opcode table', () => {
  it('matches ttyd 1.7.x both directions', () => {
    expect(CLIENT_OP).toEqual({ INPUT: '0', RESIZE: '1', PAUSE: '2', RESUME: '3' });
    expect(SERVER_OP).toEqual({ OUTPUT: '0', TITLE: '1', PREFS: '2' });
    expect(TTYD_SUBPROTOCOL).toBe('tty');
  });
});

describe('client → server framing (PWA byte fixtures)', () => {
  it('handshake is opcode-less JSON with AuthToken/columns/rows in that order', () => {
    // JSON.stringify({AuthToken:'',columns:80,rows:24})
    expect(bytes(encodeHandshake('', 80, 24))).toEqual([
      123, 34, 65, 117, 116, 104, 84, 111, 107, 101, 110, 34, 58, 34, 34, 44, 34, 99, 111, 108, 117,
      109, 110, 115, 34, 58, 56, 48, 44, 34, 114, 111, 119, 115, 34, 58, 50, 52, 125,
    ]);
    expect(bytes(encodeHandshake('abc123', 100, 40))).toEqual([
      123, 34, 65, 117, 116, 104, 84, 111, 107, 101, 110, 34, 58, 34, 97, 98, 99, 49, 50, 51, 34,
      44, 34, 99, 111, 108, 117, 109, 110, 115, 34, 58, 49, 48, 48, 44, 34, 114, 111, 119, 115, 34,
      58, 52, 48, 125,
    ]);
  });

  it("input is '0' + raw UTF-8, control bytes unescaped", () => {
    expect(bytes(encodeInput('ls -la\r'))).toEqual([48, 108, 115, 32, 45, 108, 97, 13]);
    expect(bytes(encodeInput('\x1b'))).toEqual([48, 27]); // KeyBar ESC chip
    expect(bytes(encodeInput('\x03'))).toEqual([48, 3]); // ctrl-C
    expect(bytes(encodeInput('\x02p'))).toEqual([48, 2, 112]); // tmux prefix + p
  });

  it('input carries multi-byte and astral characters byte-for-byte', () => {
    expect(bytes(encodeInput('héllo → 🚀'))).toEqual([
      48, 104, 195, 169, 108, 108, 111, 32, 226, 134, 146, 32, 240, 159, 154, 128,
    ]);
  });

  it("resize is '1' + {columns,rows} JSON", () => {
    expect(bytes(encodeResize(80, 24))).toEqual([
      49, 123, 34, 99, 111, 108, 117, 109, 110, 115, 34, 58, 56, 48, 44, 34, 114, 111, 119, 115, 34,
      58, 50, 52, 125,
    ]);
    expect(bytes(encodeResize(120, 51))).toEqual([
      49, 123, 34, 99, 111, 108, 117, 109, 110, 115, 34, 58, 49, 50, 48, 44, 34, 114, 111, 119, 115,
      34, 58, 53, 49, 125,
    ]);
  });

  it('pause and resume are bare single-byte frames', () => {
    expect(bytes(encodePause())).toEqual([50]);
    expect(bytes(encodeResume())).toEqual([51]);
  });
});

describe('server → client decoding', () => {
  it("'0' is output, payload handed over as raw bytes", () => {
    const frame = decodeServerFrame(new Uint8Array([48, 104, 105]));
    expect(frame).toEqual({ kind: 'output', data: new Uint8Array([104, 105]) });
  });

  it("'1' is a UTF-8 title", () => {
    expect(decodeServerFrame(new Uint8Array([49, 88, 97, 118, 105, 101, 114]))).toEqual({
      kind: 'title',
      title: 'Xavier',
    });
  });

  it("'2' is preferences — surfaced but never applied", () => {
    const frame = decodeServerFrame(
      new Uint8Array([50, 123, 34, 102, 111, 110, 116, 83, 105, 122, 101, 34, 58, 49, 52, 125]),
    );
    expect(frame?.kind).toBe('prefs');
  });

  it('accepts an ArrayBuffer (binaryType=arraybuffer) identically', () => {
    const buf = new Uint8Array([48, 104, 105]).buffer;
    expect(decodeServerFrame(buf)).toEqual({ kind: 'output', data: new Uint8Array([104, 105]) });
  });

  it('re-encodes a text frame before parsing (hub-api forwards upstream str frames as text)', () => {
    expect(decodeServerFrame('0hi')).toEqual({ kind: 'output', data: new Uint8Array([104, 105]) });
  });

  it('drops empty frames rather than reading opcode 0x00', () => {
    expect(decodeServerFrame(new Uint8Array([]))).toBeNull();
    expect(decodeServerFrame('')).toBeNull();
  });

  it('keeps an unknown opcode distinguishable instead of mistaking it for output', () => {
    expect(decodeServerFrame(new Uint8Array([57, 1, 2]))).toEqual({
      kind: 'unknown',
      opcode: '9',
      data: new Uint8Array([1, 2]),
    });
  });
});

describe('hand-rolled UTF-8 codec matches TextEncoder/TextDecoder', () => {
  const samples = [
    '',
    'ascii only',
    'ls -la\r\n',
    '\x00\x01\x1b[31m',
    'héllo',
    'naïve café',
    '→ ← ↑ ↓',
    '日本語テキスト',
    '🚀🔥',
    'mixed 🚀 é → end',
    '߿ࠀ￿', // the boundaries between 2-, 3- and 4-byte widths
    '\u{10000}\u{10ffff}', // first and last astral code points
    '퟿', // the code points either side of the surrogate block
  ];

  it.each(samples)('round-trips %j', (s) => {
    const encoded = utf8Encode(s);
    expect(bytes(encoded)).toEqual(Array.from(new TextEncoder().encode(s)));
    expect(utf8Decode(encoded)).toBe(s);
    expect(utf8Decode(encoded)).toBe(new TextDecoder().decode(encoded));
  });

  it('replaces an unpaired surrogate with U+FFFD, as TextEncoder does', () => {
    expect(bytes(utf8Encode('a\ud800b'))).toEqual([97, 239, 191, 189, 98]);
    expect(bytes(utf8Encode('a\ud800b'))).toEqual(
      Array.from(new TextEncoder().encode('a\ud800b')),
    );
  });

  it('decodes a truncated multi-byte tail without throwing', () => {
    expect(utf8Decode(new Uint8Array([104, 105, 240, 159]))).toBe('hi�');
  });

  it.each([
    [[0xe2, 0x28, 0xa1], 'bad continuation in a 3-byte sequence'],
    [[0xc3, 0x28], 'bad continuation in a 2-byte sequence'],
    [[0xf0, 0x9f, 0x28, 0x80], 'bad continuation mid 4-byte sequence'],
    [[0x80], 'a lone continuation byte'],
    [[0x68, 0x69, 0xf0, 0x9f], 'a truncated tail'],
    [[0xff, 0xfe], 'bytes that are no valid lead at all'],
    [[0xed, 0xa0, 0x80], 'CESU-8 surrogate — must NOT decode to a lone surrogate'],
    [[0xed, 0xbf, 0xbf], 'the top of the surrogate block'],
    [[0xf7, 0xbf, 0xbf, 0xbf], 'a 5-bit lead, above U+10FFFF'],
    [[0xf4, 0x90, 0x80, 0x80], 'U+110000, one past the top plane'],
    [[0xc0, 0x80], 'overlong NUL'],
    [[0xc1, 0xbf], 'overlong 0x7f'],
    [[0xe0, 0x80, 0x80], 'overlong 3-byte'],
    [[0xf0, 0x80, 0x80, 0x80], 'overlong 4-byte'],
  ])('replacement-decodes %j (%s) exactly as TextDecoder does', (raw) => {
    const u8 = new Uint8Array(raw as number[]);
    expect(utf8Decode(u8)).toBe(new TextDecoder().decode(u8));
  });
});

describe('FlowController — ttyd pause/resume accounting', () => {
  it('exposes ttyd client defaults', () => {
    expect([FLOW_LIMIT, FLOW_HIGH, FLOW_LOW]).toEqual([100_000, 10, 4]);
  });

  it('asks for no ack until the running count passes FLOW_LIMIT', () => {
    const flow = new FlowController();
    expect(flow.onOutput(FLOW_LIMIT)).toEqual({ needsAck: false, pause: false });
    expect(flow.pending).toBe(0);
    expect(flow.onOutput(1)).toEqual({ needsAck: true, pause: false });
    expect(flow.pending).toBe(1);
  });

  it('resets the byte counter on each acked chunk (windows do not accumulate)', () => {
    const flow = new FlowController();
    flow.onOutput(FLOW_LIMIT + 1);
    expect(flow.written).toBe(0);
    expect(flow.onOutput(10)).toEqual({ needsAck: false, pause: false });
  });

  it('pauses once pending exceeds FLOW_HIGH and not before', () => {
    const flow = new FlowController();
    const results = [];
    for (let i = 0; i < FLOW_HIGH + 1; i += 1) results.push(flow.onOutput(FLOW_LIMIT + 1));
    expect(results.slice(0, FLOW_HIGH).every((r) => !r.pause)).toBe(true);
    expect(results[FLOW_HIGH]).toEqual({ needsAck: true, pause: true });
    expect(flow.paused).toBe(true);
  });

  it('does not re-pause while already paused', () => {
    const flow = new FlowController();
    for (let i = 0; i < FLOW_HIGH + 1; i += 1) flow.onOutput(FLOW_LIMIT + 1);
    expect(flow.onOutput(FLOW_LIMIT + 1)).toEqual({ needsAck: true, pause: false });
  });

  it('resumes only when pending drops below FLOW_LOW', () => {
    const flow = new FlowController();
    for (let i = 0; i < FLOW_HIGH + 1; i += 1) flow.onOutput(FLOW_LIMIT + 1);
    expect(flow.pending).toBe(FLOW_HIGH + 1);
    // 11 → 4: still at/above the low-water mark, stay paused.
    for (let i = 0; i < FLOW_HIGH + 1 - FLOW_LOW; i += 1) expect(flow.onAck()).toEqual({ resume: false });
    expect(flow.pending).toBe(FLOW_LOW);
    expect(flow.onAck()).toEqual({ resume: true });
    expect(flow.paused).toBe(false);
  });

  it('never resumes when it was not paused', () => {
    const flow = new FlowController();
    flow.onOutput(FLOW_LIMIT + 1);
    expect(flow.onAck()).toEqual({ resume: false });
  });

  it('reset() clears the window so a new socket starts unpaused', () => {
    const flow = new FlowController();
    for (let i = 0; i < FLOW_HIGH + 1; i += 1) flow.onOutput(FLOW_LIMIT + 1);
    flow.reset();
    expect([flow.written, flow.pending, flow.paused]).toEqual([0, 0, false]);
  });
});
