// The full-settings editor's decision logic: which renderer a leaf gets,
// what its row reads, how sections become blocks, and what one staged change
// looks like. Every expectation below is read off the PWA source
// (apps/hub/src/routes/config/ConfigSectionPage.tsx) or the parity inventory,
// including the four quirks OQ-27 says to reproduce rather than fix.
import { CONFIG_HELP } from '../../shared/configHelp';
import type { ConfigFullLeaf, ConfigFullSection } from '../../lib/types';
import {
  blockRowCount,
  buildBlocks,
  controlForLeaf,
  enumFor,
  filterNumeric,
  groupStructural,
  helpDefaultSuffix,
  isDomainMismatch,
  isStructural,
  leafControlValue,
  leafDisplay,
  leafPeek,
  leafRowKind,
  MODEL_TIERS,
  pillOptions,
  rejectedMessage,
  relPath,
  stagePending,
  tierColor,
} from './leaves';

function leaf(over: Partial<ConfigFullLeaf> & { key: string }): ConfigFullLeaf {
  return {
    label: over.key,
    value: null,
    type: 'str',
    writable: true,
    sensitive: false,
    set: true,
    ...over,
  };
}

function section(id: string, leaves: ConfigFullLeaf[], label = id): ConfigFullSection {
  return { id, label, leaves };
}

describe('relPath', () => {
  test('a leaf keyed exactly as its section has an empty relative path', () => {
    expect(relPath('TELEGRAM_HOME_CHANNEL', 'TELEGRAM_HOME_CHANNEL')).toBe('');
  });

  test('the section prefix is stripped, however deep', () => {
    expect(relPath('agent', 'agent.max_turns')).toBe('max_turns');
    expect(relPath('auxiliary', 'auxiliary.vision.model')).toBe('vision.model');
  });

  test('a key that does not belong to the section is left alone', () => {
    expect(relPath('agent', 'memory.enabled')).toBe('memory.enabled');
  });
});

describe('leafRowKind — the whole editability decision', () => {
  test('list/dict containers are structural, every scalar is not', () => {
    expect(isStructural(leaf({ key: 'a', type: 'list' }))).toBe(true);
    expect(isStructural(leaf({ key: 'a', type: 'dict' }))).toBe(true);
    for (const type of ['str', 'int', 'float', 'bool'] as const) {
      expect(isStructural(leaf({ key: 'a', type }))).toBe(false);
    }
  });

  test('sensitive scalars are masked, everything else scalar is editable', () => {
    expect(leafRowKind(leaf({ key: 'a', sensitive: true }))).toBe('sensitive');
    expect(leafRowKind(leaf({ key: 'a', type: 'dict', sensitive: true }))).toBe('structural');
    expect(leafRowKind(leaf({ key: 'a' }))).toBe('scalar');
  });

  test('QUIRK (OQ-27 / inventory §13.1): `writable` is ignored', () => {
    // The server sends writable = !structural && !sensitive; the UI never
    // reads it. A leaf marked unwritable but scalar and non-sensitive still
    // renders the editable row — reproduced from the PWA, not fixed.
    expect(leafRowKind(leaf({ key: 'a', writable: false }))).toBe('scalar');
    expect(leafRowKind(leaf({ key: 'a', writable: true, sensitive: true }))).toBe('sensitive');
  });
});

