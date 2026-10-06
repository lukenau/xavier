// F1 (2026-09-30): opening the brief raised Face ID every time, because
// registerForBrief re-registered the push token through the device-key gate on
// every mount of BriefScreen. These tests pin the fix at the only seam that
// matters: how often api.registerPushDevice — the call that raises Face ID —
// is reached.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('./api', () => ({ api: { registerPushDevice: jest.fn() } }));
// Where a build carries its EAS project id. Mutable per test; defined inside
// the factory because jest hoists the mock above every import.
jest.mock('expo-constants', () => {
  const state: { easConfig: { projectId?: string } | null; expoConfig: { extra?: unknown } | null } = {
    easConfig: null,
    expoConfig: null,
  };
  return {
    __esModule: true,
    state,
    default: {
      get easConfig() {
        return state.easConfig;
      },
      get expoConfig() {
        return state.expoConfig;
      },
    },
  };
});

import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import { REGISTERED_KEY, RETRY_AFTER_HOURS, RETRY_AFTER_KEY, pushProjectId, registerForBrief } from './push';

const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const NEW_TOKEN = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const T0 = Date.parse('2026-09-30T11:30:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROJECT = '00000000-0000-0000-0000-000000000000';

const register = api.registerPushDevice as jest.Mock;
const getToken = Notifications.getExpoPushTokenAsync as jest.Mock;
const getPermissions = Notifications.getPermissionsAsync as jest.Mock;
const requestPermissions = Notifications.requestPermissionsAsync as jest.Mock;
const constants = (jest.requireMock('expo-constants') as {
  state: { easConfig: { projectId?: string } | null; expoConfig: { extra?: unknown } | null };
}).state;

async function stored(): Promise<{ token: string; at: number }> {
  return JSON.parse((await AsyncStorage.getItem(REGISTERED_KEY)) ?? 'null');
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  constants.easConfig = { projectId: PROJECT };
  constants.expoConfig = { extra: { router: {}, eas: { projectId: PROJECT } } };
  getPermissions.mockResolvedValue({ granted: true });
  requestPermissions.mockResolvedValue({ granted: true });
  getToken.mockResolvedValue({ type: 'expo', data: TOKEN });
  register.mockResolvedValue({ status: 'registered', devices: 1 });
});

describe('F1: opening the brief does not raise Face ID every time', () => {
  test('the first open registers, and remembers what it registered', async () => {
    await expect(registerForBrief(T0)).resolves.toBe('registered');
    expect(getToken).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(TOKEN, 'iPhone');
    expect(await stored()).toEqual({ token: TOKEN, at: T0 });
  });

  test('ten more opens the same day reach the gate zero more times', async () => {
    await registerForBrief(T0);
    for (let i = 1; i <= 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(registerForBrief(T0 + i * HOUR)).resolves.toBe('unchanged');
    }
    expect(register).toHaveBeenCalledTimes(1);
  });

  test('the same token is never re-registered, however old the record', async () => {
    await registerForBrief(T0);
    await expect(registerForBrief(T0 + 400 * DAY)).resolves.toBe('unchanged');
    expect(register).toHaveBeenCalledTimes(1);
  });

  test('a token Expo has replaced is registered on the next open', async () => {
    await registerForBrief(T0);
    getToken.mockResolvedValue({ type: 'expo', data: NEW_TOKEN });
    await expect(registerForBrief(T0 + HOUR)).resolves.toBe('registered');
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith(NEW_TOKEN, 'iPhone');
    expect((await stored()).token).toBe(NEW_TOKEN);
  });

  test('a cancelled Face ID waits a day instead of asking again on the next open', async () => {
    register.mockRejectedValueOnce(Object.assign(new Error('Face ID cancelled.'), { code: 'cancelled' }));
    await expect(registerForBrief(T0)).resolves.toBe('failed');
    expect(Number(await AsyncStorage.getItem(RETRY_AFTER_KEY))).toBe(T0 + RETRY_AFTER_HOURS * HOUR);

    await expect(registerForBrief(T0 + HOUR)).resolves.toBe('backing-off');
    expect(register).toHaveBeenCalledTimes(1);

    await expect(registerForBrief(T0 + RETRY_AFTER_HOURS * HOUR)).resolves.toBe('registered');
    expect(register).toHaveBeenCalledTimes(2);
    expect(await AsyncStorage.getItem(RETRY_AFTER_KEY)).toBeNull();
  });

  test('a failure before the gate (no Expo token) is retried on the very next open', async () => {
    getToken.mockRejectedValueOnce(new Error('offline'));
    await expect(registerForBrief(T0)).resolves.toBe('failed');
    expect(register).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(RETRY_AFTER_KEY)).toBeNull();
    await expect(registerForBrief(T0 + 60_000)).resolves.toBe('registered');
  });

  test('a record the phone cannot read is treated as never registered', async () => {
    await AsyncStorage.setItem(REGISTERED_KEY, '{not json');
    await expect(registerForBrief(T0)).resolves.toBe('registered');
    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe('the permission ask is unchanged', () => {
  test('a denial is remembered, never asked again, and never reaches the gate', async () => {
    getPermissions.mockResolvedValue({ granted: false });
    requestPermissions.mockResolvedValue({ granted: false });
    await expect(registerForBrief(T0)).resolves.toBe('denied');
    await expect(registerForBrief(T0 + HOUR)).resolves.toBe('already-declined');
    expect(requestPermissions).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });
});

// A fork built without EAS_PROJECT_ID has no project id at all: app.json ships
// none, and app.config.js only adds one from the environment.
describe('a build with no EAS project id', () => {
  test('skips registration quietly: no ask, no token, no gate, no throw — and says why once', async () => {
    constants.easConfig = null;
    constants.expoConfig = { extra: { router: {} } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(registerForBrief(T0)).resolves.toBe('unconfigured');
      await expect(registerForBrief(T0 + HOUR)).resolves.toBe('unconfigured');
      // The one permission ask iOS allows is not spent on a token that cannot exist.
      expect(getPermissions).not.toHaveBeenCalled();
      expect(requestPermissions).not.toHaveBeenCalled();
      expect(getToken).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      // Not a denial: a later build that carries an id still gets to ask.
      expect(await AsyncStorage.getItem('brief.push.declined')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('EAS_PROJECT_ID');
    } finally {
      warn.mockRestore();
    }
  });

  test('a blank id counts as none', () => {
    constants.easConfig = { projectId: '  ' };
    constants.expoConfig = null;
    expect(pushProjectId()).toBeNull();
  });

  test('the id comes from the update manifest first, then from the build config', async () => {
    constants.easConfig = null;
    constants.expoConfig = { extra: { eas: { projectId: 'from-build-config' } } };
    expect(pushProjectId()).toBe('from-build-config');
    constants.easConfig = { projectId: 'from-update' };
    expect(pushProjectId()).toBe('from-update');
    await registerForBrief(T0);
    expect(getToken).toHaveBeenCalledWith({ projectId: 'from-update' });
  });

  test('a token request that rejects anyway is a quiet failure, not an unhandled rejection', async () => {
    getToken.mockRejectedValueOnce(
      Object.assign(new Error('No "projectId" found.'), { code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID' }),
    );
    await expect(registerForBrief(T0)).resolves.toBe('failed');
    expect(register).not.toHaveBeenCalled();
  });
});
