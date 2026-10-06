// Ops.tsx:50-125 — pending pairing approvals, the only thing on this page that
// actually blocks someone. `pairing.approve` goes through the same gated write
// as every other action here.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { SectionHead, StatePanel } from '../shell';
import { OpsCard, OPS_PRESSED } from './parts';
import { writeErrorMessage } from './opsFormat';
import { api } from '../../lib/api';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { draftRows } from '../../chat/drafts';
import { expiryLabel } from '../chat/AttentionInbox';
import type { ChatAttentionResponse } from '../../chat/types';
import type { PairingReport } from '../../lib/types';

export function NeedsYou({
  q,
  attention,
}: {
  q: UseQueryResult<PairingReport, Error>;
  /** The cross-thread attention read (`GET /chat/attention`) — the drafts half
   * of "needs you". Optional so a caller that has not wired it renders pairing
   * approvals exactly as before. */
  attention?: UseQueryResult<ChatAttentionResponse, Error>;
}) {
  const { t } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve(platform: string, code: string) {
    if (busy) return;
    setBusy(code);
    setError(null);
    try {
      await api.applyWrite({ action: 'pairing.approve', platform, code });
      await q.refetch();
    } catch (err) {
      const msg = writeErrorMessage(err);
      if (msg) setError(msg);
    } finally {
      setBusy(null);
    }
  }

  const pending = q.data?.pending ?? [];
  const drafts = draftRows(attention?.data?.attention ?? []);
  const nothing = q.data != null && pending.length === 0 && drafts.length === 0;

  return (
    <View style={styles.section}>
      <SectionHead label="Needs you" count={q.data && q.data.pending_count > 0 ? `${q.data.pending_count}` : ''} />
      {q.isLoading ? (
        <StatePanel tone="pending" title="Checking pairings…" detail="pairing requests" />
      ) : null}
      {q.isError ? <StatePanel tone="error" title="Pairing unavailable" detail={q.error?.message ?? ''} /> : null}
      {nothing ? <Text style={[styles.empty, { color: t('fg-3') }]}>Nothing needs you.</Text> : null}
      {q.data && pending.length > 0 ? (
        <OpsCard>
          {pending.map((p, i) => (
            <View
              key={`${p.platform}-${p.code}`}
              style={[
                styles.row,
                i === pending.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
              ]}
            >
              <View style={styles.rowText}>
                <View style={styles.codeLine}>
                  <Text style={[styles.platform, { color: t('fg-4') }]}>{p.platform}</Text>
                  <Text style={[styles.code, { color: t('fg-0') }]} numberOfLines={1} ellipsizeMode="tail">
                    {p.code}
                  </Text>
                </View>
                <Text style={[styles.who, { color: t('fg-3') }]} numberOfLines={1} ellipsizeMode="tail">
                  {(p.user_name ?? p.user_id) + (p.age ? ` · ${p.age}` : '')}
                </Text>
              </View>
              <Pressable
                onPress={() => approve(p.platform, p.code)}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy !== null }}
                style={({ pressed }) => [
                  styles.approve,
                  { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
                  busy === p.code ? styles.approveBusy : null,
                  pressed && { opacity: OPS_PRESSED },
                ]}
              >
                <Text style={[styles.approveLabel, { color: t('accent') }]}>
                  {busy === p.code ? 'Approving…' : 'Approve'}
                </Text>
              </Pressable>
            </View>
          ))}
          {error ? <Text style={[styles.error, { color: t('status-down') }]}>{error}</Text> : null}
        </OpsCard>
      ) : null}
      {drafts.length > 0 ? (
        <OpsCard>
          {drafts.map((d, i) => {
            const expiry = expiryLabel(d.expires_at_derived);
            return (
              <Pressable
                key={d.id}
                accessibilityRole="button"
                accessibilityLabel={`iMessage draft in ${d.thread_title?.trim() || d.thread_kind}`}
                onPress={() => router.push({ pathname: '/chat/thread', params: { threadId: d.thread_id } })}
                style={({ pressed }) => [
                  styles.row,
                  i === drafts.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
                  pressed && { opacity: OPS_PRESSED },
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={[styles.platform, { color: t('fg-4') }]}>iMessage draft</Text>
                  <Text style={[styles.draftSummary, { color: t('fg-0') }]} numberOfLines={2}>
                    {d.summary}
                  </Text>
                  {expiry ? <Text style={[styles.who, { color: t('fg-3') }]}>{expiry}</Text> : null}
                </View>
                <Text style={[styles.review, { color: t('accent') }]}>Review</Text>
              </Pressable>
            );
          })}
        </OpsCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  empty: { fontFamily: fonts.sans(400), fontSize: 12.5, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rowText: { flex: 1, minWidth: 0 },
  codeLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  platform: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', flexShrink: 0 },
  code: { fontFamily: fonts.mono(550), fontSize: 13, flexShrink: 1 },
  who: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  draftSummary: { fontFamily: fonts.sans(500), fontSize: 13, lineHeight: 17 },
  review: { flexShrink: 0, fontFamily: fonts.sans(600), fontSize: 13 },
  approve: { flexShrink: 0, minHeight: 44, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, justifyContent: 'center' },
  approveBusy: { opacity: 0.6 },
  approveLabel: { fontFamily: fonts.sans(600), fontSize: 13 },
  error: { fontFamily: fonts.sans(400), fontSize: 12, paddingTop: 8 },
});