describe('controlForLeaf — the leaf render type', () => {
  test('model.default always takes the LIVE model list, whatever its type says', () => {
    expect(controlForLeaf(leaf({ key: 'model.default', value: 'x' }), MODEL_TIERS)).toEqual({
      kind: 'enum',
      options: MODEL_TIERS,
    });
  });

  test('a curated CONFIG_HELP domain wins over the type', () => {
    expect(controlForLeaf(leaf({ key: 'agent.reasoning_effort' }), MODEL_TIERS)).toEqual({
      kind: 'enum',
      options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    });
    // agent.verify_on_stop's domain is auto/true/false — a STRING domain on a
    // key that reads like a boolean. The domain must win, or the switch
    // control would make 'auto' unreachable.
    expect(controlForLeaf(leaf({ key: 'agent.verify_on_stop', type: 'bool' }), MODEL_TIERS)).toEqual({
      kind: 'enum',
      options: ['auto', 'true', 'false'],
    });
  });

  test('otherwise the type picks the control', () => {
    expect(controlForLeaf(leaf({ key: 'x.y', type: 'bool' }), MODEL_TIERS)).toEqual({ kind: 'bool' });
    expect(controlForLeaf(leaf({ key: 'x.y', type: 'int' }), MODEL_TIERS)).toEqual({ kind: 'text', numeric: 'int' });
    expect(controlForLeaf(leaf({ key: 'x.y', type: 'float' }), MODEL_TIERS)).toEqual({
      kind: 'text',
      numeric: 'float',
    });
    expect(controlForLeaf(leaf({ key: 'x.y', type: 'str' }), MODEL_TIERS)).toEqual({ kind: 'text' });
  });

  test('enumFor returns null for a key with no domain and no live list', () => {
    expect(enumFor('x.y', MODEL_TIERS)).toBeNull();
  });
});

describe('row value formatting', () => {
  test('a bool is the string hermes coerces, displayed as On/Off', () => {
    const on = leaf({ key: 'a', type: 'bool', value: true });
    const off = leaf({ key: 'a', type: 'bool', value: false });
    expect(leafControlValue(on)).toBe('true');
    expect(leafControlValue(off)).toBe('false');
    expect(leafDisplay(on, 'true')).toBe('On');
    expect(leafDisplay(off, 'false')).toBe('Off');
  });

  test('null/undefined become an empty control value and read "(not set)"', () => {
    const l = leaf({ key: 'a', value: null });
    expect(leafControlValue(l)).toBe('');
    expect(leafDisplay(l, '')).toBe('(not set)');
  });

  test('everything else stringifies', () => {
    expect(leafControlValue(leaf({ key: 'a', type: 'int', value: 30 }))).toBe('30');
    expect(leafDisplay(leaf({ key: 'a', type: 'int', value: 30 }), '30')).toBe('30');
  });

  test('leafPeek masks a sensitive leaf and never prints a value', () => {
    expect(leafPeek(leaf({ key: 'a', sensitive: true, set: true, value: 'hunter2' }))).toBe('(set)');
    expect(leafPeek(leaf({ key: 'a', sensitive: true, set: false }))).toBe('not set');
    expect(leafPeek(leaf({ key: 'a', type: 'list' }))).toBe('[ ]');
    expect(leafPeek(leaf({ key: 'a', type: 'dict' }))).toBe('{ }');
    expect(leafPeek(leaf({ key: 'a', value: '' }))).toBe('—');
    expect(leafPeek(leaf({ key: 'a', value: 'v' }))).toBe('v');
  });

  test('tier drives the dot colour', () => {
    expect(tierColor('danger')).toBe('status-down');
    expect(tierColor('caution')).toBe('status-warn');
  });
});

describe('the enum picker', () => {
  test('QUIRK (OQ-27 / inventory §13.2): the current value leads the pills even when unlisted', () => {
    // The advisor presets write model.default = claude-sonnet-4-6, which
    // /api/chat/models does not list. Leading with the current value is what
    // keeps that state visible and selected instead of silently unselected.
    expect(pillOptions(MODEL_TIERS, 'claude-sonnet-4-6')).toEqual(['claude-sonnet-4-6', ...MODEL_TIERS]);
    expect(pillOptions(MODEL_TIERS, 'claude-sonnet-5')).toEqual(MODEL_TIERS);
    expect(pillOptions(MODEL_TIERS, '')).toEqual(MODEL_TIERS);
  });

  test('an off-domain value warns, an empty one does not', () => {
    const help = CONFIG_HELP['prompt_caching.cache_ttl'];
    expect(isDomainMismatch(help, '30m')).toBe(true);
    expect(isDomainMismatch(help, '1h')).toBe(false);
    expect(isDomainMismatch(help, '')).toBe(false);
    expect(isDomainMismatch(CONFIG_HELP['agent.max_turns'], 'anything')).toBe(false);
  });
});

