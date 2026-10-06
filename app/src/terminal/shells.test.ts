import { ApplyError, GateNotWiredError, GATE_NOT_WIRED_MESSAGE } from '../lib/api';
import type { TmuxPastSession, TmuxSession } from '../lib/types';
import {
  attachSnippet,
  pastSessionMeta,
  shellMeta,
  unreachableHostLine,
  writeErrorMessage,
} from './shells';

const NOW = Date.parse('2026-09-11T12:00:00Z');

const session = (over: Partial<TmuxSession> = {}): TmuxSession => ({
  name: 'claude-2',
  created: NOW / 1000 - 3600,
  attached: false,
  windows: 3,
  protected: false,
  host: 'vps',
  title: null,
  session_id: null,
  ...over,
});

const past = (over: Partial<TmuxPastSession> = {}): TmuxPastSession => ({
  host: 'vps',
  session_id: 'aaaabbbb-1111-4111-8111-111111111111',
  title: null,
  cwd: null,
  last_active: NOW / 1000 - 600,
  live: false,
  ...over,
});

const label = (id: string) => (id === 'vps' ? 'VPS' : 'MacBook');

describe('shellMeta', () => {
  test('names the session only when a title took its place', () => {
    expect(shellMeta(session(), false, label, NOW)).toBe('detached · 3w · 1h ago');
    expect(shellMeta(session({ title: 'Porting' }), false, label, NOW)).toBe(
      'claude-2 · detached · 3w · 1h ago',
    );
  });

  test('names the host only when there is more than one', () => {
    expect(shellMeta(session({ host: 'mac' }), true, label, NOW)).toBe(
      'MacBook · detached · 3w · 1h ago',
    );
  });

  test('says attached and protected when it is', () => {
    expect(shellMeta(session({ attached: true, protected: true }), false, label, NOW)).toBe(
      'attached · 3w · 1h ago · protected',
    );
  });
});

describe('pastSessionMeta', () => {
  test('is the age, then the cwd and the running flag when present', () => {
    expect(pastSessionMeta(past(), NOW)).toBe('10m ago');
    expect(pastSessionMeta(past({ cwd: '/home/user/projects' }), NOW)).toBe('10m ago · /home/user/projects');
    expect(pastSessionMeta(past({ cwd: '/home/user/projects', live: true }), NOW)).toBe(
      '10m ago · /home/user/projects · running',
    );
  });
});

test('an unreachable host reads as a question, not a failure', () => {
  expect(unreachableHostLine('MacBook', 'ssh timed out')).toBe(
    'MacBook unreachable — ssh timed out. Asleep?',
  );
  expect(unreachableHostLine('MacBook', null)).toBe('MacBook unreachable — no response. Asleep?');
});

test('the attach snippet falls back to the local switch-client form', () => {
  expect(attachSnippet('tmux new-window -n mac', 'claude-2')).toBe('tmux new-window -n mac');
  expect(attachSnippet(undefined, 'claude-2')).toBe('tmux switch-client -t claude-2');
});

describe('writeErrorMessage', () => {
  test('is silent for a cancelled prompt and loud for everything else', () => {
    expect(writeErrorMessage(new ApplyError('cancelled', 'User cancelled.'))).toBeNull();
    expect(writeErrorMessage(new ApplyError('bad_request', '{name} is protected'))).toBe(
      '{name} is protected',
    );
    expect(writeErrorMessage(new GateNotWiredError())).toBe(GATE_NOT_WIRED_MESSAGE);
    expect(writeErrorMessage(new GateNotWiredError('cancelled'))).toBeNull();
  });

  test('a non-Error throw still says something', () => {
    expect(writeErrorMessage('nope')).toBe('Write failed.');
    expect(writeErrorMessage(new Error('network down'))).toBe('network down');
  });
});
