import { nextShownLength } from './useSmoothedText';

describe('nextShownLength — the reveal never invents text, and never falls far behind', () => {
  it('stops at what has actually arrived', () => {
    expect(nextShownLength(10, 10)).toBe(10);
    expect(nextShownLength(12, 10)).toBe(10);
  });

  it('always advances by at least one character', () => {
    expect(nextShownLength(0, 1)).toBe(1);
    expect(nextShownLength(99, 100)).toBe(100);
  });

  it('closes a small gap smoothly rather than in one jump', () => {
    const next = nextShownLength(0, 40);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(40);
  });

  it('converges on the text that has arrived', () => {
    let shown = 0;
    for (let i = 0; i < 40; i += 1) shown = nextShownLength(shown, 300);
    expect(shown).toBe(300);
  });

  it('jumps rather than replaying when a merged post lands all at once', () => {
    // The plugin now coalesces queued deltas, so one frame can bring a thousand
    // characters; typing those out in order would replay old text.
    expect(nextShownLength(0, 5000)).toBeGreaterThan(4700);
  });

  it('never runs past the text it was given', () => {
    for (const [shown, total] of [[0, 1], [0, 5000], [4999, 5000], [250, 260]]) {
      expect(nextShownLength(shown, total)).toBeLessThanOrEqual(total);
    }
  });
});
