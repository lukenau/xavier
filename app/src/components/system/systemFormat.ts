// Pure derivations for the System panel — 1:1 with the expressions inline in
// apps/hub/src/components/system/SystemPanel.tsx; line refs are to that file.
import type { McpServer, SkillRow, SkillsReport } from '../../lib/types';
import type { TokenName } from '../../theme/tokens.gen';
import { statusToneColor } from './DetailSheet';

/** SystemPanel.tsx:138-142 — the line beside the big skills total. */
export function skillsSummary(d: Pick<SkillsReport, 'enabled' | 'disabled'>): string {
  return (
    'installed' +
    (d.enabled !== null ? ` · ${d.enabled} enabled` : '') +
    (d.disabled ? ` · ${d.disabled} disabled` : '')
  );
}

/** SystemPanel.tsx:99-101. */
export function skillMeta(s: SkillRow): string {
  return (
    (s.category ?? 'uncategorized') + (s.source ? ` · ${s.source}` : '') + (s.trust ? ` · ${s.trust}` : '')
  );
}

/** SystemPanel.tsx:118-125 — case-insensitive substring over five columns. */
export function filterSkills(rows: SkillRow[], query: string): SkillRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((s) =>
    [s.name, s.category, s.source, s.trust, s.status].some((v) => (v ?? '').toLowerCase().includes(needle)),
  );
}

/** SystemPanel.tsx:254-257 — enabled first, stable within each group. */
export function sortPluginsEnabledFirst<T extends { enabled: boolean }>(all: readonly T[]): T[] {
  return [...all].sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

/** SystemPanel.tsx:387. */
export function mcpMeta(s: McpServer): string {
  return (s.transport ?? '—') + (s.tools ? ` · ${s.tools} tools` : '');
}

/** SystemPanel.tsx:391 — `status`, else the boolean read back as a word. */
export function mcpStatusLabel(s: McpServer): string {
  return s.status ?? (s.enabled ? 'enabled' : '—');
}

/** SystemPanel.tsx:286-287 — the Plugin sheet's status pill. */
export function pluginStatusLabel(p: { status: string | null; enabled: boolean }): string {
  return p.status || (p.enabled ? 'enabled' : 'disabled');
}

export function pluginStatusTone(p: { status: string | null; enabled: boolean }): TokenName {
  return p.enabled ? 'status-up' : statusToneColor(p.status ?? 'disabled');
}

export const DOCTOR_TONE: Record<'pass' | 'warn' | 'fail', { color: TokenName; glyph: string }> = {
  pass: { color: 'status-up', glyph: '✓' },
  warn: { color: 'status-warn', glyph: '⚠' },
  fail: { color: 'status-down', glyph: '✗' },
};

/** SystemPanel.tsx:439-446 — issues only by default, and sections that empty
 * out under that filter disappear entirely. */
export function visibleDoctorSections<C extends { status: 'pass' | 'warn' | 'fail' }>(
  sections: readonly { name: string; checks: C[] }[],
  showAll: boolean,
): { name: string; checks: C[] }[] {
  return sections
    .map((sec) => ({ name: sec.name, checks: showAll ? sec.checks : sec.checks.filter((c) => c.status !== 'pass') }))
    .filter((sec) => sec.checks.length > 0);
}
