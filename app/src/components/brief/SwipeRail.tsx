// The trailing swipe rail, and the gesture that opens it.
//
// Trailing only. A leading swipe stays rejected because the row's left edge
// sits inside iOS's interactive-pop region on a pushed screen — which is also
// why Useful is not a swipe action at all, and lives in the sheet and the
// rotor instead (spec §8.2, §12.2).
//
// Animation is RN's own Animated with the spec's spring constants, not
// reanimated worklets: reanimated has no call site anywhere in this app and no
// jest wiring, while the app's one existing Pan gesture (EquityChart) is
// `.runOnJS(true)`. Animated.spring takes the same damping/stiffness/mass and
// drives a transform on the native driver, so the physics is the spec's.
import { useEffect, useRef } from 'react';
import {
  Animated,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { SymbolView } from 'expo-symbols';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../shell';
import type { BriefItem } from './briefModel';
import type { UseBriefActions } from './useBriefActions';

/** One action's width; the rail is two of them. */
export const RAIL_ACTION_WIDTH = 84;
export const RAIL_WIDTH = RAIL_ACTION_WIDTH * 2;
/** Past this fraction of the row's width, a full swipe arms Done. */
export const ARM_THRESHOLD_FRACTION = 0.55;
const SPRING = { damping: 20, stiffness: 220, mass: 0.6, useNativeDriver: true };

/** Above this text scale the rail shows its symbol alone: a wrapped two-line
 * "Snooze" inside 84pt is unreadable, and the SF Symbol plus its
 * accessibilityLabel already carries the meaning (spec §10). */
export const RAIL_LABEL_MAX_SCALE = 1.6;

export function railShowsLabel(scale: number = PixelRatio.getFontScale()): boolean {
  return scale <= RAIL_LABEL_MAX_SCALE;
}

/** Where the rail settles for a given gesture end, in points. Past halfway it
 * stays open; short of it, it springs back. */
export function restingOffset(translateX: number): number {
  return translateX > -RAIL_WIDTH / 2 ? 0 : -RAIL_WIDTH;
}

/** Did this drag cross the arm threshold? */
export function crossedArmThreshold(translateX: number, rowWidth: number): boolean {
  return rowWidth > 0 && Math.abs(translateX) > ARM_THRESHOLD_FRACTION * rowWidth;
}

// Rotor actions are deliberately NOT accepted here: they have to sit on the
// element carrying the accessibilityLabel and the button role (the row's own
// Pressable), because that is what VoiceOver focuses. On this wrapper they
// would be unreachable — the exact failure §10 exists to prevent.
export function SwipeRow({
  item,
  actions,
  enabled,
  children,
}: {
  item: BriefItem;
  actions: UseBriefActions;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  const reduced = useReducedMotion();
  const translateX = useRef(new Animated.Value(0)).current;
  const width = useRef(0);
  const armedByGesture = useRef(false);
  const state = actions.rowState(item.item_id);
  const open = state.phase === 'open' || state.phase === 'armed';

  // The rail position follows the phase, so closing it from anywhere (a scroll,
  // another row, the 3s disarm) animates rather than snapping.
  useEffect(() => {
    const to = open ? -RAIL_WIDTH : 0;
    if (reduced) {
      translateX.setValue(to);
      return;
    }
    Animated.spring(translateX, { toValue: to, ...SPRING }).start();
  }, [open, reduced, translateX]);

  const pan = Gesture.Pan()
    // Vertical scroll wins ties: this list is 44 rows long and scrolling it is
    // the common act, swiping one row the rare one.
    .activeOffsetX([-12, 12])
    .failOffsetY([-8, 8])
    .enabled(enabled)
    .runOnJS(true)
    .onBegin(() => {
      armedByGesture.current = false;
    })
    .onUpdate((e) => {
      const base = open ? -RAIL_WIDTH : 0;
      // Trailing only — a rightward drag past rest goes nowhere.
      const next = Math.min(0, Math.max(-RAIL_WIDTH * 1.4, base + e.translationX));
      translateX.setValue(next);
      // Exactly once per crossing, never per frame.
      if (!armedByGesture.current && crossedArmThreshold(next, width.current)) {
        armedByGesture.current = true;
        actions.onArmThreshold();
      }
    })
    .onEnd((e) => {
      const base = open ? -RAIL_WIDTH : 0;
      const ended = base + e.translationX;
      if (crossedArmThreshold(ended, width.current)) {
        // A full swipe ARMS Done. It does not commit (Ruling 61).
        actions.openRail(item.item_id);
        actions.armDone(item.item_id);
        return;
      }
      if (restingOffset(ended) === 0) actions.closeRail(item.item_id);
      else actions.openRail(item.item_id);
    });

  const armed = state.phase === 'armed';

  return (
    <View
      style={styles.clip}
      onLayout={(e: LayoutChangeEvent) => {
        width.current = e.nativeEvent.layout.width;
      }}
    >
      {enabled ? (
        <View style={styles.rail} pointerEvents={open ? 'auto' : 'none'}>
          <RailAction
            label="Snooze"
            symbol="clock.arrow.circlepath"
            color={t('fg-2')}
            ground={t('bg-1')}
            onPress={() => actions.snooze(item, '1d')}
          />
          <RailAction
            label={armed ? 'Confirm?' : 'Done'}
            // The armed label is never dropped, however large the text: armed
            // is the state that destroys an item, and with the label gone the
            // ONLY difference from Done is the warn ground — which is no
            // difference at all to a colour-blind reader. The symbol is a
            // checkmark in both states.
            alwaysLabel={armed}
            symbol="checkmark"
            color={t(armed ? 'bg-0' : 'status-up')}
            ground={t(armed ? 'status-warn' : 'bg-1')}
            onPress={() => (armed ? actions.dismiss(item) : actions.armDone(item.item_id))}
          />
        </View>
      ) : null}
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[styles.face, { backgroundColor: t('bg-0') }, { transform: [{ translateX }] }]}
        >
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function RailAction({
  label,
  symbol,
  color,
  ground,
  alwaysLabel,
  onPress,
}: {
  label: string;
  symbol: 'clock.arrow.circlepath' | 'checkmark';
  color: string;
  ground: string;
  /** Keep the label past the icon-only threshold. */
  alwaysLabel?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.action, { backgroundColor: ground }]}
    >
      <SymbolView name={symbol} size={20} tintColor={color} weight="regular" />
      {alwaysLabel || railShowsLabel() ? (
        <Text maxFontSizeMultiplier={RAIL_LABEL_MAX_SCALE} style={[styles.actionLabel, { color }]}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  rail: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  action: {
    width: RAIL_ACTION_WIDTH,
    // No fixed height: the rail grows with the row it belongs to, so a row at
    // AX5 still has a full-height action rather than a clipped one (spec §10).
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionLabel: { fontFamily: fonts.sans(550), fontSize: 11 },
  // The face is opaque so the rail is genuinely behind it, not showing through.
  face: {},
});
