// ConfigHome.tsx:30-77,187-218 — the "Restart / Drain the gateway?"
// confirm sheet, as its own route (natively a sheet IS a route, task-8
// report §Sheets).
//
// The PWA resets phase/error when the sheet closes; here the route unmounts,
// which does the same thing for free.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { closeSheet, PRESSED_OPACITY, SheetScreen } from '../shell';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { isCancelledGateError } from './writeErrors';

export type GatewayAction = 'restart' | 'drain';

export const GATEWAY: Record<GatewayAction, { action: 'gateway.restart' | 'gateway.drain'; title: string; confirm: string }> =
  {
    restart: { action: 'gateway.restart', title: 'Restart the gateway?', confirm: 'Restart · Face ID' },
    drain: { action: 'gateway.drain', title: 'Drain the gateway?', confirm: 'Drain · Face ID' },
  };

/** ConfigHome.tsx:68-76 — the applied state lingers 1200 ms, then the sheet closes. */
export const APPLIED_CLOSE_MS = 1200;

export function GatewaySheet({ action }: { action: GatewayAction }) {
  const { t } = useTheme();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'applying' | 'applied'>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const target = GATEWAY[action];

  async function apply() {
    if (phase !== 'idle') return;
    setPhase('applying');
    setApplyError(null);
    try {
      await api.applyWrite({ action: target.action });
      setPhase('applied');
      qc.invalidateQueries({ queryKey: ['vitals'] });
      qc.invalidateQueries({ queryKey: ['health'] });
    } catch (err) {
      setPhase('idle');
      // A cancelled Face ID says nothing at all here (OQ-10) — unlike
      // ConfigSectionPage, which toasts "Face ID cancelled.".
      if (isCancelledGateError(err)) return;
      setApplyError(err instanceof Error ? err.message : 'Write failed.');
    }
  }

  useEffect(() => {
    if (phase !== 'applied') return;
    const timer = setTimeout(closeSheet, APPLIED_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  return (
    <SheetScreen eyebrow="Gateway" title={target.title}>
      <Text style={[styles.body, { color: t('fg-2') }]}>Applies via Face ID. In-flight sessions end.</Text>
      {phase === 'applied' ? (
        <Text style={[styles.applied, { color: t('status-up') }]}>applied</Text>
      ) : (
        <View>
          {/* No padlock glyph here: unlike the ReviewBar/ConfirmBar/SaveBar
              primary, ConfigHome.tsx:194-208 is a plain accent-soft button. */}
          <Pressable
            onPress={apply}
            disabled={phase === 'applying'}
            accessibilityRole="button"
            accessibilityState={{ disabled: phase === 'applying' }}
            style={({ pressed }) => [
              styles.confirm,
              {
                backgroundColor: t('accent-soft'),
                borderColor: t('accent-border'),
                opacity: phase === 'applying' ? 0.6 : 1,
              },
              pressed && phase !== 'applying' && { opacity: PRESSED_OPACITY },
            ]}
          >
            <Text style={[styles.confirmLabel, { color: t('accent') }]}>
              {phase === 'applying' ? 'Waiting for Face ID…' : target.confirm}
            </Text>
          </Pressable>
          {applyError ? <Text style={[styles.error, { color: t('status-down') }]}>{applyError}</Text> : null}
        </View>
      )}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  body: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18.75, paddingHorizontal: 4, marginBottom: 14 },
  applied: { fontFamily: fonts.mono(400), fontSize: 12, paddingHorizontal: 4, paddingBottom: 8 },
  confirm: {
    width: '100%',
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmLabel: { fontFamily: fonts.sans(600), fontSize: 13.5 },
  error: { fontFamily: fonts.sans(400), fontSize: 12, marginTop: 10, paddingHorizontal: 4 },
});
