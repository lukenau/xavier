// The shipped async-storage mock only EXPORTS a mock object; it does not
// register itself, so it has to be used as a jest.mock factory.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Skia's native module throws at import time under jest
// (TurboModuleRegistry.getEnforcing). Since the chat transcript can now render
// a chart widget, any test that mounts a message reaches it, so the stand-in
// belongs here rather than in each suite. The chart suites still declare their
// own richer mock, which takes precedence over this one.
jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const { View } = require('react-native');
  const node = (name) => (props) => React.createElement(View, { testID: name, ...props }, props.children);
  return {
    Canvas: node('sk-canvas'),
    Group: node('sk-group'),
    Line: node('sk-line'),
    Path: node('sk-path'),
    Rect: node('sk-rect'),
    RoundedRect: node('sk-rrect'),
    Circle: node('sk-circle'),
    Text: node('sk-text'),
    vec: (x, y) => ({ x, y }),
    useFont: () => ({
      measureText: (text) => ({ x: 0, y: 0, width: text.length * 6, height: 10 }),
    }),
  };
});

// Whimsy's decorative loops (scan band, sheen, dot scanner) are Animated.loops
// that run until unmount. Suites that leave a tree mounted — ThreadScreen does —
// would keep them firing after the environment is torn down, which crashes the
// worker or stops jest exiting. Tests get the level from the real store but
// never the motion, exactly like iOS Reduce Motion.
jest.mock('./src/whimsy/level', () => {
  const actual = jest.requireActual('./src/whimsy/level');
  return {
    ...actual,
    useWhimsy: () => ({ level: actual.useWhimsyStore((s) => s.level), motion: false }),
  };
});

// react-test-renderer reports every uncaught error via reportGlobalError,
// which branches on `typeof window.ErrorEvent === 'function'` and then calls
// `window.dispatchEvent(event)`. This environment has the first half and not
// the second: the react-native preset points `window` at the sandbox global
// (window === global), Node 26 defines a global ErrorEvent, and nothing
// defines the EventTarget methods. So the branch is taken and every uncaught
// error raised inside a React tree dies as
//   TypeError: window.dispatchEvent is not a function
// instead of being reported — and because React raises these while flushing
// work that outlived its test, the TypeError also lands at teardown time
// ("Cannot log after tests are done"), which is what makes the flake look like
// a Jest environment problem rather than the error it actually is.
//
// Restoring the two EventTarget methods makes that branch behave the way it
// does under jsdom. With no listener the error is re-raised so it still fails
// the suite that produced it, with its own stack; a suite that wants to
// intercept global errors can addEventListener('error', …) itself.
if (typeof globalThis.dispatchEvent !== 'function') {
  const listeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  };
  globalThis.removeEventListener = (type, fn) => {
    const list = listeners.get(type);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
  };
  globalThis.dispatchEvent = (event) => {
    const list = listeners.get(event?.type ?? '') ?? [];
    list.forEach((fn) => fn(event));
    if (list.length === 0 && event?.type === 'error') {
      const error = event.error ?? new Error(String(event.message ?? 'unknown error'));
      setTimeout(() => {
        throw error;
      }, 0);
    }
    return true;
  };
}
