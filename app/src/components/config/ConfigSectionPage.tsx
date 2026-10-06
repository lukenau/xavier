// 1:1 port of apps/hub/src/routes/config/ConfigSectionPage.tsx — the FULL
// SETTINGS surface, one config GROUP per page (route param groupId maps
// sections via configGroupOf in groups.ts). Driven by api.configFull()
// (GET /api/config/full) so ALL sections / leaves are visible.
//
// Per leaf:
//   • writable scalar  → a type-inferred control (bool→switch, int/float→numeric
//                         input, str→input, known domains→picker), edited through
//                         the EXISTING write path (api.applyWrite config.set →
//                         Face ID). Nested scalars (auxiliary.vision.model,
//                         guardrail thresholds…) are editable too, grouped under
//                         indented sub-headers per first path segment.
//   • sensitive        → masked + read-only ('(set)' / 'not set', lock glyph).
//   • structural (an actual list/dict container leaf) → a compact READ-ONLY
//                         summary — structured editing is a later slice.
//
// CONFIG_HELP (src/shared/configHelp.ts, byte-locked copy) carries curated
// desc/default/domain/tier per dotted key.
//
// The write-gate stages ONE change at a time (one `config set` per Face-ID
// assertion), matching the backend's per-write binding. The assertion step
// itself is Task 21's; until then api.applyWrite POSTs a real challenge and
// then rejects with GateNotWiredError, which lands in the error toast below.
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { SymbolView } from 'expo-symbols';
import {
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SectionHead,
  StatePanel,
  Toast,
  useHideTabBar,
  type ToastKind,
} from '../shell';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { CONFIG_HELP, type ConfigHelp } from '../../shared/configHelp';
import type { ConfigFullLeaf } from '../../lib/types';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { configGroupLabel, configGroupOf } from './groups';
import {
  ActionBar,
  BackLink,
  BarCancel,
  FaceIdLock,
  GateButton,
  useActionBarClearance,
} from './parts';
import {
  blockRowCount,
  buildBlocks,
  controlForLeaf,
  filterNumeric,
  helpDefaultSuffix,
  isDomainMismatch,
  leafControlValue,
  leafDisplay,
  leafRowKind,
  MODEL_TIERS,
  OPENROUTER_HINT,
  OPENROUTER_IDS,
  pillOptions,
  rejectedMessage,
  relPath,
  stagePending,
  tierColor,
  type Block,
  type LeafControl,
  type Pending,
  type StructuralGroup,
  type SummaryRow,
} from './leaves';
import { writeErrorMessage } from './writeErrors';

const SWITCH_MS = 150;

const STRUCTURAL_FOOTNOTE =
  'Structured entries (lists & nested objects) are read-only here — structured editing arrives in a later slice.';

function OptionPill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: selected ? t('accent-soft') : t('bg-2'),
          borderColor: selected ? t('accent-border') : t('border'),
        },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text
        style={[selected ? styles.pillLabelOn : styles.pillLabel, { color: selected ? t('accent') : t('fg-2') }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** ConfigSectionPage.tsx:331-361 — 46×28 track, 22px knob, both transitions 150ms. */
function BoolSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { t } = useTheme();
  const progress = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    // Not native-driven: the track's background colour animates too, and
    // colour interpolation is JS-side only.
    Animated.timing(progress, { toValue: on ? 1 : 0, duration: SWITCH_MS, useNativeDriver: false }).start();
  }, [on, progress]);

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      style={styles.switchHit}
    >
      <Animated.View
        style={[
          styles.switchTrack,
          {
            borderColor: on ? t('accent-border') : t('border'),
            backgroundColor: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [t('bg-3'), t('accent')],
            }),
          },
        ]}
      >
        <Animated.View
          style={[
            styles.switchKnob,
            {
              backgroundColor: t('knob'),
              boxShadow: t('knob-shadow'),
              transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }) }],
            },
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

