import type { Vitals } from '../../lib/types';
import { agentStatus } from './agentStatus';

function vitals(agent: Partial<Vitals['agent']> = {}): Vitals {
  return {
    agent: {
      id: 'hermes',
      name: 'Xavier',
      status: 'up',
      model: 'claude-opus-4-6',
      gateway_state: 'running',
      discord_state: 'connected',
      busy: false,
      ...agent,
    },
  } as Vitals;
}

test('an idle, reachable agent on a healthy socket says only what the agent is doing', () => {
  expect(agentStatus(vitals(), 'connected')).toEqual({ label: 'Xavier is idle', tone: 'fg-4' });
});

test('a busy agent reads as working, and the dot goes live', () => {
  expect(agentStatus(vitals({ busy: true }), 'connected')).toEqual({
    label: 'Xavier is working',
    tone: 'status-up',
  });
});

test('a down gateway outranks a healthy socket — hub-api being reachable says nothing about Xavier', () => {
  expect(agentStatus(vitals({ status: 'down', busy: true }), 'connected')).toEqual({
    label: 'Xavier is unreachable',
    tone: 'status-down',
  });
});

test('no vitals yet says so rather than guessing at idle, and names the connection as the chat', () => {
  expect(agentStatus(undefined, 'connecting')).toEqual({
    label: "Xavier's status is unknown · connecting to chat…",
    tone: 'fg-4',
  });
});

test('a dropped socket is warned about even while the agent is up', () => {
  expect(agentStatus(vitals(), 'closed')).toEqual({
    label: 'Xavier is idle · chat offline, not updating',
    tone: 'status-warn',
  });
  expect(agentStatus(vitals(), 'error').label).toBe('Xavier is idle · chat offline, not updating');
});

test('the agent is named by vitals, not by this file', () => {
  expect(agentStatus(vitals({ name: 'Hermes' }), 'connected').label).toBe('Hermes is idle');
});
