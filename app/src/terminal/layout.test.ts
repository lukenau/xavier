import {
  bottomSpacerHeight,
  KEYBOARD_SPACER,
  MIN_VIEWPORT,
  terminalViewportHeight,
} from './layout';

describe('terminalViewportHeight', () => {
  test('is the whole box while the keyboard is down', () => {
    expect(terminalViewportHeight(600, 0)).toBe(600);
  });

  test('loses exactly the keyboard height — the sticky bar translates, it does not resize', () => {
    // KeyboardStickyView moves the bar by the FULL keyboard height (no offset
    // is passed), so that is what it covers.
    expect(terminalViewportHeight(600, 336)).toBe(264);
  });

  test('does NOT credit the collapsing spacer twice', () => {
    // The spacer's 34→4 collapse already grew the canvas by 30 before this is
    // called, so `boxHeight` carries it. Subtracting it again here fitted the
    // grid ~2 rows too tall and hid the prompt behind the key bar.
    const withSpacerCollapse = 630; // 600 + (34 - 4)
    expect(terminalViewportHeight(withSpacerCollapse, 336)).toBe(294);
    expect(terminalViewportHeight(withSpacerCollapse, 336)).not.toBe(324);
  });

  test('never fits to zero rows', () => {
    expect(terminalViewportHeight(200, 400)).toBe(MIN_VIEWPORT);
  });
});

describe('bottomSpacerHeight', () => {
  test('is the safe-area inset with the keyboard down and 4px with it up', () => {
    expect(bottomSpacerHeight(0, 34)).toBe(34);
    expect(bottomSpacerHeight(336, 34)).toBe(KEYBOARD_SPACER);
    expect(KEYBOARD_SPACER).toBe(4);
  });
});
