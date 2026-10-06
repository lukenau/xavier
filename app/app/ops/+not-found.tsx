import { Redirect } from 'expo-router';

// SHELL-02: the PWA's catch-all renders Home for an unknown hash without
// rewriting the URL. Here it also keeps an in-app `router.push` to a bad href
// off the auto-generated root `+not-found`, which is a NativeTabs child with
// no trigger and throws in dev (NativeBottomTabsNavigator.js:103-107).
// Deep links never reach either — `resolveDeepLink` maps anything outside
// KNOWN_ROUTES to `/` before the router sees it.
export default function NotFound() {
  return <Redirect href="/" />;
}
