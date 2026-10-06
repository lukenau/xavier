import { resolveDeepLink } from '../src/lib/deepLinks';

/** `hub://…` and any other system path, mapped onto the native route tree. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return resolveDeepLink(path);
  } catch {
    // "throwing errors within this method may result in app crashes" — expo-router.
    return '/';
  }
}
