// Xavier on his LED screen: a dark rounded tile holding the dot-matrix pose,
// faded in, then running the moment's effect on top.
//
// RN Animated on the native driver, like shell/motion.ts: every effect is a
// transform/opacity loop over plain Views.
import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import type { TokenName } from '../theme/tokens.gen';
import { fonts } from '../theme/fonts';
import { XAVIER_SCREEN } from '../theme/whimsy';
import { haptic } from './haptics';
import { useWhimsy } from './level';
import type { MotionName } from './moments';
import { POSE_FACES, POSE_LABELS, POSES, type PoseId } from './poses';
import type { ResolvedMoment } from './useMoment';

export const POSE_SIZES = { inline: 48, spot: 112, hero: 208 } as const;
export type PoseSize = keyof typeof POSE_SIZES;

// Poses are waist-up; at small sizes the whole figure is too small to read, so
// the small tile is a round crop on his face and prop (POSE_FACES), clamped so
// the art always covers the circle.
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function loop(anim: Animated.CompositeAnimation) {
  const l = Animated.loop(anim);
  l.start();
  return () => l.stop();
}

/** The gold band that sweeps down the screen while he works. */
export function ScanBand({ px }: { px: number }) {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(
    () =>
      loop(
        Animated.timing(y, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ),
    [y],
  );
  const band = px * 0.35;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.band,
        {
          height: band,
          experimental_backgroundImage: `linear-gradient(to bottom, transparent, ${XAVIER_SCREEN.scan}, transparent)`,
          transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [-band, px] }) }],
        },
      ]}
    />
  );
}

function Sheen({ px }: { px: number }) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(x, { toValue: 1, duration: 900, delay: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [x]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.sheen,
        {
          width: px * 0.4,
          height: px * 1.6,
          top: -px * 0.3,
          experimental_backgroundImage: `linear-gradient(to right, transparent, ${XAVIER_SCREEN.sheen}, transparent)`,
          transform: [
            { translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-px * 0.6, px * 1.2] }) },
            { rotate: '20deg' },
          ],
        },
      ]}
    />
  );
}

function PulseRing({ radius }: { radius: number }) {
  const { t } = useTheme();
  const o = useRef(new Animated.Value(0)).current;
  useEffect(
    () =>
      loop(
        Animated.sequence([
          Animated.timing(o, { toValue: 1, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(o, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    [o],
  );
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1.5, borderColor: t('accent'), opacity: o }]}
    />
  );
}

function useEntrance(motion: MotionName, animate: boolean) {
  const v = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const jitter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!animate) return;
    const steps = [Animated.timing(v, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true })];
    if (motion === 'glitch') {
      steps.push(
        Animated.sequence(
          [-4, 3, -2, 2, 0, -3, 1, 0].map((toValue) =>
            Animated.timing(jitter, { toValue, duration: 45, easing: Easing.linear, useNativeDriver: true }),
          ),
        ),
      );
    }
    const a = Animated.sequence(steps);
    a.start();
    return () => a.stop();
  }, [animate, motion, v, jitter]);
  return { v, jitter };
}

export interface XavierTileProps {
  pose: PoseId;
  size: PoseSize | number;
  motion?: MotionName;
  /** Fade + settle in on mount. */
  animate?: boolean;
  dim?: boolean;
  /** A status dot on the tile's rim (errors), for when the pose alone is too subtle. */
  badge?: TokenName;
  onPress?: () => void;
}

/** The screen itself — shared by moments and the avatar. */
export function XavierTile({ pose, size, motion = 'still', animate = true, dim, badge, onPress }: XavierTileProps) {
  const { t } = useTheme();
  const px = typeof size === 'number' ? size : POSE_SIZES[size];
  const cameo = px < POSE_SIZES.spot;
  const radius = cameo ? px / 2 : Math.round(px * 0.14);
  const face = POSE_FACES[pose];
  const img = cameo ? px * face.zoom : px;
  const { v, jitter } = useEntrance(motion, animate);

  const screen = (
    <Animated.View
      testID={`xavier-pose-${pose}`}
      style={[
        styles.tile,
        {
          width: px,
          height: px,
          borderRadius: radius,
          backgroundColor: XAVIER_SCREEN.ground,
          borderColor: t('accent-border'),
          opacity: dim ? v.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }) : v,
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }, { translateX: jitter }],
        },
      ]}
    >
      <Image
        source={POSES[pose]}
        accessibilityLabel={POSE_LABELS[pose]}
        resizeMode="cover"
        style={
          cameo
            ? {
                position: 'absolute',
                width: img,
                height: img,
                left: clamp(px / 2 - face.x * img, px - img, 0),
                top: clamp(px / 2 - face.y * img, px - img, 0),
              }
            : { width: px, height: px }
        }
      />
      {motion === 'scan' ? <ScanBand px={px} /> : null}
      {motion === 'sheen' ? <Sheen px={px} /> : null}
      {motion === 'pulse' ? <PulseRing radius={radius} /> : null}
    </Animated.View>
  );
  const badged = badge ? (
    <View>
      {screen}
      <View
        style={[
          styles.badge,
          { width: px * 0.3, height: px * 0.3, borderRadius: px * 0.15, backgroundColor: t(badge), borderColor: t('bg-1') },
        ]}
      >
        <Text style={[styles.badgeMark, { fontSize: px * 0.2, lineHeight: px * 0.26 }]}>!</Text>
      </View>
    </View>
  ) : (
    screen
  );

  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button">
      {badged}
    </Pressable>
  ) : (
    badged
  );
}

export interface XavierPoseProps {
  moment: ResolvedMoment;
  size?: PoseSize;
  /** Overrides the moment's pose (easter eggs). */
  pose?: PoseId;
  onPress?: () => void;
}

export function XavierPose({ moment, size = 'spot', pose, onPress }: XavierPoseProps) {
  const { motion } = useWhimsy();
  useEffect(() => {
    if (moment.haptic) haptic(moment.haptic);
  }, [moment.id, moment.haptic]);

  return (
    <XavierTile
      pose={pose ?? moment.pose}
      size={size}
      motion={moment.motion}
      badge={moment.badge}
      animate={motion && (moment.motion !== 'still' || size !== 'inline')}
      onPress={onPress}
    />
  );
}

const styles = StyleSheet.create({
  tile: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth * 2 },
  band: { position: 'absolute', left: 0, right: 0, top: 0 },
  sheen: { position: 'absolute', left: 0 },
  badge: { position: 'absolute', right: -2, bottom: -2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  badgeMark: { color: XAVIER_SCREEN.mark, fontFamily: fonts.sans(800), textAlign: 'center' },
});
