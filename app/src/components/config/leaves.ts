// Pure logic behind the full-settings editor (ConfigSectionPage.tsx:39-258,
// 754-769): which control a leaf renders, what its row shows, how sections
// become blocks, and what one staged change looks like. Split out of the
// screen so it is unit-testable without a renderer.
import { CONFIG_HELP, type ConfigHelp } from '../../shared/configHelp';
import type { ConfigFullLeaf, ConfigFullSection } from '../../lib/types';
import type { TokenName } from '../../theme/tokens.gen';

// Fallback model tiers for the model.default picker if the live tier list
// (api.chatModels → /api/chat/models) is unavailable. The live list is preferred
// and unioned with the current value so a non-listed tier still shows selected.
export const MODEL_TIERS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'openai/gpt-oss-120b'];

// When model.provider routes via OpenRouter, chat traffic needs provider-prefixed
// ids — the bare Anthropic tier ids the model list serves would be rejected.
export const OPENROUTER_IDS: Record<string, string> = {
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
};

export const OPENROUTER_HINT = 'routing via OpenRouter — ids are provider-prefixed';

export type LeafControl =
  | { kind: 'bool' } // iOS switch; submitted as 'true' | 'false' (hermes coerces to bool)
  | { kind: 'enum'; options: string[] }
  | { kind: 'text'; numeric?: 'int' | 'float' };

/** Path of a leaf key RELATIVE to its section ('' for a top-level scalar). */
export function relPath(sectionId: string, key: string): string {
  if (key === sectionId) return '';
  if (key.startsWith(sectionId + '.')) return key.slice(sectionId.length + 1);
  return key;
}

/**
 * A leaf is STRUCTURAL — summarised read-only, never a raw editor — only when
 * it is an (empty) list/dict container. Every scalar, however deep, is a real
 * setting and gets an editor.
 *
 * PARITY QUIRK (inventory §13.1 / OQ-27): `leaf.writable` is returned by the
 * server and read by NOTHING here, exactly as in the PWA — editability is
 * derived from `sensitive` + `type` alone. The server computes
 * `writable = !structural && !sensitive`, so the two agree today; reproducing
 * the PWA means deriving rather than trusting the field.
 */
export function isStructural(leaf: ConfigFullLeaf): boolean {
  return leaf.type === 'list' || leaf.type === 'dict';
}

export type LeafRowKind = 'structural' | 'sensitive' | 'scalar';

/**
 * Which of the three row renderers a leaf gets — the whole editability
 * decision, and the exact place the `writable` quirk lives: the field is
 * never consulted (ConfigSectionPage.tsx:811 branches on `sensitive`, and
 * buildBlock buckets on `type`).
 */
export function leafRowKind(leaf: ConfigFullLeaf): LeafRowKind {
  if (isStructural(leaf)) return 'structural';
  if (leaf.sensitive) return 'sensitive';
  return 'scalar';
}

/** Enum options for a leaf, or null for a free-text/numeric control.
 * model.default uses the LIVE tier list; everything else comes from the
 * curated CONFIG_HELP domain (the KNOWN_ENUMS mechanism, fed from help). */
export function enumFor(key: string, modelOptions: string[]): string[] | null {
  if (key === 'model.default') return modelOptions;
  return CONFIG_HELP[key]?.domain ?? null;
}

export function controlForLeaf(leaf: ConfigFullLeaf, modelOptions: string[]): LeafControl {
  const opts = enumFor(leaf.key, modelOptions);
  if (opts) return { kind: 'enum', options: opts };
  if (leaf.type === 'bool') return { kind: 'bool' };
  if (leaf.type === 'int') return { kind: 'text', numeric: 'int' };
  if (leaf.type === 'float') return { kind: 'text', numeric: 'float' };
  return { kind: 'text' };
}

/** Current leaf value → the canonical control string (what `config set` submits). */
export function leafControlValue(leaf: ConfigFullLeaf): string {
  if (leaf.type === 'bool') return leaf.value === true ? 'true' : 'false';
  if (leaf.value === null || leaf.value === undefined) return '';
  return String(leaf.value);
}

/** Control string → the display string shown on the row. */
export function leafDisplay(leaf: ConfigFullLeaf, controlValue: string): string {
  if (leaf.type === 'bool') return controlValue === 'true' ? 'On' : 'Off';
  if (controlValue === '') return '(not set)';
  return controlValue;
}

