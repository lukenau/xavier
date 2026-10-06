import { tokens } from './tokens';

describe('theme tokens', () => {
  it('dark and light declare identical key sets', () => {
    const darkKeys = Object.keys(tokens.dark).sort();
    const lightKeys = Object.keys(tokens.light).sort();
    expect(lightKeys).toEqual(darkKeys);
  });

  it('no key has an empty value in either theme', () => {
    const emptyDark = Object.entries(tokens.dark)
      .filter(([, value]) => value.length === 0)
      .map(([key]) => key);
    const emptyLight = Object.entries(tokens.light)
      .filter(([, value]) => value.length === 0)
      .map(([key]) => key);
    expect(emptyDark).toEqual([]);
    expect(emptyLight).toEqual([]);
  });

  // Spot-check values read directly from apps/hub/src/styles/tokens.css.
  it('dark accent is #f0ab5e', () => {
    expect(tokens.dark.accent).toBe('#f0ab5e');
  });

  it('dark bg-0 is #000d0e', () => {
    expect(tokens.dark['bg-0']).toBe('#000d0e');
  });

  it('light bg-0 is #e1e7cc', () => {
    expect(tokens.light['bg-0']).toBe('#e1e7cc');
  });

  it('dark fg-0 is #f4f4f3', () => {
    expect(tokens.dark['fg-0']).toBe('#f4f4f3');
  });

  it('dark status-down is #f87171', () => {
    expect(tokens.dark['status-down']).toBe('#f87171');
  });

  it('light status-down is #b3002b', () => {
    expect(tokens.light['status-down']).toBe('#b3002b');
  });

  // The light block in tokens.css never redeclares type-scale/radii/motion
  // tokens — they inherit from dark via the CSS cascade. These pin the
  // actual inherited value (not just structural key-set/non-empty checks),
  // which is the part the generator's dark-merge is responsible for.
  it('text-base (not overridden in light) is 14px in both themes', () => {
    expect(tokens.dark['text-base']).toBe('14px');
    expect(tokens.light['text-base']).toBe('14px');
  });

  it('r-md (not overridden in light) is 10px and equal across themes', () => {
    expect(tokens.dark['r-md']).toBe('10px');
    expect(tokens.light['r-md']).toBe(tokens.dark['r-md']);
  });
});
