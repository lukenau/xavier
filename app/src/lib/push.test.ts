// Where a notification tap lands — while the app runs, and when the tap is
// what launched it (the cold start that opened on Home, 2026-09-30).
import { onNotificationTap } from './push';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock('./api', () => ({ api: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({}));

let mockLast: unknown = null;
let mockListener: ((r: unknown) => void) | null = null;
const mockClear = jest.fn(() => {
  mockLast = null;
});
jest.mock('expo-notifications', () => ({
  getLastNotificationResponse: () => mockLast,
  clearLastNotificationResponse: () => mockClear(),
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => {
    mockListener = fn;
    return { remove: jest.fn() };
  },
}));

const tap = (url: unknown) => ({ notification: { request: { content: { data: { url } } } } });

beforeEach(() => {
  mockPush.mockClear();
  mockClear.mockClear();
  mockLast = null;
  mockListener = null;
});

test('a tap that launched the app opens its route, once', () => {
  mockLast = tap('/automations/run?runId=c0ffee000001:2026-09-29_21-00-50');
  onNotificationTap();
  expect(mockPush).toHaveBeenCalledWith('/automations/run?runId=c0ffee000001:2026-09-29_21-00-50');
  expect(mockClear).toHaveBeenCalledTimes(1);
  // The next launch does not route again.
  onNotificationTap();
  expect(mockPush).toHaveBeenCalledTimes(1);
});

test('a tap while the app is running opens its route', () => {
  onNotificationTap();
  expect(mockPush).not.toHaveBeenCalled();
  mockListener?.(tap('/chat/thread?threadId=thr_1'));
  expect(mockPush).toHaveBeenCalledWith('/chat/thread?threadId=thr_1');
});

test('a native build without the launch read still listens for taps', () => {
  const Notifications = jest.requireMock('expo-notifications');
  const original = Notifications.getLastNotificationResponse;
  Notifications.getLastNotificationResponse = () => {
    throw new Error('UnavailabilityError');
  };
  expect(() => onNotificationTap()).not.toThrow();
  mockListener?.(tap('/brief'));
  expect(mockPush).toHaveBeenCalledWith('/brief');
  Notifications.getLastNotificationResponse = original;
});

test('anything that is not an in-app path goes nowhere', () => {
  mockLast = tap('https://example.com');
  onNotificationTap();
  mockListener?.(tap(undefined));
  expect(mockPush).not.toHaveBeenCalled();
});
