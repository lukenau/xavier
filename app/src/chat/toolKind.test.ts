import { toolKindOf } from './toolKind';

describe('toolKindOf — the glyph that saves opening the card', () => {
  it('reads the estate’s real tool names', () => {
    expect(toolKindOf('read_file').kind).toBe('read');
    expect(toolKindOf('search_files').kind).toBe('read');
    expect(toolKindOf('browser_task').kind).toBe('fetch');
    expect(toolKindOf('delegate_task').kind).toBe('delegate');
    expect(toolKindOf('run_command').kind).toBe('command');
  });

  it('calls a write a write, not a read of a file', () => {
    expect(toolKindOf('write_file').kind).toBe('write');
    expect(toolKindOf('edit_file').kind).toBe('write');
    expect(toolKindOf('create_note').kind).toBe('write');
  });

  it('separates sending from reading', () => {
    expect(toolKindOf('send_message').kind).toBe('message');
    expect(toolKindOf('imessage_send').kind).toBe('message');
  });

  it('recognises the memory tools', () => {
    expect(toolKindOf('supermemory_search').kind).toBe('memory');
    expect(toolKindOf('add_memory').kind).toBe('memory');
  });

  it('falls back rather than guessing', () => {
    expect(toolKindOf('quux').kind).toBe('other');
    expect(toolKindOf('').kind).toBe('other');
    expect(toolKindOf(null).kind).toBe('other');
    expect(toolKindOf(undefined).kind).toBe('other');
  });

  it('gives every kind a single-character glyph, never an emoji', () => {
    const names = ['read_file', 'write_file', 'bash', 'browser_task', 'add_memory', 'delegate_task', 'send_message', 'quux'];
    for (const n of names) {
      const { glyph } = toolKindOf(n);
      expect([...glyph]).toHaveLength(1);
      expect(glyph).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
