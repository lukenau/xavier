// The iMessage draft approval card pinned at the bottom of a thread — one
// draft the Mac's iMessage MCP holds, waiting on Send or Discard.
//
// Same shape and same Face-ID gate as ApprovalCard.tsx (challenge → assertion
// → apply, ApplyError | GateNotWiredError branching on `.code`, a `cancelled`
// tap swallowed rather than toasted), because a draft is answered through the
// SAME `/api/chat/approval/*` routes — chat/drafts.ts explains why. The only
// differences are what it shows (recipient, message body — not the tool-call
// summary) and the words on the two buttons.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApplyError, GateNotWiredError, api } from '../../../lib/api';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { useChatStore } from '../../../chat/store';
import type { ApprovalChoice, PendingApprovalView } from '../../../chat/types';
import { PRESSED_OPACITY, Toast } from '../../shell';
import type { ToastKind } from '../../shell';

/** iMessage send/discard reads better than the generic approval wording; a
 * choice the server did not offer for this decision never appears on the card
 * at all (`selectPendingApprovals` falls back to once/deny only). */
const DRAFT_CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: 'Send',
  session: 'Send this session',
  always: 'Always send',
  deny: 'Discard',
};

/** Ported from ApprovalCard.tsx's `approvalErrorMessage` — same union, same
 * codes, same "cancelled reads as nothing happened" rule. */
function draftErrorMessage(err: unknown): string {
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

/** Whole seconds left, or null with no expiry — see ApprovalCard's own copy.
 * Drafts expire ~15 minutes after the Mac creates them, so this is the one
 * countdown that is usually present. */
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

export function DraftApprovalCard({ approval }: { approval: PendingApprovalView }) {
  const { t } = useTheme();
  const applyFrame = useChatStore((s) => s.applyFrame);
  const [applying, setApplying] = useState<ApprovalChoice | null>(null);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
  const seconds = useCountdown(approval.expires_at_derived);
  // Same latch as ApprovalCard: set before anything can yield, so two presses
  // in one batch cannot start two Face ID prompts on one request_id.
  const inFlight = useRef(false);

  // What to send, best-effort: the tool call's own args when they carried a
  // body, otherwise the attention row's summary. The recipient is shown only
  // when the args actually named one — never invented.
  const to = approval.draft?.to ?? null;
  const body = approval.draft?.text ?? approval.summary;
  const draftId = approval.draft?.draft_id ?? null;

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
      setToast({ kind: 'err', text: draftErrorMessage(err) });
    } finally {
      inFlight.current = false;
      setApplying(null);
    }
  }

  return (
    <>
      <View style={[styles.card, { backgroundColor: t('status-warn-soft'), borderColor: t('status-warn-border') }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.eyebrow, { color: t('status-warn') }]}>imessage draft</Text>
          {seconds !== null ? (
            <Text style={[styles.countdown, { color: t('status-warn') }, MONO_FEATURES]}>
              {seconds > 0 ? `${seconds}s` : 'expiring'}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.to, { color: t('fg-2') }, MONO_FEATURES]} numberOfLines={1}>
          {to ? `To ${to}` : 'Recipient not named'}
        </Text>
        <Text style={[styles.body, { color: t('fg-1') }]} numberOfLines={5}>
          {body}
        </Text>
        {draftId !== null ? (
          <Text style={[styles.meta, { color: t('fg-3') }, MONO_FEATURES]}>{`draft #${draftId}`}</Text>
        ) : null}
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
                {applying === choice ? 'Waiting for Face ID…' : DRAFT_CHOICE_LABEL[choice]}
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
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontFamily: fonts.mono(550), fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  countdown: { fontFamily: fonts.mono(600), fontSize: 11 },
  to: { fontFamily: fonts.mono(500), fontSize: 11, letterSpacing: 0.2 },
  body: { fontFamily: fonts.sans(500), fontSize: 13, lineHeight: 18.5 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  choice: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
  choiceLabel: { fontFamily: fonts.sans(600), fontSize: 12.5 },
});