/** A masked one-token peek for a structural leaf (never a secret). */
export function leafPeek(leaf: ConfigFullLeaf): string {
  if (leaf.sensitive) return leaf.set ? '(set)' : 'not set';
  if (leaf.type === 'list') return '[ ]';
  if (leaf.type === 'dict') return '{ }';
  if (leaf.value === null || leaf.value === undefined || leaf.value === '') return '—';
  return String(leaf.value);
}

/** The row dot / consequence-line colour for a curated tier. */
export function tierColor(tier: 'caution' | 'danger'): TokenName {
  return tier === 'danger' ? 'status-down' : 'status-warn';
}

/** The numeric-input character filter — `int` keeps digits and `-`, `float`
 * also keeps `.` (ConfigSectionPage.tsx:408-409). */
export function filterNumeric(value: string, numeric?: 'int' | 'float'): string {
  if (numeric === 'int') return value.replace(/[^0-9-]/g, '');
  if (numeric === 'float') return value.replace(/[^0-9.\-]/g, '');
  return value;
}

/** The enum pill list: the CURRENT value always leads, even when it is not a
 * listed option (ConfigSectionPage.tsx:390 — which is what keeps the advisor
 * presets' `claude-sonnet-4-6` selectable in a picker that does not list it). */
export function pillOptions(options: string[], current: string): string[] {
  return options.includes(current) || !current ? options : [current, ...options];
}

/** help.domain exists and the live value is not in it (`:446`). */
export function isDomainMismatch(help: ConfigHelp | undefined, current: string): boolean {
  return !!help?.domain && current !== '' && !help.domain.includes(current);
}

/**
 * The help line's ` · default: {d} {unit}` suffix.
 *
 * PARITY QUIRK (inventory §13.3 / OQ-27): `unit` renders ONLY when `default`
 * is also present (ConfigSectionPage.tsx:517), so `compression.threshold`
 * ("fraction") and `session_reset.idle_minutes` ("min") never show theirs.
 * Reproduced, not fixed.
 */
export function helpDefaultSuffix(help: ConfigHelp | undefined): string {
  if (!help?.default) return '';
  return ` · default: ${help.default}${help.unit ? ` ${help.unit}` : ''}`;
}

export interface StructuralGroup {
  name: string;
  count: number;
  peek: string;
}

/** Collapse structural leaves into one summary row per immediate child key. */
export function groupStructural(sectionId: string, leaves: ConfigFullLeaf[]): StructuralGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, ConfigFullLeaf[]>();
  for (const leaf of leaves) {
    const rp = relPath(sectionId, leaf.key);
    const first = rp.split('.')[0] || rp || sectionId;
    if (!buckets.has(first)) {
      buckets.set(first, []);
      order.push(first);
    }
    buckets.get(first)!.push(leaf);
  }
  return order.map((name) => {
    const items = buckets.get(name)!;
    const parts = items.slice(0, 4).map((leaf) => {
      const tail = relPath(sectionId, leaf.key).split('.').slice(1).join('.');
      const v = leafPeek(leaf);
      return tail ? `${tail}: ${v}` : v;
    });
    let peek = parts.join(' · ');
    if (items.length > 4) peek += ' …';
    return { name, count: items.length, peek };
  });
}

export interface NestedBucket {
  seg: string;
  leaves: ConfigFullLeaf[];
}

/** A curated stand-in for demoted keys (personalities, unused platforms). */
export interface SummaryRow {
  id: string;
  label: string;
  note: string;
  href?: string;
}

export interface Block {
  id: string;
  sectionId: string;
  label: string;
  top: ConfigFullLeaf[];
  nested: NestedBucket[];
  structural: StructuralGroup[];
  summaries: SummaryRow[];
}

export function buildBlock(sectionId: string, label: string, leaves: ConfigFullLeaf[]): Block {
  const top: ConfigFullLeaf[] = [];
  const nestedOrder: string[] = [];
  const nested = new Map<string, ConfigFullLeaf[]>();
  const structuralLeaves: ConfigFullLeaf[] = [];
  for (const leaf of leaves) {
    if (isStructural(leaf)) {
      structuralLeaves.push(leaf);
      continue;
    }
    const rp = relPath(sectionId, leaf.key);
    const dot = rp.indexOf('.');
    if (dot === -1) {
      top.push(leaf);
      continue;
    }
    const seg = rp.slice(0, dot);
    if (!nested.has(seg)) {
      nested.set(seg, []);
      nestedOrder.push(seg);
    }
    nested.get(seg)!.push(leaf);
  }
  return {
    id: `${sectionId}::${label}`,
    sectionId,
    label,
    top,
    nested: nestedOrder.map((seg) => ({ seg, leaves: nested.get(seg)! })),
    structural: groupStructural(sectionId, structuralLeaves),
    summaries: [],
  };
}