describe('helpDefaultSuffix', () => {
  test('renders default, and the unit alongside it', () => {
    expect(helpDefaultSuffix(CONFIG_HELP['agent.max_turns'])).toBe(' · default: 30');
    expect(helpDefaultSuffix(CONFIG_HELP['terminal.timeout'])).toBe(' · default: 180 s');
  });

  test('QUIRK (OQ-27 / inventory §13.3): a unit with no default never renders', () => {
    // compression.threshold ("fraction") and session_reset.idle_minutes
    // ("min") both carry a unit and no default, so the PWA shows neither.
    expect(CONFIG_HELP['compression.threshold'].unit).toBe('fraction');
    expect(helpDefaultSuffix(CONFIG_HELP['compression.threshold'])).toBe('');
    expect(CONFIG_HELP['session_reset.idle_minutes'].unit).toBe('min');
    expect(helpDefaultSuffix(CONFIG_HELP['session_reset.idle_minutes'])).toBe('');
    expect(helpDefaultSuffix(undefined)).toBe('');
  });
});

describe('filterNumeric', () => {
  test('int keeps digits and the sign, float also keeps the point', () => {
    expect(filterNumeric('3o0', 'int')).toBe('30');
    expect(filterNumeric('-1.5', 'int')).toBe('-15');
    expect(filterNumeric('0.75x', 'float')).toBe('0.75');
    expect(filterNumeric('anything', undefined)).toBe('anything');
  });
});

describe('groupStructural', () => {
  const leaves = [
    leaf({ key: 'mcp_servers.exa.url', value: 'https://x' }),
    leaf({ key: 'mcp_servers.exa.transport', value: 'http' }),
    leaf({ key: 'mcp_servers.exa.key', sensitive: true, set: true }),
    leaf({ key: 'mcp_servers.imessage.url', value: 'http://mac' }),
  ];

  test('one row per first segment, in first-seen order, counting its items', () => {
    expect(groupStructural('mcp_servers', leaves)).toEqual([
      { name: 'exa', count: 3, peek: 'url: https://x · transport: http · key: (set)' },
      { name: 'imessage', count: 1, peek: 'url: http://mac' },
    ]);
  });

  test('a peek stops at four items and says so', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => leaf({ key: `s.g.${n}`, value: n }));
    const [group] = groupStructural('s', many);
    expect(group.count).toBe(5);
    expect(group.peek).toBe('a: a · b: b · c: c · d: d …');
  });
});

describe('buildBlocks', () => {
  const agent = section('agent', [
    leaf({ key: 'agent.max_turns', type: 'int', value: 30 }),
    leaf({ key: 'agent.personalities.pirate.prompt', value: 'arr' }),
    leaf({ key: 'agent.personalities.chef.prompt', value: 'yum' }),
  ]);
  const platforms = section('platform_toolsets', [
    leaf({ key: 'platform_toolsets.telegram.0', value: 'web' }),
    leaf({ key: 'platform_toolsets.cli.0', value: 'shell' }),
    leaf({ key: 'platform_toolsets.discord.0', value: 'web' }),
    leaf({ key: 'platform_toolsets.slack.0', value: 'web' }),
  ]);

  test('top-level scalars, nested buckets and structural rows are separated', () => {
    const s = section('auxiliary', [
      leaf({ key: 'auxiliary.enabled', type: 'bool', value: true }),
      leaf({ key: 'auxiliary.vision.model', value: 'v' }),
      leaf({ key: 'auxiliary.vision.max_tokens', type: 'int', value: 1 }),
      leaf({ key: 'auxiliary.extras', type: 'dict' }),
    ]);
    const [block] = buildBlocks('model', [s], [s]);
    expect(block.top.map((l) => l.key)).toEqual(['auxiliary.enabled']);
    expect(block.nested).toHaveLength(1);
    expect(block.nested[0].seg).toBe('vision');
    expect(block.structural.map((g) => g.name)).toEqual(['extras']);
    expect(blockRowCount(block)).toBe(4);
  });

  test('Behavior demotes agent.personalities.* to one summary row pointing at misc', () => {
    const [block] = buildBlocks('behavior', [agent], [agent]);
    expect(block.top.map((l) => l.key)).toEqual(['agent.max_turns']);
    expect(block.nested).toHaveLength(0);
    expect(block.summaries).toEqual([
      { id: 'personalities', label: 'personalities', note: '2 presets · shipped defaults', href: '/config/g/misc' },
    ]);
  });

  test('Channels keeps telegram + cli and demotes the rest, counting DISTINCT platforms', () => {
    const [block] = buildBlocks('channels', [platforms], [platforms]);
    expect(block.nested.map((n) => n.seg)).toEqual(['telegram', 'cli']);
    expect(block.summaries).toEqual([
      {
        id: 'platforms-unused',
        label: '2 more platforms unused',
        note: 'shipped defaults · in Everything else',
        href: '/config/g/misc',
      },
    ]);
  });

  test('Everything else appends the two demoted subtrees as fully editable blocks', () => {
    const all = [agent, platforms];
    const blocks = buildBlocks('misc', [], all);
    expect(blocks.map((b) => b.label)).toEqual(['Agent personalities', 'Platform toolsets · unused']);
    expect(blocks[0].nested.map((n) => n.seg)).toEqual(['personalities']);
    expect(blocks[1].nested.map((n) => n.seg)).toEqual(['discord', 'slack']);
  });

  test('a group with no demotable content gets neither summary nor extra block', () => {
    const s = section('approvals', [leaf({ key: 'approvals.mode', value: 'manual' })]);
    const [block] = buildBlocks('security', [s], [s]);
    expect(block.summaries).toEqual([]);
    expect(buildBlocks('misc', [], [s])).toEqual([]);
  });
});

