import { bytesToBase64, concatBytes } from './base64';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('bytesToBase64', () => {
  test('matches Node for every remainder class', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 255, 1024]) {
      const input = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) input[i] = (i * 37 + 11) & 0xff;
      expect(bytesToBase64(input)).toBe(Buffer.from(input).toString('base64'));
    }
  });

  test('pads one leftover byte with == and two with =', () => {
    expect(bytesToBase64(bytes(0x66))).toBe('Zg==');
    expect(bytesToBase64(bytes(0x66, 0x6f))).toBe('Zm8=');
    expect(bytesToBase64(bytes(0x66, 0x6f, 0x6f))).toBe('Zm9v');
  });

  test('carries the high bit — pty output is not ASCII', () => {
    // A UTF-8 '█' plus an escape sequence: every byte above 0x7f has to
    // survive, because this is what the page decodes straight back into bytes.
    expect(bytesToBase64(bytes(0xe2, 0x96, 0x88, 0x1b, 0x5b, 0x30, 0x6d))).toBe(
      Buffer.from([0xe2, 0x96, 0x88, 0x1b, 0x5b, 0x30, 0x6d]).toString('base64'),
    );
  });

  test('an empty chunk encodes to an empty string, not "=="', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });
});

describe('concatBytes', () => {
  test('joins chunks in order', () => {
    expect(Array.from(concatBytes([bytes(1, 2), bytes(3), bytes(4, 5, 6)]))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  test('an empty list is an empty buffer', () => {
    expect(concatBytes([]).length).toBe(0);
  });
});
