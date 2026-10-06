// The approval card pinned at the bottom of a thread — one open decision,
// rendered with EXACTLY the choices its own frame carries
// (selectPendingApprovals in chat/store.ts already falls back to
// once/deny, matching chat/approval.py's own `_DEFAULT_OFFERED_CHOICES`
// fallback, so this component never invents a choice the apply call could
// then 400 on) plus a countdown to `expires_at_derived`.
//
// Answers through the SAME Face-ID gate shape as DecisionCards.tsx's
// `useDecisionAnswers`/`decisionErrorMessage`: challenge -> assertion ->
// apply, ApplyError | GateNotWiredError branching on `.code`, a `cancelled`
// tap swallowed rather than toasted.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApplyError, GateNotWiredError, api } from '../../../lib/api';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { useChatStore } from '../../../chat/store';
import type { ApprovalChoice, PendingApprovalView } from '../../../chat/types';
import { PRESSED_OPACITY, Toast } from '../../shell';
import type { ToastKind } from '../../shell';

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: 'Approve once',
  session: 'Approve for this session',
  always: 'Always approve',
  deny: 'Deny',
};

/** Ported verbatim from DecisionCards.tsx's `decisionErrorMessage` — same
 * union, same codes, same "cancelled reads as nothing happened" rule. */
function approvalErrorMessage(err: unknown): string {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) {
    switch (err.code) {
      case 'cancelled':
        return 'Face ID cancelled.';
      case 'no_passkey':
        return 'This iPhone is not paired. Pair it in Config › Security first.';
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

/** Whole seconds left, or null once there's no expiry (or it already
 * passed — the card still renders, just with no countdown text; the choices
 * themselves stay whatever the frame offered until a new frame says
 * otherwise). Ticks once a second, matching ReasoningPart/ToolCallPart's
 * own live-timer idiom. */
function useCountdown(expiresAtDerived: string | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAtDerived) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAtDerived]);
  if (!expiresAtDerived) return null;
  const target = Date.parse(expiresAtDerived);
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.round((target - now) / 1000));
}

export function ApprovalCard({ approval }: { approval: PendingApprovalView }) {
  const { t } = useTheme();
  const applyFrame = useChatStore((s) => s.applyFrame);
  const [applying, setApplying] = useState<ApprovalChoice | null>(null);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
  const seconds = useCountdown(approval.expires_at_derived);
  // `applying` is read through the render closure, so two presses in one batch
  // both passed it: two challenges, two Face ID prompts, two applies on one
  // request_id. The ref is set before anything can yield.
  const inFlight = useRef(false);

  async function answer(choice: ApprovalChoice) {
    if (inFlight.current) return;
    inFlight.current = true;
    setApplying(choice);
    try {
      const res = await api.chatApprovalApply([
        { run_id: approval.run_id, request_id: approval.request_id, choice },
      ]);
      const decision = res.decisions[0];
      applyFrame({
        type: 'approval.answered',
        thread_id: approval.thread_id,
        run_id: approval.run_id,
        request_id: approval.request_id,
        choice: decision?.choice ?? choice,
      });
    } catch (err) {
      if ((err instanceof ApplyError || err instanceof GateNotWiredError) && err.code === 'cancelled') {
        setApplying(null);
        return;
      }
      setToast({ kind: 'err', text: approvalErrorMessage(err) });
    } finally {
      inFlight.current = false;
      setApplying(null);
    }
  }

  return (
    <>
      <View style={[styles.card, { backgroundColor: t('status-warn-soft'), borderColor: t('status-warn-border') }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.eyebrow, { color: t('status-warn') }]}>needs your approval</Text>
          {seconds !== null ? (
            <Text style={[styles.countdown, { color: t('status-warn') }, MONO_FEATURES]}>
              {seconds > 0 ? `${seconds}s` : 'expiring'}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.summary, { color: t('fg-1') }]}>{approval.summary}</Text>
        <View style={styles.choices}>
          {approval.choices.map((choice) => (
            <Pressable
              key={choice}
              accessibilityRole="button"
              disabled={applying !== null}
              onPress={() => void answer(choice)}
              style={({ pressed }) => [
                styles.choice,
                {
                  backgroundColor: choice === 'deny' ? t('bg-1') : t('accent-soft'),
                  borderColor: choice === 'deny' ? t('border-strong') : t('accent-border'),
                  opacity: applying !== null && applying !== choice ? 0.5 : 1,
                },
                pressed && applying === null && { opacity: PRESSED_OPACITY },
              ]}
            >
              <Text style={[styles.choiceLabel, { color: choice === 'deny' ? t('fg-2') : t('accent') }]}>
                {applying === choice ? 'Waiting for Face ID…' : CHOICE_LABEL[choice]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {toast ? <Toast kind={toast.kind} text={toast.text} onDone={() => setToast(null)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontFamily: fonts.mono(550), fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  countdown: { fontFamily: fonts.mono(600), fontSize: 11 },
  summary: { fontFamily: fonts.sans(500), fontSize: 13, lineHeight: 18.5 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
  choiceLabel: { fontFamily: fonts.sans(600), fontSize: 12.5 },
});
