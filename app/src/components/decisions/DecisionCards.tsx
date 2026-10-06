// Shared Decision Inbox pieces, ported from
// apps/hub/src/components/decisions/DecisionCards.tsx (docs/inventory/feed.md
// §2). One implementation for every surface that renders cards — the Decisions
// screen today, the Money sections when those tasks land.
//
// Cards answer through the Face-ID gate (challenge bound to
// {id, option_key, note} → assertion → apply); answers land in the card file
// AND the append-only responses.jsonl.
//
// Stakes grouping: the queue writer stamps `category` on every card; groups
// render in stakes order with plain-words headers — the raw category token
// never reaches the screen.
import { Fragment, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { api, ApplyError, GateNotWiredError, HUB_ORIGIN } from '../../lib/api';
import type { Decision, DecisionOption } from '../../lib/types';
import { relTime } from '../../shared/time';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { openBrief, resolveBriefUri } from '../briefs';
import { PRESSED_OPACITY } from '../shell';
import type { ToastKind } from '../shell';

export const STAKES_GROUPS: { key: string; label: string; defaultOpen: boolean }[] = [
  { key: 'required', label: 'Needs your answer', defaultOpen: true },
  { key: 'tradeoff', label: 'Your call — nothing waits', defaultOpen: false },
  { key: 'info', label: 'For later — just FYI', defaultOpen: false },
  { key: 'frozen', label: 'Frozen — on your instruction', defaultOpen: false },
];

/** Missing/unknown category folds into "Needs your answer" — never under-alert.
 * (components/home/homeState.ts carries its own narrowed copy for the Home
 * banner's counters; this is the PWA's original home for the rule.) */
export function stakesOf(d: Decision): string {
  return STAKES_GROUPS.some((g) => g.key === d.category) ? (d.category as string) : 'required';
}

/** DecisionCards.tsx:31-47. The PWA branches on `ApplyError | WebAuthnError`;
 * natively the second half of that union is `GateNotWiredError` (api.ts),
 * which carries the same `code`, so the switch ports unchanged. Until Task 21
 * wires the Secure Enclave signer a real answer reaches `default:` with
 * GateNotWiredError's own message — the honest surface for "the gate is not
 * built yet", never a faked success. */
export function decisionErrorMessage(err: unknown): string {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) {
    switch (err.code) {
      case 'cancelled':
        return 'Face ID cancelled.';
      case 'no_passkey':
        return 'No passkey enrolled. Enrol Face ID in Security first.';
      case 'challenge_expired':
        return 'That took too long — tap again.';
      case 'assertion_invalid':
        return 'Face ID did not verify.';
      default:
        return err.message || 'Answer failed.';
    }
  }
  return err instanceof Error ? err.message : 'Answer failed.';
}

/**
 * Where `evidence →` (DecisionCards.tsx:187-195) goes. The PWA's anchor has no
 * `target`, so it navigates the whole SPA away — usually to a `/my-pages/…`
 * page of agent HTML (DECISION-INBOX.md:22 "same-tab"). A native screen has no
 * "navigate the app away", so the destination decides the surface: agent HTML
 * on the hub host opens in the brief reader (the component built to render it
 * safely), anything else opens in the system browser. Anything that is not an
 * http(s) URL at all opens nothing, as it would in the PWA's `safeHref`-guarded
 * siblings.
 */
export function evidenceTarget(
  url: string | null | undefined,
  origin: string = HUB_ORIGIN,
): { kind: 'brief' | 'external'; uri: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const isAgentPage = parsed.origin === origin && parsed.pathname.startsWith('/my-pages/');
    return { kind: isAgentPage ? 'brief' : 'external', uri: parsed.toString() };
  } catch {
    return null;
  }
}

function openEvidence(url: string, title: string) {
  const target = evidenceTarget(url);
  if (!target) return;
  if (target.kind === 'brief') {
    const uri = resolveBriefUri(target.uri);
    if (uri) openBrief(uri, title);
    return;
  }
  WebBrowser.openBrowserAsync(target.uri);
}

function OptionButton({
  option,
  busy,
  applying,
  onPick,
}: {
  option: DecisionOption;
  busy: boolean;
  applying: boolean;
  onPick: () => void;
}) {
  const { t } = useTheme();
  const rec = option.recommended === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={option.label}
      disabled={busy}
      onPress={onPick}
      style={({ pressed }) => [
        styles.option,
        {
          backgroundColor: t(rec ? 'accent-soft' : 'bg-2'),
          borderColor: t(rec ? 'accent-border' : 'border-strong'),
          opacity: busy && !applying ? 0.55 : 1,
        },
        pressed && !busy && { opacity: PRESSED_OPACITY },
      ]}
    >
      <View style={styles.optionLabelRow}>
        <Text style={[styles.optionLabel, { color: t(rec ? 'accent' : 'fg-1') }]}>
          {applying ? 'Waiting for Face ID…' : option.label}
        </Text>
        {rec && !applying ? (
          <Text style={[styles.recPill, { color: t('accent'), borderColor: t('accent-border') }]}>
            recommended
          </Text>
        ) : null}
      </View>
      {option.detail ? (
        <Text style={[styles.optionDetail, { color: t('fg-3') }]}>{option.detail}</Text>
      ) : null}
    </Pressable>
  );
}

