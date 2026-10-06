import {
  detectSlashContext,
  filterCommands,
  findUnknownLeadingCommand,
  insertCommandToken,
  leadingCommandToken,
  type CommandCatalogEntry,
} from './commands';

function entry(overrides: Partial<CommandCatalogEntry>): CommandCatalogEntry {
  return {
    name: '/x',
    aliases: [],
    category: 'builtin',
    description: '',
    arg_hint: null,
    busy_policy: 'reject',
    ...overrides,
  };
}

const BRAINSTORMING = entry({ name: '/brainstorming', category: 'skill', description: 'Spawn a thinking team' });
const BUILD_WITH_EXA = entry({ name: '/build-with-exa', category: 'skill' });
const NEW = entry({ name: '/new', aliases: ['/reset'], category: 'builtin', busy_policy: 'interrupt_then_dispatch' });
const BRANCH = entry({ name: '/branch', aliases: ['/fork'], category: 'builtin' });
const DISK_CLEANUP = entry({ name: '/disk-cleanup', category: 'plugin' });
const SP_BRAINSTORMING = entry({ name: '/sp-brainstorming', category: 'alias' });

const CATALOG = [NEW, BRANCH, BRAINSTORMING, BUILD_WITH_EXA, DISK_CLEANUP, SP_BRAINSTORMING];

describe('filterCommands', () => {
  it('matches a bare query against every entry, unfiltered', () => {
    expect(filterCommands(CATALOG, '')).toHaveLength(CATALOG.length);
  });

  it('prefix-matches on name, case-insensitively, slash-insensitively', () => {
    expect(filterCommands(CATALOG, 'bra').map((c) => c.name)).toEqual(['/brainstorming', '/branch']);
    expect(filterCommands(CATALOG, 'BRA').map((c) => c.name)).toEqual(['/brainstorming', '/branch']);
    expect(filterCommands(CATALOG, '/bra').map((c) => c.name)).toEqual(['/brainstorming', '/branch']);
  });

  it('matches on aliases too, skills and builtins together in one list', () => {
    expect(filterCommands(CATALOG, 'reset').map((c) => c.name)).toEqual(['/new']);
    expect(filterCommands(CATALOG, 'fork').map((c) => c.name)).toEqual(['/branch']);
  });

  it('does not match a mid-string substring, only a prefix', () => {
    expect(filterCommands(CATALOG, 'storming')).toEqual([]);
  });

  it('ranks skill matches ahead of builtin/plugin/alias matches, stably otherwise', () => {
    // 'b' matches /branch (builtin) and /brainstorming (skill) and
    // /build-with-exa (skill) — catalog order within a rank is preserved.
    expect(filterCommands(CATALOG, 'b').map((c) => c.name)).toEqual([
      '/brainstorming',
      '/build-with-exa',
      '/branch',
    ]);
  });

  it('keeps non-skill categories in catalog order among themselves', () => {
    const catalog = [DISK_CLEANUP, SP_BRAINSTORMING, BRANCH];
    expect(filterCommands(catalog, '').map((c) => c.name)).toEqual([
      '/disk-cleanup',
      '/sp-brainstorming',
      '/branch',
    ]);
  });
});

describe('detectSlashContext', () => {
  it('finds a token at the very start of the message', () => {
    expect(detectSlashContext('/bra', 4)).toEqual({ start: 0, query: 'bra' });
  });

  it('finds a token mid-sentence — the user\'s corrected spec, not message-start-only', () => {
    const text = 'archive or delete /brainstorming whether';
    const start = text.indexOf('/brainstorming');
    const cursor = start + '/brainstorming'.length;
    expect(detectSlashContext(text, cursor)).toEqual({ start, query: 'brainstorming' });
  });

  it('opens on a bare trailing slash with no query yet', () => {
    const text = 'look at the backup retention thing and /';
    expect(detectSlashContext(text, text.length)).toEqual({ start: text.length - 1, query: '' });
  });

  it('returns null once whitespace separates the slash from the cursor', () => {
    const text = '/brainstorming now';
    expect(detectSlashContext(text, text.length)).toBeNull();
  });

  it('never fires for a slash mid-word, e.g. a file path', () => {
    const text = 'check src/lib/api.ts please';
    const cursor = text.indexOf('api.ts');
    expect(detectSlashContext(text, cursor)).toBeNull();
  });

  it('returns null with no slash on the current word at all', () => {
    expect(detectSlashContext('hello world', 5)).toBeNull();
  });

  it('finds the nearest preceding slash token, not an earlier one', () => {
    const text = '/one two /br';
    const start = text.lastIndexOf('/br');
    expect(detectSlashContext(text, text.length)).toEqual({ start, query: 'br' });
  });
});

