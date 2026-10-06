// Registering this phone for the brief's notifications.
//
// Registration is a Face-ID-gated write (api.registerPushDevice → the
// device-key gate), so it runs only when it can change something: the first
// time, or when Expo hands this phone a different token. Until 2026-09-30 it
// ran on every open of the brief, which put "Authorize this change" in front of
// a read-only screen every morning (F1). A new token is seen on the very next
// open: getExpoPushTokenAsync is asked every time, and asking needs no Face ID.
// There is deliberately no age-based re-register (the user: no Face ID friction).
//
// WHEN to ask for the permission matters more than any of this code. iOS gives
// exactly one chance: a denial is permanent until the user finds the setting
// themselves. So nothing here fires on launch — `registerForBrief` is called
// from the brief screen, when the thing being offered is on screen in front of
// him. Declining is remembered locally and never asked again.
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { api } from './api';

/** Set once he declines, so the ask happens at most once per install. */
const DECLINED_KEY = 'brief.push.declined';
/** `{"token": …, "at": <epoch ms>}` — the token hub-api last accepted from
 * this phone. Kept in the app's own sandbox, on the device it addresses. */
export const REGISTERED_KEY = 'brief.push.registered';
/** Epoch ms before which a failed registration is not retried. */
export const RETRY_AFTER_KEY = 'brief.push.retryAfter';

/** A failed gated attempt (Face ID cancelled, offline, not paired) waits a
 * day, so a cancel is not answered by the same prompt on the next open. That
 * includes a failed `/push/challenge` POST, which fails before any Face ID is
 * shown (offline, hub-api down): intentional — one retry a day is enough for a
 * notification the brief works without. */
export const RETRY_AFTER_HOURS = 24;

const HOUR_MS = 3_600_000;

export type PushOutcome =
  | 'registered'
  | 'unchanged'
  | 'backing-off'
  | 'denied'
  | 'already-declined'
  | 'unconfigured'
  | 'failed';

/** The EAS project an Expo push token is scoped to, read from the same two
 * places expo-notifications reads it. A build made without EAS_PROJECT_ID (a
 * fork that never ran `eas init`) has neither, and so has no token to ask for. */
export function pushProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = Constants.easConfig?.projectId ?? extra?.eas?.projectId;
  return typeof id === 'string' && id.trim() ? id : null;
}

let warnedUnconfigured = false;

async function lastRegistered(): Promise<{ token: string; at: number } | null> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(REGISTERED_KEY)) ?? 'null');
    return typeof parsed?.token === 'string' && typeof parsed?.at === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export async function registerForBrief(now: number = Date.now()): Promise<PushOutcome> {
  try {
    if (await AsyncStorage.getItem(DECLINED_KEY)) return 'already-declined';

    // Before the permission ask, not after it: iOS asks once, and a build that
    // can never get a token must not spend that one ask on nothing.
    const projectId = pushProjectId();
    if (!projectId) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn('push: no EAS project id in this build (EAS_PROJECT_ID), so the brief skips notifications.');
      }
      return 'unconfigured';
    }

    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted
      ? true
      : (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) {
      await AsyncStorage.setItem(DECLINED_KEY, '1');
      return 'denied';
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if ((await lastRegistered())?.token === token) return 'unchanged';
    if (Number(await AsyncStorage.getItem(RETRY_AFTER_KEY)) > now) return 'backing-off';

    try {
      await api.registerPushDevice(token, 'iPhone');
    } catch {
      // The gated step: Face ID was, or would have been, on screen. Not worth
      // a message — the brief works without push — but worth a day's pause.
      await AsyncStorage.setItem(RETRY_AFTER_KEY, String(now + RETRY_AFTER_HOURS * HOUR_MS));
      return 'failed';
    }
    await AsyncStorage.setItem(REGISTERED_KEY, JSON.stringify({ token, at: now }));
    await AsyncStorage.removeItem(RETRY_AFTER_KEY);
    return 'registered';
  } catch {
    // Nothing gated ran (permissions, the Expo token, storage): the brief
    // still works, and the next open tries again. Only a DENIAL is remembered.
    return 'failed';
  }
}

function openTapped(response: Notifications.NotificationResponse): void {
  const url = response.notification.request.content.data?.url;
  if (typeof url === 'string' && url.startsWith('/')) router.push(url);
  // Read once: left in place, the same tap would route again on the next launch.
  Notifications.clearLastNotificationResponse();
}

/** A tap on any notification this app sends — the morning brief, a reply that
 * landed while the user was away, an automation's run. The payload carries the
 * route rather than a hardcoded one, so the notification and the app agree on
 * where it goes even if a route moves.
 *
 * Two paths, because a tap reaches the app two ways. With the app running or
 * backgrounded, the listener hears it. With the app closed, the tap is what
 * launched it, and that happened before any listener existed: it opened on
 * Home (the user, 2026-09-30). That one is read back once at startup. */
export function onNotificationTap() {
  // Throws UnavailabilityError where the native module lacks it; this runs in
  // the root layout, so a throw here would take the whole app down with it.
  let launchedBy: Notifications.NotificationResponse | null = null;
  try {
    launchedBy = Notifications.getLastNotificationResponse();
  } catch {
    launchedBy = null;
  }
  if (launchedBy) openTapped(launchedBy);
  return Notifications.addNotificationResponseReceivedListener(openTapped);
}
