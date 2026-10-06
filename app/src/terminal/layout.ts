// Geometry the terminal screen needs as numbers, kept out of the component so
// the keyboard arithmetic can be tested without a keyboard.
//
// The key bar + composer are pinned with KeyboardStickyView, which TRANSLATES
// them by the full keyboard height and resizes nothing
// (react-native-keyboard-controller KeyboardStickyView: `translateY:
// height.value + offset`, and this screen passes no offset). So when the
// keyboard opens, the bar slides up OVER the canvas and hides exactly
// `keyboardHeight` of it.
//
// The canvas is not quite frame-stable, and the reason is the bottom spacer:
// it collapses from the safe-area inset to 4px with the keyboard up (the PWA's
// own rule — the keyboard already covers the home indicator), which is a
// layout change, so `flex: 1` hands the canvas those ~30px and `onLayout`
// reports the taller box. That is the ONLY frame change; the keyboard's own
// height never resizes the WebView, which is what webview#3689 is about.
// If a device run shows #3689's blank band anyway, the fix is to stop the
// spacer participating: hold it at the inset and pass
// `offset={{ opened: insetBottom - KEYBOARD_SPACER }}` to KeyboardStickyView
// instead, which buys the same 4px gap through the translate.

/** XtermView.tsx:267 — the safe-area spacer collapses to 4px with the keyboard
 * up, because the keyboard already covers the home indicator. */
export const KEYBOARD_SPACER = 4;

/** Enough for the fit addon to compute a sane grid if a keyboard somehow
 * claims nearly the whole screen. Below this, rows would go to zero. */
export const MIN_VIEWPORT = 60;

/**
 * Visible height of the terminal once the sticky bar has translated up.
 *
 * `boxHeight` is the canvas's CURRENT measured height, so the spacer's
 * collapse is already in it; subtracting anything for that give-back a second
 * time fits the grid about two rows too tall and puts the prompt behind the
 * key bar.
 */
export function terminalViewportHeight(boxHeight: number, keyboardHeight: number): number {
  if (keyboardHeight <= 0) return boxHeight;
  return Math.max(MIN_VIEWPORT, boxHeight - keyboardHeight);
}

/** XtermView.tsx:267 again, as a number. */
export function bottomSpacerHeight(keyboardHeight: number, insetBottom: number): number {
  return keyboardHeight > 0 ? KEYBOARD_SPACER : insetBottom;
}
