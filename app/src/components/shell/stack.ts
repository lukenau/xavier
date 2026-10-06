// Shared <Stack screenOptions> for the five tab stacks.
//
// headerShown: false everywhere — the PWA carries its own header idiom
// (PageTitle, the Home header, per-page "‹ Ops" back links) and those port as
// content, so a native header would double up. Large titles are off for the
// same reason. The iOS edge swipe still pops, and a screen that wants a native
// header can set `headerShown` in its own Stack.Screen options.
export const STACK_SCREEN_OPTIONS = {
  headerShown: false,
} as const;