describe('stagePending — one staged change at a time', () => {
  const turns = leaf({ key: 'agent.max_turns', label: 'max_turns', type: 'int', value: 30 });
  const provider = leaf({ key: 'model.provider', label: 'provider', value: 'anthropic' });

  test('a real change stages the key, its display value and its curated tier', () => {
    expect(stagePending(turns, '50', '30', null)).toEqual({
      configKey: 'agent.max_turns',
      value: '50',
      label: 'max_turns',
      display: '50',
      tone: undefined,
      note: undefined,
    });
    expect(stagePending(provider, 'openrouter', 'anthropic', null)).toMatchObject({
      tone: 'danger',
      note: CONFIG_HELP['model.provider'].desc,
    });
  });

  test('staging a second key REPLACES the first (one config set per assertion)', () => {
    const first = stagePending(turns, '50', '30', null);
    const second = stagePending(provider, 'openrouter', 'anthropic', first);
    expect(second?.configKey).toBe('model.provider');
  });

  test('typing back to the current value clears the change on that key only', () => {
    const staged = stagePending(turns, '50', '30', null);
    expect(stagePending(turns, '30', '30', staged)).toBeNull();
    // …and leaves a change staged on a DIFFERENT key alone.
    expect(stagePending(provider, 'anthropic', 'anthropic', staged)).toBe(staged);
  });

  test('QUIRK (OQ-27 / inventory §13.4): a blank value cancels the edit rather than clearing the setting', () => {
    // `config set` requires a value, so the PWA treats a trimmed-empty input
    // as "nothing to apply" — which means a string leaf can be SET from the
    // Hub but never CLEARED. Reproduced, not fixed.
    const named = leaf({ key: 'telegram.name', label: 'name', value: 'Assistant' });
    expect(stagePending(named, '', 'Assistant', null)).toBeNull();
    expect(stagePending(named, '   ', 'Assistant', null)).toBeNull();
    const staged = stagePending(named, 'X', 'Assistant', null);
    expect(stagePending(named, '', 'Assistant', staged)).toBeNull();
  });
});

describe('rejectedMessage', () => {
  test('collapses stderr whitespace and caps it at 140 chars', () => {
    expect(rejectedMessage('  bad   key\n  here ', 1)).toBe('bad key here');
    expect(rejectedMessage('x'.repeat(200), 1)).toHaveLength(140);
  });

  test('falls back to the exit code, and to "?" when there is not even one', () => {
    expect(rejectedMessage('', 2)).toBe('the change was rejected (exit 2)');
    expect(rejectedMessage(undefined, undefined)).toBe('the change was rejected (exit ?)');
  });
});
