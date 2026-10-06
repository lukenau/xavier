import {
  BAR_STEPS,
  bar,
  degrees,
  heatColor,
  mixHex,
  normaliseCondition,
  nowAt,
  sunColor,
  temperatureScale,
  waterColor,
} from './weatherLayout';

describe('the scale every bar is drawn against', () => {
  it('spans the coldest low and the warmest high in the set', () => {
    expect(temperatureScale([{ low: 54, high: 63 }, { low: 51, high: 70 }])).toEqual({ min: 51, max: 70 });
  });

  it('gives a flat week room rather than dividing by zero', () => {
    expect(temperatureScale([{ low: 60, high: 60 }])).toEqual({ min: 59, max: 61 });
  });

  it('survives a forecast with nothing usable in it', () => {
    expect(temperatureScale([])).toEqual({ min: 0, max: 1 });
  });
});

describe("a day's bar", () => {
  const scale = { min: 50, max: 70 };

  it('fills only the steps between its low and its high', () => {
    const segments = bar({ low: 60, high: 70 }, scale, 10);
    expect(segments.filter((s) => s.filled)).toHaveLength(5);
    expect(segments.slice(0, 5).every((s) => !s.filled)).toBe(true);
  });

  it('puts a colder day to the left of a warmer one', () => {
    const cold = bar({ low: 50, high: 55 }, scale, 10).findIndex((s) => s.filled);
    const warm = bar({ low: 65, high: 70 }, scale, 10).findIndex((s) => s.filled);
    expect(cold).toBeLessThan(warm);
  });

  it('draws a low and high the wrong way round as the same bar', () => {
    const forwards = bar({ low: 55, high: 65 }, scale, 10);
    const backwards = bar({ low: 65, high: 55 }, scale, 10);
    expect(backwards.map((s) => s.filled)).toEqual(forwards.map((s) => s.filled));
  });

  it('never leaves a day with no bar at all', () => {
    expect(bar({ low: 60, high: 60 }, scale).filter((s) => s.filled).length).toBeGreaterThan(0);
  });

  it('gives every row the same number of steps, so the columns line up', () => {
    expect(bar({ low: 51, high: 52 }, scale)).toHaveLength(BAR_STEPS);
    expect(bar({ low: 51, high: 69 }, scale)).toHaveLength(BAR_STEPS);
  });
});

describe('the dot for right now', () => {
  const scale = { min: 50, max: 70 };

  it('sits where the current reading falls inside the day', () => {
    expect(nowAt(60, { low: 50, high: 70 }, scale)).toBeCloseTo(0.5);
  });

  it('is absent on a day the current reading is not inside', () => {
    expect(nowAt(80, { low: 50, high: 70 }, scale)).toBeNull();
    expect(nowAt(null, { low: 50, high: 70 }, scale)).toBeNull();
  });
});

describe('the temperature ramp', () => {
  // The first cut took these from the theme tokens and came out muddy in light
  // mode — `accent` is a brown there, because it is chosen to be read rather
  // than seen (the user, 2026-09-23: "the colors are too dark in light mode").
  it('runs cold to hot, and holds at both ends', () => {
    expect(heatColor(0, 'dark')).toBe('#5cc4f2'); // theme-exempt: asserts the ramp stop itself
    expect(heatColor(1, 'dark')).toBe('#ff8350'); // theme-exempt: asserts the ramp stop itself
    expect(heatColor(-3, 'dark')).toBe(heatColor(0, 'dark'));
    expect(heatColor(9, 'dark')).toBe(heatColor(1, 'dark'));
    expect(heatColor(NaN, 'light')).toBe(heatColor(0, 'light'));
  });

  it('is a different, brighter set in light mode', () => {
    expect(heatColor(0.5, 'light')).not.toBe(heatColor(0.5, 'dark'));
    // Saturated rather than dark: every light stop is well clear of black.
    for (const at of [0, 0.33, 0.66, 1]) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(heatColor(at, 'light').slice(i, i + 2), 16));
      expect(Math.max(r, g, b)).toBeGreaterThan(150);
    }
  });

  it('gives water and the sun their own colour per theme', () => {
    expect(waterColor('light')).not.toBe(waterColor('dark'));
    expect(sunColor('light')).not.toBe(sunColor('dark'));
  });

  it('blends two resolved colours', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080'); // theme-exempt: mixHex inputs, never rendered directly
    expect(mixHex('#ff0000', '#00ff00', 0)).toBe('#ff0000'); // theme-exempt: mixHex inputs, never rendered directly
    expect(mixHex('#ff0000', '#00ff00', 1)).toBe('#00ff00'); // theme-exempt: mixHex inputs, never rendered directly
  });

  it('returns something drawable when a colour is not a hex value', () => {
    expect(mixHex('rgba(0,0,0,0.1)', '#ffffff', 0.5)).toBe('rgba(0,0,0,0.1)'); // theme-exempt: the unparseable input mixHex must pass through
  });
});

describe('what the sky is doing', () => {
  it.each([
    ['sunny', 'clear'],
    ['Mostly Cloudy', 'cloudy'],
    ['thunderstorm', 'storm'],
    ['light drizzle'.replace('light ', ''), 'rain'],
    ['flurries', 'snow'],
    ['breezy', 'wind'],
    ['haze', 'fog'],
  ])('reads %p as %p', (given, expected) => {
    expect(normaliseCondition(given)).toBe(expected);
  });

  it('draws the night version of a daytime sky at night', () => {
    expect(normaliseCondition('sunny', true)).toBe('clear_night');
    expect(normaliseCondition('partly cloudy', true)).toBe('partly_cloudy_night');
    expect(normaliseCondition('rain', true)).toBe('rain');
  });

  it('falls back to a sky rather than a hole', () => {
    expect(normaliseCondition('volcanic ash')).toBe('cloudy');
    expect(normaliseCondition(undefined)).toBe('cloudy');
    expect(normaliseCondition(undefined, true)).toBe('clear_night');
  });
});

describe('degrees', () => {
  it('rounds, and says nothing when there is no reading', () => {
    expect(degrees(57.6)).toBe('58°');
    expect(degrees(null)).toBe('—');
    expect(degrees(NaN)).toBe('—');
  });
});
