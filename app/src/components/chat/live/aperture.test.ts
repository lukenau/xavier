import { APERTURE_MODE, apertureDots, apertureGeometry, apertureTicks, sentenceAt, splitHeard, TICKS } from './aperture';

const base = { size: 300, t: 1000, level: 0, progress: 0, reduceMotion: false };
const lit = (mode: number, extra: Partial<typeof base> = {}) =>
  apertureDots({ ...base, ...extra, mode: mode as never }).filter((d) => d.lit).length;

describe('aperture', () => {
  it('keeps every dot inside the circle', () => {
    const { cx, cy, R } = apertureGeometry(300);
    for (const d of apertureDots({ ...base, mode: APERTURE_MODE.listening, level: 1 })) {
      expect(Math.hypot(d.x - cx, d.y - cy)).toBeLessThanOrEqual(R + 0.001);
    }
  });

  it('blooms wider with a louder voice', () => {
    expect(lit(APERTURE_MODE.speaking, { level: 0.9 })).toBeGreaterThan(lit(APERTURE_MODE.speaking, { level: 0.1 }) * 2);
  });

  it('draws an X when idle and a narrow scan line while thinking', () => {
    const idle = lit(APERTURE_MODE.off);
    expect(idle).toBeGreaterThan(4);
    expect(idle).toBeLessThan(apertureDots({ ...base, mode: APERTURE_MODE.off }).length / 3);
    expect(lit(APERTURE_MODE.thinking)).toBeLessThan(apertureDots({ ...base, mode: APERTURE_MODE.thinking }).length / 3);
  });

  it('only the rim lights while reconnecting', () => {
    const { cx, cy, R, pitch } = apertureGeometry(300);
    const rim = apertureDots({ ...base, mode: APERTURE_MODE.reconnecting }).filter((d) => d.lit);
    expect(rim.length).toBeGreaterThan(0);
    for (const d of rim) expect(Math.hypot(d.x - cx, d.y - cy)).toBeGreaterThan(R - pitch * 1.6);
  });

  it('holds still under reduce motion', () => {
    const a = apertureDots({ ...base, t: 100, mode: APERTURE_MODE.thinking, reduceMotion: true });
    const b = apertureDots({ ...base, t: 9000, mode: APERTURE_MODE.thinking, reduceMotion: true });
    expect(a).toEqual(b);
  });

  it('fills ticks with reply progress', () => {
    expect(apertureTicks(300, 0).filter((t) => t.lit)).toHaveLength(0);
    expect(apertureTicks(300, 0.5).filter((t) => t.lit)).toHaveLength(TICKS / 2);
    expect(apertureTicks(300, 2).filter((t) => t.lit)).toHaveLength(TICKS);
  });

  it('splits a caption into heard and still-to-come at word boundaries', () => {
    expect(splitHeard('Five things tomorrow.', 0)).toEqual(['', 'Five things tomorrow.']);
    expect(splitHeard('Five things tomorrow.', 0.5)).toEqual(['Five things', ' tomorrow.']);
    expect(splitHeard('Five things tomorrow.', 1)).toEqual(['Five things tomorrow.', '']);
  });
});

describe('sentenceAt', () => {
  const reply = 'Five things tomorrow. Standup at ten. Then lunch.';
  it('shows the sentence being spoken, split at the playhead', () => {
    expect(sentenceAt(reply, 0)).toEqual(['', 'Five things tomorrow.']);
    expect(sentenceAt(reply, 0.66)).toEqual(['Standup at', ' ten.']);
    expect(sentenceAt(reply, 1)).toEqual(['Then lunch.', '']);
  });
  it('handles text with no sentence end', () => {
    expect(sentenceAt('checking your', 0)).toEqual(['', 'checking your']);
  });
});
