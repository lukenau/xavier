// Runs the finance-snapshot pipeline (Copilot + Plaid → snapshot.json) through the
// standard gated cron.run write path, then refetches the page. The bridge exec can
// time out at 30s while the run is still finishing, so an apply failure falls back
// to polling until the snapshot's asof advances before it's called a real failure.
// 1:1 port of apps/hub/src/components/finance/SyncButton.tsx.
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApplyError, GateNotWiredError } from '../../lib/api';
import { GateError } from '../../lib/gate';
import type { FinanceSnapshot } from '../../lib/types';
import { isCancelledGateError } from '../config/writeErrors';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { useSpinRotation } from '../shell';

const POLL_MS = 5_000;
const POLL_TRIES = 18;

type Phase = 'idle' | 'syncing' | 'failed';

/**
 * The PWA splits its catch on the error's CLASS: a `WebAuthnError` means the
 * gate refused, nothing was dispatched, and the button goes quietly back to
 * idle; an `ApplyError` means an HTTP leg failed and the job may still be
 * running, so it polls. Natively `GateError extends ApplyError` (deliberately —
 * it keeps the config pages' error matrix working), so the class test has to
 * name the subclass: every gate failure gate.ts raises — a cancel, a face that
 * did not match (`assertion_invalid`), an unpaired key, a lockout, biometrics
 * not enrolled (all `unknown`) — is a GateError thrown at the signing step,
 * BEFORE the apply POST, so nothing was dispatched and there is nothing to
 * poll for. `isCancelledGateError` is the config pages' own refusal test
 * (writeErrors.ts), shared rather than re-implemented here.
 */
function gateRefused(err: unknown): boolean {
  return err instanceof GateError || err instanceof GateNotWiredError || isCancelledGateError(err);
}

export function SyncButton() {
  const { t } = useTheme();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  const rotate = useSpinRotation();

  async function asofAdvanced(prev: string | undefined): Promise<boolean> {
    for (let i = 0; i < POLL_TRIES; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      await qc.refetchQueries({ queryKey: ['finance'] });
      const snap = qc.getQueryData<FinanceSnapshot | null>(['finance']);
      if (snap?.asof && snap.asof !== prev) return true;
    }
    return false;
  }

  async function sync() {
    if (phase === 'syncing') return;
    setPhase('syncing');
    const prevAsof = qc.getQueryData<FinanceSnapshot | null>(['finance'])?.asof;
    try {
      const job = (await api.cron()).jobs.find((j) => j.name === 'finance-snapshot');
      if (!job) {
        setPhase('failed');
        return;
      }
      try {
        await api.applyWrite({ action: 'cron.run', job_id: job.id });
      } catch (err) {
        if (gateRefused(err)) {
          setPhase('idle');
          return;
        }
        if (!(err instanceof ApplyError) || !(await asofAdvanced(prevAsof))) {
          setPhase('failed');
          return;
        }
        setPhase('idle');
        return;
      }
      await qc.refetchQueries({ queryKey: ['finance'] });
      setPhase('idle');
    } catch {
      setPhase('failed');
    }
  }

  const failed = phase === 'failed';
  const syncing = phase === 'syncing';
  const ink = t(failed ? 'status-warn' : 'accent');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sync accounts now"
      accessibilityState={{ disabled: syncing }}
      onPress={sync}
      disabled={syncing}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
    >
      <View
        style={[
          styles.pill,
          {
            backgroundColor: failed ? 'transparent' : t('accent-soft'),
            borderColor: t(failed ? 'status-warn' : 'accent-border'),
            opacity: syncing ? 0.75 : 1,
          },
        ]}
      >
        <Animated.View style={syncing ? { transform: [{ rotate }] } : null}>
          <SymbolView
            name={syncing ? 'arrow.clockwise' : 'bolt'}
            size={12}
            tintColor={ink}
            weight="regular"
          />
        </Animated.View>
        <Text style={[styles.label, { color: ink }]}>
          {failed ? 'Failed — retry' : syncing ? 'Syncing…' : 'Sync'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  pill: {
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
  },
  label: { fontFamily: fonts.sans(600), fontSize: 12 },
  pressed: { opacity: 0.7 },
});
