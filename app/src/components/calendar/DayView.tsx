// One day, full screen, on a linear hour axis. The chat widget's day collapses
// empty hours into a "3h free" band; here the empty hours are what he is
// looking for, so they stay at full height and get a line for now.
import { StyleSheet, Text, View } from 'react-native';
import { eventTimeLabel } from '../../chat/calendarLayout';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { StatePanel } from '../shell';
import { NOTHING_SCHEDULED, isPast } from './AgendaView';
import type { ScreenDay, ScreenEvent } from './calendarModel';
import { EventRow, type OnEventPress } from './EventRow';
import { Block, COLUMN_GAP, HourGutter, HourRules, NowLine } from './TimeGrid';
import { layoutWeek } from './weekLayout';

const PX_PER_HOUR = 56;
const MIN_BLOCK_PX = 26;
/** Below this a block holds its title only; the time is in its label. */
const TWO_LINE_PX = 40;

export const UNKNOWN_DAY_TITLE = 'Nothing is known about this day';

export function DayView({
  day,
  today,
  nowMin,
  onEventPress,
}: {
  day: ScreenDay;
  today: string;
  nowMin: number;
  onEventPress: OnEventPress;
}) {
  const { t } = useTheme();
  if (day.coverage === 'none') {
    return (
      <View testID="cal-dayview">
        <StatePanel title={UNKNOWN_DAY_TITLE} detail="The sync has not read this week from either calendar yet." />
      </View>
    );
  }
  const layout = layoutWeek([day], PX_PER_HOUR, MIN_BLOCK_PX);
  const [column] = layout.columns;

  return (
    <View testID="cal-dayview" style={styles.root}>
      {column.allDay.length > 0 ? (
        <View style={styles.allDay}>
          {column.allDay.map((event) => (
            <EventRow
              key={event.id}
              event={event as ScreenEvent}
              past={isPast(day.date, event as ScreenEvent, today, nowMin)}
              onPress={onEventPress}
            />
          ))}
        </View>
      ) : null}
      {day.events.length === 0 ? (
        <Text style={[styles.empty, { color: t('fg-2') }]}>{NOTHING_SCHEDULED}</Text>
      ) : null}
      <View style={styles.grid}>
        <HourGutter layout={layout} />
        <View style={[styles.track, { height: layout.height }]}>
          <HourRules layout={layout} />
          {column.blocks.map((block) => (
            <Block key={block.event.id} block={block} date={day.date} titleSize={13} lines={block.height >= 64 ? 2 : 1} onPress={onEventPress}>
              {block.height >= TWO_LINE_PX ? (
                <Text style={[styles.meta, { color: t('fg-2') }, MONO_FEATURES]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                  {block.event.location ? `${eventTimeLabel(block.event)} · ${block.event.location}` : eventTimeLabel(block.event)}
                </Text>
              ) : null}
            </Block>
          ))}
          {day.date === today ? <NowLine layout={layout} nowMin={nowMin} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  allDay: { gap: 6 },
  empty: { fontFamily: fonts.sans(400), fontSize: 14, paddingVertical: 4 },
  grid: { flexDirection: 'row', gap: COLUMN_GAP },
  track: { flex: 1, minWidth: 0, position: 'relative' },
  meta: { fontFamily: fonts.mono(400), fontSize: 10, lineHeight: 14 },
});
