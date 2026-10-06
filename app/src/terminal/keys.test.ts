// Every chip sends a byte sequence the software keyboard cannot type, and a
// wrong byte is SILENT — the pty just does something else. These assert the
// codes, not the labels.
import {
  COPY_MODE_ENTER,
  COPY_MODE_EXIT,
  KEYS,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  TMUX_KEYS,
  TMUX_PREFIX,
} from './keys';

test('the chip set is the PWA\'s, in order', () => {
  expect(KEYS.map((k) => k.label)).toEqual([
    'esc', 'tab', '⏎', '⌃C', '⌃D', '⌃R', '⌃Z', '⌃A', '⌃E', '⌃U', '⌃W', '⌃L',
    '←', '↓', '↑', '→',
  ]);
  expect(TMUX_KEYS.map((k) => k.label)).toEqual(['‹win', '⊞', 'win›']);
});

test('each chip carries its exact control code', () => {
  expect(Object.fromEntries(KEYS.map((k) => [k.label, k.seq]))).toEqual({
    esc: '\x1b',
    tab: '\x09',
    '⏎': '\r',
    '⌃C': '\x03',
    '⌃D': '\x04',
    '⌃R': '\x12',
    '⌃Z': '\x1a',
    '⌃A': '\x01',
    '⌃E': '\x05',
    '⌃U': '\x15',
    '⌃W': '\x17',
    '⌃L': '\x0c',
    '←': '\x1b[D',
    '↓': '\x1b[B',
    '↑': '\x1b[A',
    '→': '\x1b[C',
  });
});

test('the control chips are the C0 code for their letter', () => {
  // ⌃X is the letter's position in the alphabet: C=3, D=4, R=18, Z=26…
  for (const [label, letter] of [['⌃C', 'C'], ['⌃D', 'D'], ['⌃R', 'R'], ['⌃Z', 'Z'], ['⌃A', 'A'], ['⌃E', 'E'], ['⌃U', 'U'], ['⌃W', 'W'], ['⌃L', 'L']]) {
    const chip = KEYS.find((k) => k.label === label);
    expect(chip?.seq.charCodeAt(0)).toBe(letter.charCodeAt(0) - 64);
  }
});

test('only the arrows hold-to-repeat', () => {
  expect(KEYS.filter((k) => k.repeat).map((k) => k.label)).toEqual(['←', '↓', '↑', '→']);
  expect(TMUX_KEYS.every((k) => !k.repeat)).toBe(true);
});

test('the tmux chips are prefix + p/w/n, with the prefix hard-coded to C-b', () => {
  // REPRODUCED, NOT FIXED (OQ-28): a tmux config with a different prefix gets
  // the wrong byte here, exactly as in the PWA.
  expect(TMUX_PREFIX).toBe('\x02');
  expect(TMUX_KEYS.map((k) => k.seq)).toEqual(['\x02p', '\x02w', '\x02n']);
});

test('copy mode enters with C-b [ and leaves with a bare q', () => {
  expect(COPY_MODE_ENTER).toBe('\x02[');
  expect(COPY_MODE_EXIT).toBe('q');
});

test('hold-to-repeat waits 350ms then fires every 70ms', () => {
  expect(REPEAT_DELAY_MS).toBe(350);
  expect(REPEAT_INTERVAL_MS).toBe(70);
});
