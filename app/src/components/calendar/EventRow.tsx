// One event as a row: the agenda's line, the month's day list, and the all-day
// strip above a timeline all draw the same thing.
import { Pressable, StyleSheet, Text } from 'react-native';
import { eventTimeLabel, parseIsoDate } from '../../chat/calendarLayout';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { ACCOUNT_LABEL, accountTokens } from './accountStyle';
import type { ScreenEvent } from './calendarModel';

export type OnEventPress = (event: ScreenEvent) => void;

export const UNCONFIRMED = 'unconfirmed';
const PAST_OPACITY = 0.55;

export function monthDay(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** What the row says about when: the time, or for a multi-day entry its end. */
export function whenText(event: ScreenEvent): string {
  const time = eventTimeLabel(event);
  return event.through ? `${time} · through ${monthDay(event.through)}` : time;
}

export function eventLabel(event: ScreenEvent, day?: string): string {
  return [
    event.title,
    day ? monthDay(day) : null,
    whenText(event),
    ACCOUNT_LABEL[event.wire.account],
    event.unconfirmed ? UNCONFIRMED : null,
  ]
    .filter(Boolean)
    .join(', ');
}

export function EventRow({ event, past = false, onPress }: { event: ScreenEvent; past?: boolean; onPress: OnEventPress }) {
  const { t } = useTheme();
  const tokens = accountTokens(event.wire.account);
  const meta = [whenText(event), event.location, event.unconfirmed ? UNCONFIRMED : null].filter(Boolean).join(' · ');
  return (
    <Pressable
      testID={`cal-event-${event.id}`}
      onPress={() => onPress(event)}
      accessibilityRole="button"
      accessibilityLabel={eventLabel(event)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: t(tokens.fill), borderLeftColor: t(tokens.edge) },
        (past || event.unconfirmed) && { opacity: PAST_OPACITY },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={2}>
        {event.title}
      </Text>
      <Text style={[styles.meta, { color: t('fg-2') }, MONO_FEATURES]} numberOfLines={1}>
        {meta}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  title: { fontFamily: fonts.sans(560), fontSize: 14, lineHeight: 18 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5, lineHeight: 15, marginTop: 1 },
});
