// The PWA's layout frame (App.tsx:53-111, SHELL-04) as a native screen root.
//
// Keep this the FIRST child of every route component, un-wrapped: iOS gives
// the first ScrollView in a native-tabs screen the scroll-to-top and
// minimize-on-scroll behaviour, and a wrapping <View> forfeits both. Overlays
// (Toast, fixed action bars) go beside it inside a fragment, not around it.
//
// Screen itself now owns exactly one such wrapper, to hold the `header` slot
// and the Ground wash outside the scroll view. Expo's guidance for that case
// is `collapsable={false}` on the wrapper (docs/research/native-chrome.md:64),
// and the inset half of the warning does not apply here anyway — this screen
// sets `contentInsetAdjustmentBehavior="never"` and does its own insets.
import { useCallback, useRef, type ReactNode, type Ref } from 'react';
import {
  RefreshControl as RNRefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useIsFocused, useScrollToTop } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/useTheme';
import { Ground } from './Ground';
import { useTabBarHidden } from './tabBar';

/** `<main class="w-full max-w-[440px] mx-auto">` (App.tsx:58-59). */
export const SCREEN_MAX_WIDTH = 440;
/** The `div.px-[18px]` content column inside `<main>` (App.tsx:73). */
export const SCREEN_GUTTER = 18;
/**
 * App.tsx:66's `calc(var(--safe-top) + 28px)`. The PWA needs the +28 twice
 * over: its status bar is `black-translucent` so content sits under it, and
 * env()'s 44px fallback undershoots the ~59px Dynamic Island. Natively
 * useSafeAreaInsets() reports the real inset, so only the 28px of deliberate
 * breathing room above the first card survives.
 */
export const SCREEN_TOP_PAD = 28;
/** App.tsx:67's `calc(var(--safe-bottom) + 92px)` — clearance for the tab bar. */
export const SCREEN_TAB_BAR_CLEARANCE = 92;
/** What replaces it on a pushed route, where the tab bar is hidden. */
export const SCREEN_BOTTOM_PAD = 16;

export interface ScreenProps {
  children: ReactNode;
  /**
   * Page furniture that stays put while `children` scroll under it — the Home
   * wordmark row, a BackLink + PageTitle pair. Rendered as a SIBLING above the
   * ScrollView, which is the whole mechanism.
   *
   * OWNER-REQUESTED DEVIATION FROM PWA PARITY (the user, 2026-09-11): sticky
   * headers. In the PWA every header scrolls away with the document. Do not
   * move these back inside the scroll in a parity sweep.
   */
  header?: ReactNode;
  /** `false` for screens that own their own scrolling (the terminal). Default `true`. */
  scroll?: boolean;
  /** `false` drops the 18px content gutter for a full-bleed screen. Default `true`. */
  gutter?: boolean;
  /** Extra styles on the content column. */
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Indices of DIRECT children that should stick to the top as they reach it.
   * Only meaningful when those children are direct children of the ScrollView,
   * so a screen using this flattens its sections into one child array rather
   * than wrapping each in a View (the brief's bucket heads).
   */
  stickyHeaderIndices?: number[];
  /** Fires as a drag starts — the brief disarms every armed row on it. */
  onScrollBeginDrag?: ScrollViewProps['onScrollBeginDrag'];
  /**
   * Pull-to-refresh (H5): omit `onRefresh` and nothing changes for a caller
   * that doesn't ask for it — RN's `RefreshControl` is only attached when the
   * prop is supplied. `refreshing` should track the same query's
   * `isFetching`; `onRefresh` its `refetch`.
   */
  refreshing?: boolean;
  onRefresh?: () => void;
  scrollRef?: Ref<ScrollView>;
  testID?: string;
}

export function Screen({
  children,
  header,
  scroll = true,
  gutter = true,
  contentStyle,
  stickyHeaderIndices,
  onScrollBeginDrag,
  refreshing,
  onRefresh,
  scrollRef,
  testID,
}: ScreenProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarHidden = useTabBarHidden();
  const focused = useIsFocused();

  // Tapping the selected tab again scrolls this screen back to the top — the
  // iOS convention, and the reason Screen has to own a ref even when the caller
  // does not ask for one. The hook fires only when the screen is ALREADY
  // focused and is its stack's first route, so the first tap still just
  // switches tab (or pops the push) and only the next one scrolls.
  const innerScrollRef = useRef<ScrollView>(null);
  useScrollToTop(innerScrollRef);
  // A caller's scrollRef must keep working, so feed both from one callback ref.
  const setScrollRef = useCallback(
    (node: ScrollView | null) => {
      innerScrollRef.current = node;
      if (typeof scrollRef === 'function') scrollRef(node);
      else if (scrollRef) (scrollRef as { current: ScrollView | null }).current = node;
    },
    [scrollRef],
  );
  // Scoped to THIS screen: a pushed route hides the bar for itself, and the
  // tab root sitting under it is blurred and must keep its full clearance for
  // when the push pops and the bar comes back. (Both hooks run unconditionally
  // — `tabBarHidden && useIsFocused()` would short-circuit the hook away.)
  const barGoneHere = tabBarHidden && focused;

  // `body { background: var(--bg-0) }` (globals.css:22) — the ground the wash
  // is painted on, now full-bleed and viewport-pinned rather than confined to
  // the 440 column (Ground wraps the whole screen).
  const page: ViewStyle = { flex: 1, backgroundColor: t('bg-0') };
  /** The clearance above the first thing on the page, header or not. */
  const topPad = insets.top + SCREEN_TOP_PAD;
  // `<main>` (App.tsx:58-71): the 440-wide centred column, `min-height: 100dvh`
  // and growing with content. flexGrow is RN's `min-height: 100%`. Transparent
  // — the wash is behind it now, on <Ground />.
  const column: ViewStyle = {
    flexGrow: 1,
    width: '100%',
    maxWidth: SCREEN_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: gutter ? SCREEN_GUTTER : 0,
    // The header takes the top clearance when there is one; its own
    // paddingBottom then supplies the gap down to the first card, exactly as
    // it did when it was the column's first child.
    paddingTop: header ? 0 : topPad,
    paddingBottom:
      insets.bottom + (barGoneHere ? SCREEN_BOTTOM_PAD : SCREEN_TAB_BAR_CLEARANCE),
  };
  const headerBar: ViewStyle = {
    width: '100%',
    maxWidth: SCREEN_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: gutter ? SCREEN_GUTTER : 0,
    paddingTop: topPad,
  };

  const body = scroll ? (
    <ScrollView
      ref={setScrollRef}
      testID={testID}
      style={styles.scroll}
      contentContainerStyle={[column, contentStyle]}
      // The insets above are the PWA's own formula; letting iOS also adjust
      // for the (floating, self-minimizing) tab bar would double-count them.
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      stickyHeaderIndices={stickyHeaderIndices}
      onScrollBeginDrag={onScrollBeginDrag}
      refreshControl={
        onRefresh ? (
          <RNRefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t('fg-3')} />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[column, contentStyle]} testID={testID}>
      {children}
    </View>
  );

  // Ground first so it sits under both; the header is transparent, so the
  // wash reads through it rather than being clipped by it.
  return (
    <View style={page} collapsable={false}>
      <Ground />
      {header ? <View style={headerBar}>{header}</View> : null}
      {body}
    </View>
  );
}

const styles = StyleSheet.create({ scroll: { flex: 1 } });