function LeafEditControl({
  control,
  current,
  staged,
  onStage,
}: {
  control: LeafControl;
  current: string;
  staged: string | null;
  onStage: (value: string) => void;
}) {
  const { t } = useTheme();
  const active = staged ?? current;

  if (control.kind === 'bool') {
    const on = active === 'true';
    return (
      <View style={styles.boolRow}>
        <Text style={[styles.boolLabel, { color: t('fg-3') }]}>{on ? 'Enabled' : 'Disabled'}</Text>
        <BoolSwitch on={on} onToggle={() => onStage(on ? 'false' : 'true')} />
      </View>
    );
  }

  if (control.kind === 'enum') {
    return (
      <View style={styles.pillWrap}>
        {pillOptions(control.options, current).map((opt) => (
          <OptionPill key={opt} label={opt} selected={opt === active} onPress={() => onStage(opt)} />
        ))}
      </View>
    );
  }

  const numeric = control.numeric;
  return (
    <TextInput
      value={active}
      onChangeText={(v) => onStage(filterNumeric(v, numeric))}
      inputMode={numeric ? 'decimal' : 'text'}
      placeholder={numeric ? '0' : 'value'}
      placeholderTextColor={t('fg-4')}
      autoCapitalize="none"
      autoCorrect={false}
      style={[styles.input, { backgroundColor: t('bg-2'), borderColor: t('border'), color: t('fg-0') }]}
    />
  );
}

