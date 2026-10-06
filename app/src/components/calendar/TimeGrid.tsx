// The hour grid the day and the week share: an hour gutter, N columns, a rule
// per hour, a line for now, and blocks placed by weekLayout.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatHour } from '../../chat/calendarLayout';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { accountTokens } from './accountStyle';
import type { ScreenEvent } from './calendarModel';
import { eventLabel, type OnEventPress } from './EventRow';
import { nowOffset, type WeekBlock, type WeekLayout } from './weekLayout';

export const GUTTER_W = 34;
export const COLUMN_GAP = 2;
const UNCONFIRMED_OPACITY = 0.55;

export function HourGutter({ layout }: { layout: WeekLayout }) {
  const { t } = useTheme();
  return (
    <View style={[styles.gutter, { height: layout.height }]}>
      {layout.hours.map((hour, i) => (
        <Text
          key={hour}
          maxFontSizeMultiplier={1.3}
          style={[styles.hour, { top: i * layout.pxPerHour - 5, color: t('fg-3') }, MONO_FEATURES]}
        >
          {formatHour(hour)}
        </Text>
      ))}
    </View>
  );
}

export function HourRules({ layout }: { layout: WeekLayout }) {
  const { t } = useTheme();
  return (
    <>
      {layout.hours.map((hour, i) => (
        <View key={hour} style={[styles.rule, { top: i * layout.pxPerHour, backgroundColor: t('border') }]} />
      ))}
    </>
  );
}

export function NowLine({ layout, nowMin }: { layout: WeekLayout; nowMin: number }) {
  const { t } = useTheme();
  const top = nowOffset(layout, nowMin);
  if (top === null) return null;
  return (
    <View testID="cal-now" pointerEvents="none" style={[styles.now, { top }]}>
      <View style={[styles.nowDot, { backgroundColor: t('accent') }]} />
      <View style={[styles.nowRule, { backgroundColor: t('accent') }]} />
    </View>
  );
}

export function Block({
  block,
  date,
  titleSize,
  lines,
  onPress,
  children,
}: {
  block: WeekBlock;
  date: string;
  titleSize: number;
  lines: number;
  onPress: OnEventPress;
  children?: React.ReactNode;
}) {
  const { t } = useTheme();
  const event = block.event as ScreenEvent;
  const tokens = accountTokens(event.wire.account);
  return (
    <Pressable
      testID={`cal-event-${event.id}`}
      onPress={() => onPress(event)}
      accessibilityRole="button"
      accessibilityLabel={eventLabel(event, date)}
      hitSlop={4}
      style={({ pressed }) => [
        styles.block,
        {
          top: block.top,
          height: block.height,
          left: block.left,
          width: block.width,
          backgroundColor: t(tokens.fill),
          borderLeftColor: t(tokens.edge),
        },
        event.unconfirmed && { opacity: UNCONFIRMED_OPACITY },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text
        maxFontSizeMultiplier={1.3}
        style={[styles.blockTitle, { color: t('fg-0'), fontSize: titleSize, lineHeight: titleSize + 2.5 }]}
        numberOfLines={lines}
      >
        {event.title}
      </Text>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  gutter: { width: GUTTER_W, position: 'relative' },
  hour: { position: 'absolute', right: 5, fontFamily: fonts.mono(400), fontSize: 9 },
  rule: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
  now: { position: 'absolute', left: -4, right: 0, height: 2, flexDirection: 'row', alignItems: 'center' },
  nowDot: { width: 6, height: 6, borderRadius: 3 },
  nowRule: { flex: 1, height: 1.5 },
  block: {
    position: 'absolute',
    borderRadius: 4,
    borderLeftWidth: 2,
    paddingHorizontal: 3,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  blockTitle: { fontFamily: fonts.sans(560) },
});
