// Global teardown for deferred React work — runs after every test FILE, while
// that file's module registry, sandbox globals and jest environment are still
// alive.
//
// Why this exists: react-test-renderer has no automatic cleanup. Twenty-six
// suites in this repo create trees and never unmount them, and several
// components schedule asynchronous state updates after mount
// (motion.ts:19's AccessibilityInfo promise, CalendarScreen.tsx:263's
// setRequesting, chat parts' 1s setIntervals). Under CPU load those updates
// land after the file's tests have finished, i.e. during or after the
// environment teardown — which is exactly the flake this repo kept seeing:
// "Cannot log after tests are done", reportGlobalError dying inside
// window.dispatchEvent, "an import after the environment was torn down", and
// a failure set that moves between runs while every implicated file passes in
// isolation.
//
// The fix is to drain the deferred work before teardown instead of racing it:
// 1. Track every root the file creates by wrapping react-test-renderer's
//    create (the wrapper is installed per file, so the tracking list can
//    never leak across files).
// 2. In a file-level afterAll, unmount each root inside act() so cleanup
//    effects run and their own async fallout is flushed, then yield one
//    macrotask so anything scheduled during unmount completes here rather
//    than after teardown.
const TestRenderer = require('react-test-renderer');

const roots = [];
const originalCreate = TestRenderer.create;
if (typeof originalCreate === 'function' && !TestRenderer.__hubRootTracking) {
  TestRenderer.create = function trackedCreate(...args) {
    const root = originalCreate.apply(this, args);
    roots.push(root);
    return root;
  };
  // Guard against the setup being evaluated twice in one environment.
  Object.defineProperty(TestRenderer, '__hubRootTracking', { value: true });
}

async function unmountAllTrackedRoots() {
  while (roots.length > 0) {
    const root = roots.pop();
    try {
      if (typeof TestRenderer.act === 'function') {
        TestRenderer.act(() => {
          root.unmount();
        });
      } else {
        root.unmount();
      }
    } catch {
      try {
        root.unmount();
      } catch {
        // A tree that was already unmounted by the suite itself is fine.
      }
    }
  }
}

afterAll(async () => {
  // A suite that failed mid-test can leave fake timers installed; real
  // timers are what we want to yield to here.
  try {
    if (jest.isMockFunction(setTimeout)) jest.useRealTimers();
  } catch {
    // Fall through — the drain below is best-effort.
  }
  await unmountAllTrackedRoots();
  // Let any work scheduled during unmount (promise callbacks, macrotasks)
  // run while this file's environment still exists.
  await new Promise((resolve) => setTimeout(resolve, 0));
});
