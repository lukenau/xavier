// The key bar's chip table — 1:1 with apps/hub/src/routes/terminal/KeyBar.tsx.
// Data, not UI, so the byte sequences can be pinned by a test that cannot be
// satisfied by a label alone: every one of these is a control code the iOS
// software keyboard cannot type, and a wrong byte is silent (the pty just does
// something else).

export interface KeyChip {
  label: string;
  seq: string;
  /** Hold-to-repeat. Arrows only, exactly as the PWA (KeyBar.tsx:20-23). */
  repeat?: boolean;
}

export const KEYS: readonly KeyChip[] = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\x09' },
  // '⏎' exists because the composer refuses to send a bare \r on empty input.
  { label: '⏎', seq: '\r' },
  { label: '⌃C', seq: '\x03' },
  { label: '⌃D', seq: '\x04' },
  { label: '⌃R', seq: '\x12' },
  { label: '⌃Z', seq: '\x1a' },
  { label: '⌃A', seq: '\x01' },
  { label: '⌃E', seq: '\x05' },
  { label: '⌃U', seq: '\x15' },
  { label: '⌃W', seq: '\x17' },
  { label: '⌃L', seq: '\x0c' },
  { label: '←', seq: '\x1b[D', repeat: true },
  { label: '↓', seq: '\x1b[B', repeat: true },
  { label: '↑', seq: '\x1b[A', repeat: true },
  { label: '→', seq: '\x1b[C', repeat: true },
];

/** tmux window hopping without the prefix-key dance: ‹win / win› cycle, ⊞ opens
 * tmux's own chooser — which the arrow + ⏎ chips then drive.
 *
 * REPRODUCED, NOT FIXED (inventory OQ-28): the prefix is hard-coded `C-b`
 * (\x02). A tmux config with a different prefix sends the wrong byte, same as
 * the PWA. */
export const TMUX_PREFIX = '\x02';

export const TMUX_KEYS: readonly KeyChip[] = [
  { label: '‹win', seq: `${TMUX_PREFIX}p` },
  { label: '⊞', seq: `${TMUX_PREFIX}w` },
  { label: 'win›', seq: `${TMUX_PREFIX}n` },
];

/** `C-b [` enters tmux copy-mode (arrows page history); `q` drops back out.
 *
 * REPRODUCED, NOT FIXED (inventory OQ-28): the chip's label is CLIENT state.
 * If tmux leaves copy-mode on its own — the user types `q` in the composer,
 * or a command exits it — the chip still reads `exit` and its next tap sends
 * a bare `q` to the shell. */
export const COPY_MODE_ENTER = `${TMUX_PREFIX}[`;
export const COPY_MODE_EXIT = 'q';

export const REPEAT_DELAY_MS = 350;
export const REPEAT_INTERVAL_MS = 70;