describe('insertCommandToken', () => {
  it('skill: inserts in place, keeping the prose before AND after', () => {
    const text = 'look at the backup retention thing and /';
    const start = text.length - 1;
    const result = insertCommandToken(text, start, text.length, BRAINSTORMING);
    expect(result).toEqual({
      text: 'look at the backup retention thing and /brainstorming ',
      cursor: 'look at the backup retention thing and /brainstorming '.length,
      placement: 'inline',
    });
  });

  it('skill: keeps trailing prose typed after the token', () => {
    const text = 'archive or delete /br whether to keep it';
    const slashStart = text.indexOf('/br');
    const cursor = slashStart + '/br'.length;
    const result = insertCommandToken(text, slashStart, cursor, BRAINSTORMING);
    expect(result.text).toBe('archive or delete /brainstorming whether to keep it');
    expect(result.placement).toBe('inline');
  });

  it('builtin: relocates to message start when picked mid-sentence', () => {
    const text = 'fix the bug /res';
    const slashStart = text.indexOf('/res');
    const result = insertCommandToken(text, slashStart, text.length, NEW);
    expect(result).toEqual({ text: '/new fix the bug ', cursor: '/new '.length, placement: 'message-start' });
  });

  it('builtin: stays at start (a no-op relocation) when already typed at position 0', () => {
    const text = '/new';
    const result = insertCommandToken(text, 0, text.length, NEW);
    expect(result).toEqual({ text: '/new ', cursor: '/new '.length, placement: 'message-start' });
  });

  it('plugin/alias categories also relocate to message start, same as builtin', () => {
    const text = 'clean this up /disk';
    const slashStart = text.indexOf('/disk');
    const result = insertCommandToken(text, slashStart, text.length, DISK_CLEANUP);
    expect(result).toEqual({ text: '/disk-cleanup clean this up ', cursor: '/disk-cleanup '.length, placement: 'message-start' });
  });
});

describe('leadingCommandToken', () => {
  it('reads the token right after a leading slash', () => {
    expect(leadingCommandToken('/new session please')).toBe('/new');
  });

  it('is null with no leading slash', () => {
    expect(leadingCommandToken('hello /new')).toBeNull();
  });

  it('tolerates transient leading whitespace', () => {
    expect(leadingCommandToken('  /new')).toBe('/new');
  });
});

describe('findUnknownLeadingCommand', () => {
  it('blocks a leading token absent from the catalog', () => {
    expect(findUnknownLeadingCommand('/nope do something', CATALOG)).toBe('/nope');
  });

  it('allows a leading token that matches a catalog name', () => {
    expect(findUnknownLeadingCommand('/new session', CATALOG)).toBeNull();
  });

  it('allows a leading token that matches an alias, not just a canonical name', () => {
    expect(findUnknownLeadingCommand('/reset please', CATALOG)).toBeNull();
    expect(findUnknownLeadingCommand('/fork please', CATALOG)).toBeNull();
  });

  it('never blocks a mid-sentence unknown token — that is prose, not a command', () => {
    expect(findUnknownLeadingCommand('look at /nope over there', CATALOG)).toBeNull();
  });

  it('allows an ordinary message with no leading slash at all', () => {
    expect(findUnknownLeadingCommand('hello there', CATALOG)).toBeNull();
  });

  it('fails open while the catalog has not loaded yet', () => {
    expect(findUnknownLeadingCommand('/nope', [])).toBeNull();
  });
});
