// The one write action on Home (OuraSyncButton.tsx:9-88): run the `oura-sync`
// cron job through the gated `cron.run` path. The job's wrapper regenerates
// /oura/ itself, so there is nothing to refetch here — and the bridge exec can
// time out at 30s while the sync is still finishing, which is a soft outcome
// ("Still running"), not a failure.
//
// One native-only branch: until Task 21 wires the Secure Enclave gate,
// api.applyWrite rejects with GateNotWiredError before any request is sent.
// The PWA's matching case (WebAuthnError) returns to idle SILENTLY, which
// here would be a tap that does nothing and says nothing — so the reason is
// handed up to Home, which shows it in a toast. Nothing else about the phase
// machine changes.
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { api, ApplyError, GateNotWiredError } from '../../lib/api';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { useSpin } from './pulse';

export type SyncPhase = 'idle' | 'syncing' | 'slow' | 'done' | 'failed';

/** Every settled phase falls back to idle after 5s (OuraSyncButton.tsx:14-17). */
export const SETTLE_MS = 5000;
/** Tailwind `animate-spin`: one linear turn per second. */
const SPIN_MS = 1000;

export function syncLabel(phase: SyncPhase): string {
  return phase === 'syncing'
    ? 'Syncing…'
    : phase === 'slow'
      ? 'Still running'
      : phase === 'done'
        ? 'Synced'
        : phase === 'failed'
          ? 'Failed — retry'
          : 'Sync';
}

export function OuraSyncButton({ onGateError }: { onGateError?: (message: string) => void }) {
  const { t } = useTheme();
  const [phase, setPhase] = useState<SyncPhase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spin = useSpin(phase === 'syncing', SPIN_MS);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function settle(p: SyncPhase) {
    setPhase(p);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase('idle'), SETTLE_MS);
  }

  async function sync() {
    if (phase === 'syncing') return;
    setPhase('syncing');
    try {
      const job = (await api.cron()).jobs.find((j) => j.name === 'oura-sync');
      if (!job) {
        settle('failed');
        return;
      }
      await api.applyWrite({ action: 'cron.run', job_id: job.id });
      settle('done');
    } catch (err) {
      if (err instanceof GateNotWiredError) {
        // The PWA's WebAuthnError branch: a cancelled gate is silent.
        if (err.code === 'cancelled') setPhase('idle');
        else {
          settle('failed');
          onGateError?.(err.message);
        }
      } else if (err instanceof ApplyError) settle('slow');
      else settle('failed');
    }
  }

  const failed = phase === 'failed';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sync Oura data now"
      accessibilityState={{ disabled: phase === 'syncing' }}
      disabled={phase === 'syncing'}
      onPress={() => {
        void sync();
      }}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
    >
      <View
        style={[
          styles.pill,
          {
            backgroundColor: failed ? 'transparent' : t('accent-soft'),
            borderColor: failed ? t('status-warn') : t('accent-border'),
          },
          phase === 'syncing' ? styles.busy : null,
        ]}
      >
        <Animated.View style={phase === 'syncing' ? { transform: [{ rotate: spin }] } : null}>
          <SymbolView
            name={phase === 'syncing' ? 'arrow.clockwise' : 'bolt'}
            size={12}
            tintColor={failed ? t('status-warn') : t('accent')}
            weight="regular"
          />
        </Animated.View>
        <Text style={[styles.label, { color: failed ? t('status-warn') : t('accent') }]}>
          {syncLabel(phase)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: { minHeight: 44, justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  pill: {
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
  },
  busy: { opacity: 0.75 },
  label: { fontFamily: fonts.sans(600), fontSize: 12 },
});