export function DecisionCard({
  decision,
  busy,
  applyingKey,
  onAnswer,
}: {
  decision: Decision;
  busy: boolean;
  applyingKey: string | null;
  onAnswer: (optionKey: string | null, note: string | null) => void;
}) {
  const { t } = useTheme();
  const [note, setNote] = useState('');
  const [showContext, setShowContext] = useState(false);

  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border-strong') }]}>
      <View style={styles.metaRow}>
        <Text style={[styles.source, { color: t('fg-3') }]}>
          {decision.source}
          {decision.domain ? ` · ${decision.domain}` : ''}
        </Text>
        <Text style={[styles.created, { color: t('fg-4') }]}>
          {relTime(decision.created)}
          {/* Verbatim from DecisionCards.tsx:146: `new Date(expires)`, which
              reads an offset-less datetime as LOCAL — unlike shared/time.ts's
              toMs, which reads it as UTC. Reproduced, not reconciled. */}
          {decision.expires
            ? ` · expires ${new Date(decision.expires).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
            : ''}
        </Text>
      </View>

      <Text style={[styles.title, { color: t('fg-0') }]}>{decision.title}</Text>

      {/* Stakes sentence from the writer, verbatim — it says in words what
          waits (or that nothing does), so it is never badged or colored. */}
      {decision.blocking ? (
        <Text style={[styles.blocking, { color: t('fg-2'), borderLeftColor: t('border-strong') }]}>
          {decision.blocking}
        </Text>
      ) : null}

      <Text style={[styles.summary, { color: t('fg-2') }]}>{decision.summary}</Text>

      {decision.context_md ? (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowContext((v) => !v)}
            style={({ pressed }) => [styles.contextToggle, pressed && { opacity: PRESSED_OPACITY }]}
          >
            <Text style={[styles.contextToggleLabel, { color: t('fg-4') }]}>
              {showContext ? 'context ▾' : 'context ▸'}
            </Text>
          </Pressable>
          {showContext ? (
            // Plain pre-wrapped text, not Markdown, despite the field name
            // (DecisionCards.tsx:180-182 / PARITY-INVENTORY OQ-7).
            <Text style={[styles.context, { color: t('fg-3') }]}>{decision.context_md}</Text>
          ) : null}
        </>
      ) : null}

      {decision.evidence_url ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="evidence"
          onPress={() => openEvidence(decision.evidence_url as string, decision.title)}
          style={({ pressed }) => [styles.evidenceRow, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.evidence, { color: t('accent') }]}>evidence →</Text>
        </Pressable>
      ) : null}

      <View style={styles.options}>
        {/* options may be absent on a malformed/unwired decision file — degrade
            to a quiet note instead of crashing the Ops tab. */}
        {(decision.options ?? []).length > 0 ? (
          (decision.options ?? []).map((o) => (
            <OptionButton
              key={o.key}
              option={o}
              busy={busy}
              applying={applyingKey === o.key}
              onPick={() => onAnswer(o.key, note)}
            />
          ))
        ) : (
          <Text style={[styles.evidence, { color: t('fg-4') }]}>no options listed</Text>
        )}
      </View>

      <TextInput
        value={note}
        editable={!busy}
        onChangeText={setNote}
        placeholder="Add a note (optional)"
        placeholderTextColor={t('fg-4')}
        autoCapitalize="sentences"
        autoCorrect
        style={[
          styles.note,
          {
            backgroundColor: t('bg-0'),
            borderColor: t('border'),
            color: t('fg-1'),
            opacity: busy ? 0.6 : 1,
          },
        ]}
      />

      <View style={styles.footerRow}>
        {note.trim() ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Answer with note only"
            disabled={busy}
            onPress={() => onAnswer(null, note)}
            style={({ pressed }) => [pressed && { opacity: PRESSED_OPACITY }]}
          >
            <Text style={[styles.noteOnly, { color: t('accent'), opacity: busy ? 0.5 : 1 }]}>
              {applyingKey === '__note__' ? 'Waiting for Face ID…' : 'Answer with note only'}
            </Text>
          </Pressable>
        ) : (
          <View />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          disabled={busy}
          onPress={() => onAnswer('dismiss', note)}
          style={({ pressed }) => [pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.dismiss, { color: t('fg-4'), opacity: busy ? 0.5 : 1 }]}>
            {applyingKey === 'dismiss' ? 'Waiting for Face ID…' : 'Dismiss'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export interface ApplyingState {
  id: string;
  key: string;
}

/** The Face-ID answer flow, shared by every surface that renders cards. An
 * iMessage-draft card (`draft_id`) goes through it like any other: approving
 * one sends a message, so it needs the same proof, never a bare tap. */
export function useDecisionAnswers() {
  const qc = useQueryClient();
  const [applying, setApplying] = useState<ApplyingState | null>(null);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);

  async function answer(decision: Decision, optionKey: string | null, note: string | null) {
    if (applying) return;
    setApplying({ id: decision.id, key: optionKey ?? '__note__' });
    try {
      const res = await api.answerDecision(decision.id, optionKey, note);
      await qc.invalidateQueries({ queryKey: ['decisions'] });
      setToast({
        kind: 'ok',
        text:
          res.status === 'dismissed'
            ? 'Dismissed — ledgered, nothing deleted.'
            : 'Answered — logged to the response ledger.',
      });
    } catch (err) {
      if ((err instanceof ApplyError || err instanceof GateNotWiredError) && err.code === 'cancelled') {
        setApplying(null);
        return;
      }
      setToast({ kind: 'err', text: decisionErrorMessage(err) });
    } finally {
      setApplying(null);
    }
  }

  return { applying, toast, clearToast: () => setToast(null), answer };
}

function GroupHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={({ pressed }) => [styles.groupHeader, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <Text style={[styles.groupLabel, { color: t('fg-3') }]}>{label}</Text>
      <Text style={[styles.groupCount, { color: t('fg-4') }]}>
        {count} {open ? '▾' : '▸'}
      </Text>
    </Pressable>
  );
}

/** Open cards grouped by stakes, in stakes order. "Needs your answer" starts
 * expanded; lower-stakes groups start as header + count. */
export function DecisionGroups({
  decisions,
  applying,
  onAnswer,
}: {
  decisions: Decision[];
  applying: ApplyingState | null;
  onAnswer: (decision: Decision, optionKey: string | null, note: string | null) => void;
}) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(STAKES_GROUPS.map((g) => [g.key, g.defaultOpen])),
  );
  const busy = applying !== null;
  return (
    <>
      {STAKES_GROUPS.map((g) => {
        const cards = decisions.filter((d) => stakesOf(d) === g.key);
        if (cards.length === 0) return null;
        const open = openGroups[g.key];
        return (
          <Fragment key={g.key}>
            <GroupHeader
              label={g.label}
              count={cards.length}
              open={open}
              onToggle={() => setOpenGroups((s) => ({ ...s, [g.key]: !s[g.key] }))}
            />
            {open &&
              cards.map((d) => (
                <DecisionCard
                  key={d.id}
                  decision={d}
                  busy={busy}
                  applyingKey={applying?.id === d.id ? applying.key : null}
                  onAnswer={(optionKey, note) => onAnswer(d, optionKey, note)}
                />
              ))}
          </Fragment>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 6,
  },
  source: {
    flexShrink: 1,
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  created: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10 },
  title: { fontFamily: fonts.sans(580), fontSize: 15, lineHeight: 20.25 },
  blocking: {
    marginTop: 4,
    paddingLeft: 9,
    borderLeftWidth: 2,
    fontFamily: fonts.sans(400),
    fontSize: 11.5,
    lineHeight: 17.25,
  },
  summary: { marginTop: 4, fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18.75 },
  contextToggle: { marginTop: 7, alignSelf: 'flex-start', minHeight: 22, justifyContent: 'center' },
  contextToggleLabel: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  context: { marginTop: 5, fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 17.8 },
  evidenceRow: { marginTop: 7, alignSelf: 'flex-start', minHeight: 22, justifyContent: 'center' },
  evidence: { fontFamily: fonts.mono(400), fontSize: 11 },
  options: { marginTop: 11, gap: 8 },
  option: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 10 },
  optionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionLabel: { flexShrink: 1, fontFamily: fonts.sans(600), fontSize: 13.5 },
  recPill: {
    flexShrink: 0,
    fontFamily: fonts.sans(600),
    fontSize: 9.5,
    letterSpacing: 0.76,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    overflow: 'hidden',
  },
  optionDetail: { marginTop: 2, fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16.7 },
  note: {
    marginTop: 9,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontFamily: fonts.sans(400),
    fontSize: 13,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 9,
    minHeight: 22,
  },
  noteOnly: { fontFamily: fonts.sans(550), fontSize: 12 },
  dismiss: { fontFamily: fonts.sans(400), fontSize: 12 },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 8,
    paddingBottom: 12,
    paddingHorizontal: 4,
  },
  groupLabel: {
    flexShrink: 1,
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  groupCount: {
    flexShrink: 0,
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
});
