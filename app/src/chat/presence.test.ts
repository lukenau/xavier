// What the server is told, and when. The rule it serves: notify only when the user
// has left the app (2026-09-22).
import { AppState } from 'react-native';
import { watchPresence } from './presence';

jest.mock('../lib/api', () => ({ api: { chatPresence: jest.fn().mockResolvedValue({ in_app: true }) } }));
// eslint-disable-next-line import/first
import { api } from '../lib/api';

const chatPresence = api.chatPresence as jest.Mock;

function change(status: string) {
  const handler = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)?.[1];
  handler(status);
}

describe('presence', () => {
  let remove: jest.Mock;

  beforeEach(() => {
    chatPresence.mockClear();
    remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove } as never);
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  });

  it('reports where the app already is, without waiting for a change', () => {
    watchPresence();
    expect(chatPresence).toHaveBeenCalledWith('active');
  });

  it('reports leaving and coming back', () => {
    watchPresence();
    chatPresence.mockClear();
    change('background');
    expect(chatPresence).toHaveBeenCalledWith('background');
    change('active');
    expect(chatPresence).toHaveBeenLastCalledWith('active');
  });

  it('ignores `inactive` — the app switcher is not leaving', () => {
    watchPresence();
    chatPresence.mockClear();
    change('inactive');
    expect(chatPresence).not.toHaveBeenCalled();
  });

  it('detaches', () => {
    watchPresence()();
    expect(remove).toHaveBeenCalled();
  });

  it('never lets a failed report throw into the render tree', () => {
    chatPresence.mockRejectedValueOnce(new Error('offline'));
    expect(() => watchPresence()).not.toThrow();
  });
});
