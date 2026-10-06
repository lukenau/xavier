import { rowState } from './CommandSheet';
import type { CommandCatalogEntry } from '../../chat/commands';

function entry(busy_policy: CommandCatalogEntry['busy_policy']): CommandCatalogEntry {
  return { name: '/x', aliases: [], category: 'builtin', description: '', arg_hint: null, busy_policy };
}

describe('rowState', () => {
  it('every policy is enabled when nothing is running', () => {
    expect(rowState(entry('reject'), false)).toBe('enabled');
    expect(rowState(entry('dispatch'), false)).toBe('enabled');
    expect(rowState(entry('interrupt_then_dispatch'), false)).toBe('enabled');
  });

  it('reject is disabled while a turn is running', () => {
    expect(rowState(entry('reject'), true)).toBe('disabled');
  });

  it('dispatch stays enabled while a turn is running', () => {
    expect(rowState(entry('dispatch'), true)).toBe('enabled');
  });

  it('interrupt_then_dispatch is enabled-behind-a-confirm while running', () => {
    expect(rowState(entry('interrupt_then_dispatch'), true)).toBe('confirm');
  });
});