/** A writable scalar leaf — tappable row → inline control → staged change. */
function ScalarLeafRow({
  leaf,
  title,
  help,
  hint,
  control,
  isLast,
  open,
  staged,
  onToggle,
  onStage,
}: {
  leaf: ConfigFullLeaf;
  title: string;
  help: ConfigHelp | undefined;
  hint: string | null;
  control: LeafControl;
  isLast: boolean;
  open: boolean;
  staged: string | null;
  onToggle: () => void;
  onStage: (value: string) => void;
}) {
  const { t } = useTheme();
  const current = leafControlValue(leaf);
  const shown = staged !== null ? leafDisplay(leaf, staged) : leafDisplay(leaf, current);
  const changed = staged !== null && staged !== current;
  const domainMismatch = isDomainMismatch(help, current);

  return (
    <View style={isLast && !open ? null : { borderBottomWidth: 1, borderBottomColor: t('border') }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.leafRow, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <View style={styles.leafRowLeft}>
          <View style={styles.leafTitleRow}>
            {help?.tier ? <View style={[styles.tierDot, { backgroundColor: t(tierColor(help.tier)) }]} /> : null}
            <Text numberOfLines={1} style={[styles.leafTitle, { color: t('fg-1') }]}>
              {title}
            </Text>
          </View>
          {help ? (
            <Text numberOfLines={2} style={[styles.leafDesc, { color: t('fg-3') }]}>
              {help.desc}
            </Text>
          ) : null}
        </View>
        <View style={styles.leafRowRight}>
          <Text
            numberOfLines={1}
            style={[
              changed ? styles.leafValueChanged : styles.leafValue,
              { color: changed ? t('accent-hi') : t('fg-2') },
            ]}
          >
            {shown}
          </Text>
          <FaceIdLock active />
          <View style={open ? styles.chevronOpen : undefined}>
            <SymbolView name="chevron.right" size={15} tintColor={t('fg-3')} weight="semibold" />
          </View>
        </View>
      </Pressable>
      {open ? (
        <View style={styles.leafBody}>
          <LeafEditControl control={control} current={current} staged={staged} onStage={onStage} />
          {hint ? <Text style={[styles.leafHint, { color: t('fg-4') }]}>{hint}</Text> : null}
          {domainMismatch ? (
            <Text style={[styles.leafHint, { color: t('status-warn') }]}>
              (unrecognised — the default value applies)
            </Text>
          ) : null}
          {help ? (
            <Text style={[styles.leafHelp, { color: help.tier ? t(tierColor(help.tier)) : t('fg-3') }]}>
              {help.desc}
              {helpDefaultSuffix(help)}
            </Text>
          ) : null}
          {changed && !help?.tier ? (
            <Text style={[styles.leafWas, { color: t('fg-3') }]}>
              was {leafDisplay(leaf, current)} · confirm with Face ID below
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A sensitive leaf — masked + read-only (the real value never reaches the UI). */
function SensitiveLeafRow({ leaf, title, isLast }: { leaf: ConfigFullLeaf; title: string; isLast: boolean }) {
  const { t } = useTheme();
  return (
    <View
      style={[styles.sensitiveRow, isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') }]}
    >
      <Text numberOfLines={1} style={[styles.sensitiveTitle, { color: t('fg-2') }]}>
        {title}
      </Text>
      <View style={styles.sensitiveRight}>
        <Text style={[styles.leafValue, { color: leaf.set ? t('fg-3') : t('fg-4') }]}>
          {leaf.set ? '(set)' : 'not set'}
        </Text>
        <FaceIdLock />
      </View>
    </View>
  );
}

/** A structural group — read-only summary (count + peek), no raw editors. */
function StructuralGroupRow({ group, isLast }: { group: StructuralGroup; isLast: boolean }) {
  const { t } = useTheme();
  return (
    <View style={[styles.structRow, isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') }]}>
      <View style={styles.structLeft}>
        <Text numberOfLines={1} style={[styles.structName, { color: t('fg-2') }]}>
          {group.name}
        </Text>
        <Text numberOfLines={1} style={[styles.structPeek, { color: t('fg-4') }]}>
          {group.peek}
        </Text>
      </View>
      <View style={[styles.structCount, { backgroundColor: t('bg-2'), borderColor: t('border') }]}>
        <Text style={[styles.structCountLabel, { color: t('fg-3') }]}>
          {group.count} {group.count === 1 ? 'item' : 'items'}
        </Text>
      </View>
    </View>
  );
}

/** A demoted subtree stand-in (personalities, unused platforms) — one quiet row. */
function SummaryLinkRow({ row, isLast }: { row: SummaryRow; isLast: boolean }) {
  const { t } = useTheme();
  const border = isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') };
  const body = (
    <>
      <View style={styles.structLeft}>
        <Text numberOfLines={1} style={[styles.structName, { color: t('fg-2') }]}>
          {row.label}
        </Text>
        <Text style={[styles.summaryNote, { color: t('fg-4') }]}>{row.note}</Text>
      </View>
      {row.href ? <SymbolView name="chevron.right" size={15} tintColor={t('fg-3')} weight="semibold" /> : null}
    </>
  );
  if (!row.href) return <View style={[styles.summaryRow, border]}>{body}</View>;
  const href = row.href;
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="link"
      style={({ pressed }) => [styles.summaryRow, border, pressed && { opacity: PRESSED_OPACITY }]}
    >
      {body}
    </Pressable>
  );
}

/** Indented sub-header for nested scalars — 'auxiliary › vision'. */
function SubHead({ text }: { text: string }) {
  const { t } = useTheme();
  return <Text style={[styles.subHead, { color: t('fg-4') }]}>{text}</Text>;
}

/** Sticky "Review 1 change · Face ID" bar. Tiered keys surface their curated
 * consequence line in the tier tone. */
function ReviewBar({
  pending,
  applying,
  onApply,
  onCancel,
}: {
  pending: Pending;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  return (
    <ActionBar>
      <View style={styles.barHead}>
        <View style={styles.barHeadText}>
          <Text style={[styles.barEyebrow, { color: t('fg-3') }]}>Pending change</Text>
          <Text numberOfLines={1} style={[styles.barLine, { color: t('fg-0') }]}>
            {pending.label} → <Text style={[styles.barValue, { color: t('accent-hi') }]}>{pending.display}</Text>
          </Text>
          {pending.note && pending.tone ? (
            <Text style={[styles.barNote, { color: t(tierColor(pending.tone)) }]}>{pending.note}</Text>
          ) : null}
        </View>
        <BarCancel onPress={onCancel} disabled={applying} />
      </View>
      <GateButton label={applying ? 'Verifying…' : 'Review 1 change · Face ID'} busy={applying} onPress={onApply} />
    </ActionBar>
  );
}

/**
 * One config GROUP as its own page (full-settings). `groupId` comes from
 * /config/g/[groupId] and is a GROUP key (see configGroupOf in groups.ts), NOT
 * a single config.yaml section — every section that maps into the group is
 * gathered and its leaves rendered under a per-section sub-header.
 */
export function ConfigSectionPage({ groupId }: { groupId: string }) {
  useHideTabBar();
  const { t } = useTheme();
  const qc = useQueryClient();
  const config = usePoll(['config-full'], api.configFull, QUERY_TUNING['config-full']);
  // Live agent tiers for the model.default picker; falls back to MODEL_TIERS.
  const models = usePoll(['chat-models'], api.chatModels, QUERY_TUNING['chat-models']);

  // Write-gate state: one staged change at a time (one config set per assertion).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
  const barClearance = useActionBarClearance(pending !== null);

  const allSections = config.data?.sections ?? [];
  const groupSections = allSections.filter((s) => configGroupOf(s.id) === groupId);
  const title = configGroupLabel(groupId);

  // model.default picker is provider-aware: routing via OpenRouter needs
  // provider-prefixed ids, so the live tier list is mapped through OPENROUTER_IDS
  // (openai/* and unknown ids pass through). Direct Anthropic keeps ids as-is.
  const providerValue = allSections
    .find((s) => s.id === 'model')
    ?.leaves.find((l) => l.key === 'model.provider')?.value;
  const provider = typeof providerValue === 'string' ? providerValue : null;
  const rawModelIds = models.data && models.data.length ? models.data.map((m) => m.id) : MODEL_TIERS;
  const modelOptions = provider === 'openrouter' ? rawModelIds.map((id) => OPENROUTER_IDS[id] ?? id) : rawModelIds;
  const modelHint = provider === 'openrouter' ? OPENROUTER_HINT : null;

  function stage(leaf: ConfigFullLeaf, value: string, current: string) {
    setPending((prev) => stagePending(leaf, value, current, prev));
  }

  function toggleRow(key: string) {
    setOpenKey((k) => (k === key ? null : key));
  }

  function cancelPending() {
    setPending(null);
    setOpenKey(null);
  }

  async function applyPending() {
    if (!pending) return;
    setApplying(true);
    try {
      const res = await api.applyWrite({ action: 'config.set', key: pending.configKey, value: pending.value });
      if (res.status === 'applied') {
        setToast({ kind: 'ok', text: `${pending.label} set to ${pending.display}` });
        setPending(null);
        setOpenKey(null);
        await qc.invalidateQueries({ queryKey: ['config-full'] });
      } else {
        setToast({ kind: 'err', text: rejectedMessage(res.stderr, res.code) });
      }
    } catch (err) {
      setToast({ kind: 'err', text: writeErrorMessage(err) });
    } finally {
      setApplying(false);
    }
  }

  const blocks = buildBlocks(groupId, groupSections, allSections);
  const totalRows = blocks.reduce((n, b) => n + blockRowCount(b), 0);
  const hasStructural = blocks.some((b) => b.structural.length > 0);
  // A single-section group is already named by the page title — skip the sub-header.
  const showSubHeaders = blocks.length > 1;

  function renderLeafRow(leaf: ConfigFullLeaf, rowTitle: string, isLast: boolean) {
    if (leafRowKind(leaf) === 'sensitive') {
      return <SensitiveLeafRow key={leaf.key} leaf={leaf} title={rowTitle} isLast={isLast} />;
    }
    const control = controlForLeaf(leaf, modelOptions);
    const staged = pending?.configKey === leaf.key ? pending.value : null;
    const current = leafControlValue(leaf);
    return (
      <ScalarLeafRow
        key={leaf.key}
        leaf={leaf}
        title={rowTitle}
        help={CONFIG_HELP[leaf.key]}
        hint={leaf.key === 'model.default' ? modelHint : null}
        control={control}
        isLast={isLast}
        open={openKey === leaf.key}
        staged={staged}
        onToggle={() => toggleRow(leaf.key)}
        onStage={(value) => stage(leaf, value, current)}
      />
    );
  }

  function renderBlock(block: Block) {
    const rows = blockRowCount(block);
    let row = 0;
    const nextIsLast = () => ++row === rows;
    return (
      <View key={block.id}>
        {showSubHeaders ? <SectionHead label={block.label} count={`${rows}`} /> : null}
        <View>
          {block.top.map((leaf) =>
            renderLeafRow(leaf, relPath(block.sectionId, leaf.key) || leaf.label, nextIsLast()),
          )}
          {block.nested.map((bucket) => (
            <View key={bucket.seg}>
              <SubHead text={`${block.sectionId} › ${bucket.seg}`} />
              {bucket.leaves.map((leaf) =>
                renderLeafRow(leaf, relPath(block.sectionId, leaf.key).split('.').slice(1).join('.'), nextIsLast()),
              )}
            </View>
          ))}
          {block.structural.map((group) => (
            <StructuralGroupRow key={`grp-${block.id}-${group.name}`} group={group} isLast={nextIsLast()} />
          ))}
          {block.summaries.map((s) => (
            <SummaryLinkRow key={s.id} row={s} isLast={nextIsLast()} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <>
      <Screen
        contentStyle={barClearance}
        header={
          <>
            <BackLink />
            <PageTitle right={<RefreshControl queries={config} />}>{title}</PageTitle>
          </>
        }
      >
        {config.isLoading ? (
          <StatePanel tone="pending" title="Reading config…" detail="config file" />
        ) : config.isError ? (
          <StatePanel
            tone="error"
            title="Config unavailable"
            detail={config.error?.message || 'the configuration service is unreachable'}
          />
        ) : blocks.length === 0 ? (
          <StatePanel title="Nothing here" detail={`No config settings are grouped under "${groupId}" right now.`} />
        ) : totalRows === 0 ? (
          <StatePanel title="No settings" detail="This group has no leaves to render." />
        ) : (
          <View>{blocks.map(renderBlock)}</View>
        )}

        {hasStructural ? (
          <Text style={[styles.footnote, { color: t('fg-4') }]}>
            {STRUCTURAL_FOOTNOTE}
          </Text>
        ) : null}
      </Screen>
      {pending ? (
        <ReviewBar pending={pending} applying={applying} onApply={applyPending} onCancel={cancelPending} />
      ) : null}
      {toast ? (
        <Toast kind={toast.kind} text={toast.text} variant="config" onDone={() => setToast(null)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  pillLabel: { fontFamily: fonts.mono(500), fontSize: 12 },
  pillLabelOn: { fontFamily: fonts.mono(600), fontSize: 12 },
  pillWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingTop: 11 },
  switchHit: { minHeight: 44, justifyContent: 'center', flexShrink: 0 },
  switchTrack: { width: 46, height: 28, borderRadius: 14, borderWidth: 1, justifyContent: 'center', paddingLeft: 2 },
  switchKnob: { width: 22, height: 22, borderRadius: 11 },
  boolRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 11 },
  boolLabel: { fontFamily: fonts.sans(400), fontSize: 12.5 },
  input: {
    width: '100%',
    marginTop: 11,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 11,
    fontFamily: fonts.mono(400),
    fontSize: 16,
  },
  leafRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingVertical: 13 },
  leafRowLeft: { flex: 1, minWidth: 0 },
  leafRowRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0, maxWidth: '45%' },
  leafTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  tierDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  leafTitle: { fontFamily: fonts.sans(500), fontSize: 14, flexShrink: 1 },
  leafDesc: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 16.8, marginTop: 2 },
  leafValue: { fontFamily: fonts.mono(400), fontSize: 12, textAlign: 'right', flexShrink: 1, ...MONO_FEATURES },
  leafValueChanged: { fontFamily: fonts.mono(600), fontSize: 12, textAlign: 'right', flexShrink: 1, ...MONO_FEATURES },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  leafBody: { paddingBottom: 14 },
  leafHint: { fontFamily: fonts.sans(400), fontSize: 11, marginTop: 9 },
  leafHelp: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16.7, marginTop: 9 },
  leafWas: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 9 },
  sensitiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 13,
  },
  sensitiveTitle: { fontFamily: fonts.sans(500), fontSize: 14, flexShrink: 0, minWidth: 0 },
  sensitiveRight: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  structRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 13,
  },
  structLeft: { minWidth: 0, flexShrink: 1 },
  structName: { fontFamily: fonts.sans(500), fontSize: 14 },
  structPeek: { fontFamily: fonts.mono(400), fontSize: 11.5, marginTop: 2 },
  structCount: { flexShrink: 0, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  structCountLabel: { fontFamily: fonts.mono(400), fontSize: 11 },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 13,
  },
  summaryNote: { fontFamily: fonts.sans(400), fontSize: 11.5, marginTop: 2 },
  subHead: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingTop: 12,
    paddingBottom: 5,
    paddingLeft: 2,
  },
  barHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 11 },
  barHeadText: { flex: 1, minWidth: 0 },
  barEyebrow: { fontFamily: fonts.sans(400), fontSize: 11 },
  barLine: { fontFamily: fonts.sans(550), fontSize: 13 },
  barValue: { fontFamily: fonts.mono(400), fontSize: 13 },
  barNote: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16.7, marginTop: 4 },
  footnote: { fontFamily: fonts.sans(400), fontSize: 11, marginTop: 10, paddingHorizontal: 1 },
});
