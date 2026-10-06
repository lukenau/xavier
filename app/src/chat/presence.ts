// Telling hub-api whether the user is looking, so a reply that lands while he is
// away earns a notification and one that lands in front of him does not
// ("it should only do it when i leave the app", 2026-09-22).
//
// The app is the only thing that knows. The WebSocket does not: iOS holds a
// suspended socket open for a while after the app leaves, which is exactly the
// window the notification matters in. The server expires an `active` report on
// its own, so an app the OS kills outright stops counting as present.
import { AppState, type AppStateStatus } from 'react-native';
import { api } from '../lib/api';

function report(status: AppStateStatus) {
  // `inactive` is the half-second of a swipe or the app switcher, not leaving.
  if (status === 'inactive') return;
  void api.chatPresence(status === 'active' ? 'active' : 'background').catch(() => {});
}

/** Call once, from the root layout. Returns the detach. */
export function watchPresence(): () => void {
  report(AppState.currentState);
  const sub = AppState.addEventListener('change', report);
  return () => sub.remove();
}
