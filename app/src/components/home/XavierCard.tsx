// The "is Xavier alive" card (XavierCard.tsx:57-163). One tap target: the
// whole card opens Ops.
//
// Two liveness states, and they mean different things. Busy → the conic ring
// sweeps around the avatar. Up-and-idle → the avatar keeps its steady bloom
// and a ring pulses out of it once every 2.4s. Down → red, no motion.
//
// The PWA draws the sweep as a `conic-gradient` masked to a 2.5px annulus.
// RN has neither conic gradients nor CSS masks, so the ring is a Skia
// sweep-gradient stroked onto a circle — same stops, same thickness — with
// RN's Animated turning it on the native driver.
import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Canvas, Circle, SweepGradient, vec } from '@shopify/react-native-skia';
import { SymbolView } from 'expo-symbols';
import type { AgentSession, CronRun, PairingReport, Vitals } from '../../lib/types';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { Card } from '../shell';
import { useWhimsy, XavierAvatar } from '../../whimsy';
import { pulseScale, usePulseRing, useSpin } from './pulse';
import {
  AVATAR_SIZE,
  PULSE_MS,
  RING_INSET,
  RING_SIZE,
  RING_SPIN_MS,
  RING_STOPS,
  RING_STROKE,
  ringColors,
  xavierState,
} from './xavierState';

function StatRow({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: t('fg-4') }]}>{label}</Text>
      {children}
    </View>
  );
}

export function XavierCard({
  vitals,
  sessions,
  pairing,
  runs,
}: {
  vitals: Vitals | undefined;
  sessions: AgentSession[] | undefined;
  pairing: PairingReport | undefined;
  runs?: CronRun[];
}) {
  const { t } = useTheme();
  const s = xavierState(vitals, sessions, pairing, runs);
  const { level } = useWhimsy();
  const up = s.status === 'up';
  const spin = useSpin(s.busy, RING_SPIN_MS);
  const pulse = usePulseRing(up && !s.busy, PULSE_MS);
  const ringColor = t(s.ring);

  return (
    <Card
      tone="strong"
      onPress={() => router.push('/ops')}
      accessibilityLabel={`${s.name} — ${s.presence}`}
      style={[styles.card, { experimental_backgroundImage: t('hero-wash') }]}
    >
      <View style={styles.headRow}>
        <View style={styles.avatarSlot}>
          {s.busy ? (
            <Animated.View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.ring, { transform: [{ rotate: spin }] }]}
            >
              <Canvas style={styles.ringCanvas}>
                <Circle
                  cx={RING_SIZE / 2}
                  cy={RING_SIZE / 2}
                  r={(RING_SIZE - RING_STROKE) / 2}
                  style="stroke"
                  strokeWidth={RING_STROKE}
                >
                  <SweepGradient
                    c={vec(RING_SIZE / 2, RING_SIZE / 2)}
                    colors={ringColors(ringColor)}
                    positions={RING_STOPS}
                  />
                </Circle>
              </Canvas>
            </Animated.View>
          ) : null}
          {up && !s.busy ? (
            <Animated.View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[
                styles.pulse,
                {
                  backgroundColor: t('status-up-glow'),
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                  transform: [
                    {
                      scale: pulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, pulseScale(AVATAR_SIZE / 2)],
                      }),
                    },
                  ],
                },
              ]}
            />
          ) : null}
          {level === 'off' ? (
            <View
              style={[
                styles.avatar,
                {
                  backgroundColor: up ? t('status-up-soft') : t('bg-2'),
                  borderColor: up ? t('status-up-border') : t('border-strong'),
                },
                up && !s.busy ? { boxShadow: t('glow-up') } : null,
              ]}
            >
              <Text style={[styles.avatarLetter, { color: ringColor }]}>X</Text>
            </View>
          ) : (
            <XavierAvatar size={AVATAR_SIZE} state={!up ? 'down' : s.busy ? 'busy' : 'idle'} />
          )}
        </View>

        <View style={styles.headText}>
          <Text style={[styles.name, { color: t('fg-0') }]}>{s.name}</Text>
          <Text
            style={[styles.presence, { color: s.busy ? t('status-up') : t('fg-2') }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {s.presence}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={16} tintColor={t('fg-4')} weight="regular" />
      </View>

      <View style={[styles.stats, { borderTopColor: t('border') }]}>
        <StatRow label="today">
          <Text style={[styles.statValue, { color: t('fg-2') }]}>{s.todayLine}</Text>
        </StatRow>
        {vitals?.cron.next_label ? (
          <StatRow label="next">
            <Text
              style={[styles.statValue, { color: t('fg-2') }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {vitals.cron.next_label}
            </Text>
          </StatRow>
        ) : null}
        {s.lastRun ? (
          <StatRow label="last">
            <Text
              style={[styles.statValue, { color: t('fg-2') }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {s.lastRun.name ?? s.lastRun.job_id}
              {s.lastRun.status ? (
                <Text style={{ color: s.lastRunFailed ? t('status-down') : t('status-up') }}>
                  {` · ${s.lastRun.status}`}
                </Text>
              ) : null}
            </Text>
          </StatRow>
        ) : null}
      </View>

      {s.needsYou > 0 ? (
        <View
          style={[
            styles.needsYou,
            { backgroundColor: t('status-warn-soft'), borderColor: t('status-warn-border') },
          ]}
        >
          <Text style={[styles.needsYouLabel, { color: t('status-warn') }]}>
            Needs you · {s.needsYou}
          </Text>
          <Text style={[styles.needsYouDetail, { color: t('status-warn') }]}>{s.needsYouDetail}</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 16, marginBottom: 12 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatarSlot: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    top: -RING_INSET,
    left: -RING_INSET,
    width: RING_SIZE,
    height: RING_SIZE,
  },
  ringCanvas: { width: RING_SIZE, height: RING_SIZE },
  // A filled disc, not a ring: a scaled border would thicken as it grew, and
  // the CSS spread shadow is solid behind the (translucent) avatar anyway.
  pulse: {
    position: 'absolute',
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { fontFamily: fonts.sans(640), fontSize: 19 },
  headText: { flex: 1, minWidth: 0 },
  name: { fontFamily: fonts.sans(640), fontSize: 18, letterSpacing: -0.36 },
  presence: { fontFamily: fonts.sans(400), fontSize: 12.5 },
  stats: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, flexDirection: 'column', gap: 7 },
  statRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  statLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    width: 38,
  },
  statValue: { fontFamily: fonts.mono(400), fontSize: 11.5, flex: 1, ...MONO_FEATURES },
  needsYou: {
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  needsYouLabel: { fontFamily: fonts.sans(600), fontSize: 13 },
  needsYouDetail: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