const PERSONALITY_PREFIX = 'agent.personalities.';
const KEPT_PLATFORMS = /^platform_toolsets\.(telegram|cli)\./;

/** Group sections → render blocks, applying the noise demotions:
 * agent.personalities.* → one summary row in Behavior; platform_toolsets.*
 * except telegram/cli → one link row in Channels; both render fully (editable)
 * only inside Everything else. */
export function buildBlocks(
  groupId: string,
  groupSections: ConfigFullSection[],
  allSections: ConfigFullSection[],
): Block[] {
  const blocks: Block[] = [];
  for (const s of groupSections) {
    if (groupId === 'behavior' && s.id === 'agent') {
      const presets = s.leaves.filter((l) => l.key.startsWith(PERSONALITY_PREFIX));
      const block = buildBlock(s.id, s.label, s.leaves.filter((l) => !l.key.startsWith(PERSONALITY_PREFIX)));
      if (presets.length) {
        block.summaries.push({
          id: 'personalities',
          label: 'personalities',
          note: `${presets.length} presets · shipped defaults`,
          href: '/config/g/misc',
        });
      }
      blocks.push(block);
      continue;
    }
    if (groupId === 'channels' && s.id === 'platform_toolsets') {
      const kept = s.leaves.filter((l) => KEPT_PLATFORMS.test(l.key));
      const unused = new Set(
        s.leaves.filter((l) => !KEPT_PLATFORMS.test(l.key)).map((l) => relPath(s.id, l.key).split('.')[0]),
      );
      const block = buildBlock(s.id, s.label, kept);
      if (unused.size) {
        block.summaries.push({
          id: 'platforms-unused',
          label: `${unused.size} more platforms unused`,
          note: 'shipped defaults · in Everything else',
          href: '/config/g/misc',
        });
      }
      blocks.push(block);
      continue;
    }
    blocks.push(buildBlock(s.id, s.label, s.leaves));
  }
  if (groupId === 'misc') {
    const presets =
      allSections.find((s) => s.id === 'agent')?.leaves.filter((l) => l.key.startsWith(PERSONALITY_PREFIX)) ?? [];
    if (presets.length) blocks.push(buildBlock('agent', 'Agent personalities', presets));
    const unused =
      allSections.find((s) => s.id === 'platform_toolsets')?.leaves.filter((l) => !KEPT_PLATFORMS.test(l.key)) ?? [];
    if (unused.length) blocks.push(buildBlock('platform_toolsets', 'Platform toolsets · unused', unused));
  }
  return blocks;
}

export function blockRowCount(block: Block): number {
  return (
    block.top.length +
    block.nested.reduce((m, nb) => m + nb.leaves.length, 0) +
    block.structural.length +
    block.summaries.length
  );
}

// ── Write-gate plumbing (one staged change per Face-ID assertion) ───────────

export interface Pending {
  configKey: string;
  value: string;
  label: string;
  display: string;
  tone?: 'caution' | 'danger';
  note?: string;
}

/**
 * ConfigSectionPage.tsx:754-769's `stage()` as a reducer: the next `pending`
 * given the leaf, the typed/picked value, the leaf's current value and
 * whatever was already staged.
 *
 * PARITY QUIRK (inventory §13.4 / OQ-27): a value equal to the current one OR
 * one that trims to empty means "nothing to apply" and clears any pending
 * change on THIS key — so a string leaf can be set from the Hub but never
 * cleared. Reproduced, not fixed.
 *
 * Also note there is exactly ONE pending change at a time: staging a second
 * key replaces the first, because the gate binds one `config set` per
 * assertion.
 */
export function stagePending(
  leaf: ConfigFullLeaf,
  value: string,
  current: string,
  prev: Pending | null,
): Pending | null {
  if (value === current || value.trim() === '') {
    return prev?.configKey === leaf.key ? null : prev;
  }
  const help = CONFIG_HELP[leaf.key];
  return {
    configKey: leaf.key,
    value,
    label: leaf.label,
    display: leafDisplay(leaf, value),
    tone: help?.tier,
    note: help?.tier ? help.desc : undefined,
  };
}

/** `res.status !== 'applied'` → the toast text (ConfigSectionPage.tsx:791-792). */
export function rejectedMessage(stderr: string | undefined, code: number | undefined): string {
  const why = (stderr || '').trim().replace(/\s+/g, ' ').slice(0, 140);
  return why || `the change was rejected (exit ${code ?? '?'})`;
}
