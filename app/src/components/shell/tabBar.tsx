// Tab-bar visibility for pushed detail routes.
//
// UIKit keeps the tab bar on pushed screens and expo-router exposes no
// per-screen `hidesBottomBarWhenPushed`; the documented pattern is a context
// above <NativeTabs>, a `hidden` prop fed from it, and a focus effect on each
// pushed screen (docs/research/native-chrome.md §"Nested Stack inside a tab").
//
// The count, rather than a boolean, is what makes nesting safe: pushing a
// second hiding screen runs the outgoing screen's blur cleanup and the
// incoming screen's focus effect in an order react-navigation does not
// promise, and a boolean loses the race in one of the two orders.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useFocusEffect } from 'expo-router';

interface TabBarVisibility {
  hiddenCount: number;
  push: () => void;
  pop: () => void;
}

const TabBarVisibilityContext = createContext<TabBarVisibility>({
  hiddenCount: 0,
  push: () => {},
  pop: () => {},
});

/** Mount above `<NativeTabs>` in app/_layout.tsx. */
export function TabBarVisibilityProvider({ children }: { children: ReactNode }) {
  const [hiddenCount, setHiddenCount] = useState(0);
  // Stable identities: useHideTabBar puts these in its focus-effect deps, and
  // a fresh function per count change would re-run the effect on its own
  // update — push, re-render, push, forever.
  const push = useCallback(() => setHiddenCount((n) => n + 1), []);
  const pop = useCallback(() => setHiddenCount((n) => Math.max(0, n - 1)), []);
  const value = useMemo<TabBarVisibility>(
    () => ({ hiddenCount, push, pop }),
    [hiddenCount, push, pop],
  );
  return <TabBarVisibilityContext value={value}>{children}</TabBarVisibilityContext>;
}

/** `<NativeTabs hidden={useTabBarHidden()}>`. Also read by Screen for its bottom inset. */
export function useTabBarHidden(): boolean {
  return useContext(TabBarVisibilityContext).hiddenCount > 0;
}

/**
 * Call at the top of any screen that is a push rather than a tab root: the tab
 * bar drops while the screen is focused and comes back when it is popped.
 * Pass `false` for a pushed screen that should keep the tab bar.
 */
export function useHideTabBar(hidden: boolean = true): void {
  const { push, pop } = useContext(TabBarVisibilityContext);
  useFocusEffect(
    useCallback(() => {
      if (!hidden) return;
      push();
      return pop;
    }, [hidden, push, pop]),
  );
}
