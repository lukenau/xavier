// Status/tone mapping and row derivation for the System panel. The
// statusToneColor table is the one piece of this screen with a documented
// quirk (the trailing \b on the first pattern only), so it is pinned
// case-by-case rather than sampled.
import { statusToneColor } from './DetailSheet';
import {
  DOCTOR_TONE,
  filterSkills,
  mcpMeta,
  mcpStatusLabel,
  pluginStatusLabel,
  pluginStatusTone,
  skillMeta,
  skillsSummary,
  sortPluginsEnabledFirst,
  visibleDoctorSections,
} from './systemFormat';
import type { McpServer, SkillRow } from '../../lib/types';

function skill(over: Partial<SkillRow> = {}): SkillRow {
  return { name: 'cost-watch', category: 'finance', source: 'hub', trust: 'trusted', status: 'enabled', ...over };
}

describe('statusToneColor (DetailSheet.tsx:7-15)', () => {
  test.each([
    ['', 'fg-4'],
    ['   ', 'fg-4'],
    [null, 'fg-4'],
    [undefined, 'fg-4'],
    ['enabled', 'status-up'],
    ['Active', 'status-up'],
    [' OK ', 'status-up'],
    ['installed', 'status-up'],
    ['ready', 'status-up'],
    ['trusted', 'status-up'],
    ['pass', 'status-up'],
    ['warn', 'status-warn'],
    ['degraded', 'status-warn'],
    ['pending', 'status-warn'],
    ['partial', 'status-warn'],
    ['error', 'status-down'],
    ['failed', 'status-down'],
    ['missing', 'status-down'],
    ['blocked', 'status-down'],
    ['broken', 'status-down'],
    ['disabled', 'fg-4'],
    ['off', 'fg-4'],
    ['whatever', 'fg-3'],
  ] as const)('%s -> %s', (raw, token) => {
    expect(statusToneColor(raw)).toBe(token);
  });

  test('substring matching means two hermes tokens tone the WRONG way — reproduced, not fixed', () => {
    // `/(…|trusted|pass)\b/` matches inside "untrusted", and `/(…|active|…)\b/`
    // matches inside "inactive", so both land on the up tone before the
    // down/off patterns are ever reached. Both are live values on this estate
    // (skills carry trust=untrusted; MCP/plugin rows carry status=inactive).
    // This is apps/hub's behaviour today, byte-for-byte, and parity is the
    // brief — see task-11-report.md, which flags it for the PWA to fix first.
    expect(statusToneColor('untrusted')).toBe('status-up');
    expect(statusToneColor('inactive')).toBe('status-up');
  });

  test('the \\b lives on the first pattern only, so "okay" falls through but "failed" matches', () => {
    // The PWA's regexes are asymmetric; parity means keeping the asymmetry.
    expect(statusToneColor('okay')).toBe('fg-3');
    expect(statusToneColor('failed')).toBe('status-down');
    expect(statusToneColor('warning')).toBe('status-warn');
  });

  test('an "enabled" substring beats a later "fail" substring — first match wins', () => {
    expect(statusToneColor('enabled (last check failed)')).toBe('status-up');
  });
});

describe('skills', () => {
  test('the summary line hides a null enabled and a zero disabled', () => {
    expect(skillsSummary({ enabled: 20, disabled: 4 })).toBe('installed · 20 enabled · 4 disabled');
    expect(skillsSummary({ enabled: 20, disabled: 0 })).toBe('installed · 20 enabled');
    expect(skillsSummary({ enabled: null, disabled: null })).toBe('installed');
    // 0 enabled is a real count, not "not reported" — it must still render.
    expect(skillsSummary({ enabled: 0, disabled: null })).toBe('installed · 0 enabled');
  });

  test('an uncategorized skill says so; empty source/trust are dropped', () => {
    expect(skillMeta(skill())).toBe('finance · hub · trusted');
    expect(skillMeta(skill({ category: null, source: '', trust: '' }))).toBe('uncategorized');
  });

  test('search matches any of the five columns, case-insensitively', () => {
    const rows = [skill(), skill({ name: 'oura', category: 'health', source: 'local', trust: 'untrusted', status: 'disabled' })];
    expect(filterSkills(rows, '')).toHaveLength(2);
    expect(filterSkills(rows, '   ')).toHaveLength(2);
    expect(filterSkills(rows, 'HEALTH').map((s) => s.name)).toEqual(['oura']);
    expect(filterSkills(rows, 'untrust').map((s) => s.name)).toEqual(['oura']);
    expect(filterSkills(rows, 'nothing')).toEqual([]);
  });
});

describe('plugins', () => {
  test('enabled first, order preserved inside each group', () => {
    const rows = [
      { name: 'a', enabled: false },
      { name: 'b', enabled: true },
      { name: 'c', enabled: false },
      { name: 'd', enabled: true },
    ];
    expect(sortPluginsEnabledFirst(rows).map((p) => p.name)).toEqual(['b', 'd', 'a', 'c']);
    // Non-mutating: the caller's array is a query-cache object.
    expect(rows.map((p) => p.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('the sheet pill falls back to the boolean when status is empty', () => {
    expect(pluginStatusLabel({ status: 'bundled', enabled: false })).toBe('bundled');
    expect(pluginStatusLabel({ status: '', enabled: true })).toBe('enabled');
    expect(pluginStatusLabel({ status: null, enabled: false })).toBe('disabled');
  });

  test('an enabled plugin is always up-toned, whatever its status text says', () => {
    expect(pluginStatusTone({ status: 'broken', enabled: true })).toBe('status-up');
    expect(pluginStatusTone({ status: null, enabled: false })).toBe('fg-4');
    expect(pluginStatusTone({ status: 'degraded', enabled: false })).toBe('status-warn');
  });
});

describe('mcp', () => {
  const server = (over: Partial<McpServer> = {}): McpServer => ({
    name: 'exa',
    transport: 'http',
    tools: '4',
    status: 'enabled',
    enabled: true,
    ...over,
  });

  test('meta shows an em-dash for a missing transport and hides an empty tool count', () => {
    expect(mcpMeta(server())).toBe('http · 4 tools');
    expect(mcpMeta(server({ transport: null, tools: null }))).toBe('—');
  });

  test('the status column falls back to the boolean', () => {
    expect(mcpStatusLabel(server({ status: null }))).toBe('enabled');
    expect(mcpStatusLabel(server({ status: null, enabled: false }))).toBe('—');
  });
});

describe('doctor', () => {
  const sections = [
    { name: 'gateway', checks: [{ status: 'pass' as const, label: 'up' }, { status: 'warn' as const, label: 'slow' }] },
    { name: 'disk', checks: [{ status: 'pass' as const, label: 'space ok' }] },
  ];

  test('issues-only drops passing checks AND the sections that empty out', () => {
    expect(visibleDoctorSections(sections, false)).toEqual([
      { name: 'gateway', checks: [{ status: 'warn', label: 'slow' }] },
    ]);
  });

  test('show-all keeps every section', () => {
    expect(visibleDoctorSections(sections, true)).toHaveLength(2);
  });

  test('an all-green doctor yields nothing to render, which is the "All checks passed" branch', () => {
    expect(visibleDoctorSections([sections[1]], false)).toEqual([]);
  });

  test('the tally glyphs are the PWA\'s', () => {
    expect(DOCTOR_TONE.pass).toEqual({ color: 'status-up', glyph: '✓' });
    expect(DOCTOR_TONE.warn).toEqual({ color: 'status-warn', glyph: '⚠' });
    expect(DOCTOR_TONE.fail).toEqual({ color: 'status-down', glyph: '✗' });
  });
});
