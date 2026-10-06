// A month as a grid, with the selected day's events listed under it. The grid
// says how busy each day is; the list says with what. A day the sync has never
// read is dimmed and says so, rather than looking free.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { dayHeading, monthGrid, type MonthCell, WEEKDAY_INITIALS } from '../../chat/calendarLayout';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { accountTokens } from './accountStyle';
import { NOTHING_SCHEDULED, NOT_SYNCED, isPast } from './AgendaView';
import type { DayCoverage, ScreenDay, ScreenEvent } from './calendarModel';
import { EventRow, type OnEventPress } from './EventRow';

const MAX_BARS = 4;

export function MonthView({
  days,
  today,
  nowMin,
  selected,
  onSelect,
  onEventPress,
}: {
  days: ScreenDay[];
  today: string;
  nowMin: number;
  selected: string;
  onSelect: (date: string) => void;
  onEventPress: OnEventPress;
}) {
  const { t } = useTheme();
  const rows = monthGrid(days);
  const coverage = new Map(days.map((d) => [d.date, d.coverage]));
  const chosen = days.find((d) => d.date === selected);

  return (
    <View testID="cal-monthview" style={styles.root}>
      <View>
        <View style={styles.head}>
          {WEEKDAY_INITIALS.map((d, i) => (
            <Text key={i} maxFontSizeMultiplier={1.3} style={[styles.weekday, { color: t('fg-3') }]}>
              {d}
            </Text>
          ))}
        </View>
        {rows.map((row, ri) => (
          <View key={ri} style={[styles.row, { borderTopColor: t('border') }]}>
            {row.map((cell, ci) => (
              <Cell
                key={ci}
                cell={cell}
                coverage={(cell.date && coverage.get(cell.date)) || 'full'}
                isToday={cell.date === today}
                isSelected={cell.date === selected}
                onSelect={onSelect}
              />
            ))}
          </View>
        ))}
      </View>

      {chosen ? (
        <View testID="cal-month-day-list" style={styles.list}>
          <Text accessibilityRole="header" style={[styles.listHeading, { color: t('fg-2') }]}>
            {dayHeading(chosen.date)}
          </Text>
          {chosen.coverage === 'none' ? (
            <Text style={[styles.empty, { color: t('status-warn') }]}>{NOT_SYNCED}</Text>
          ) : chosen.events.length === 0 ? (
            <Text style={[styles.empty, { color: t('fg-2') }]}>{NOTHING_SCHEDULED}</Text>
          ) : (
            chosen.events.map((event) => (
              <EventRow key={event.id} event={event} past={isPast(chosen.date, event, today, nowMin)} onPress={onEventPress} />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The bars: meetings, personal first, never the all-day entries that lie
 *  over every day of a week and would use up all four. */
function bars(events: ScreenEvent[]): ScreenEvent[] {
  const timed = events.filter((e) => e.startMin !== null);
  return [...timed.filter((e) => e.wire.account === 'personal'), ...timed.filter((e) => e.wire.account !== 'personal')];
}

function Cell({
  cell,
  coverage,
  isToday,
  isSelected,
  onSelect,
}: {
  cell: MonthCell;
  coverage: DayCoverage;
  isToday: boolean;
  isSelected: boolean;
  onSelect: (date: string) => void;
}) {
  const { t } = useTheme();
  if (!cell.inRange || !cell.date) return <View style={styles.cell} />;
  const date = cell.date;
  const unknown = coverage === 'none';
  const shown = unknown ? [] : bars(cell.events as ScreenEvent[]).slice(0, MAX_BARS);
  const count = cell.events.filter((e) => e.startMin !== null).length;
  const spoken = unknown ? NOT_SYNCED : count === 0 ? 'nothing scheduled' : `${count} meeting${count === 1 ? '' : 's'}`;
  return (
    <Pressable
      testID={`cal-month-${date}`}
      onPress={() => onSelect(date)}
      disabled={unknown}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected, disabled: unknown }}
      accessibilityLabel={`${dayHeading(date)}, ${spoken}`}
      style={({ pressed }) => [
        styles.cell,
        isSelected && { backgroundColor: t('bg-2') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text
        maxFontSizeMultiplier={1.3}
        style={[
          styles.day,
          { color: isToday ? t('accent') : unknown ? t('fg-4') : count > 0 ? t('fg-0') : t('fg-3') },
          MONO_FEATURES,
        ]}
      >
        {cell.day}
      </Text>
      <View style={styles.bars}>
        {shown.map((event) => (
          <View key={event.id} testID={`cal-bar-${event.id}`} style={[styles.bar, { backgroundColor: t(accountTokens(event.wire.account).bar) }]} />
        ))}
        {count > shown.length ? (
          <Text maxFontSizeMultiplier={1.3} style={[styles.more, { color: t('fg-3') }, MONO_FEATURES]}>{`+${count - shown.length}`}</Text>
        ) : null}
        {unknown ? <View style={[styles.unknownMark, { borderColor: t('status-warn') }]} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: 18 },
  head: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontFamily: fonts.mono(550), fontSize: 9.5, letterSpacing: 0.6, paddingBottom: 5 },
  row: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  cell: { flex: 1, minHeight: 52, alignItems: 'center', paddingTop: 5, paddingBottom: 6, gap: 4, borderRadius: 8 },
  day: { fontFamily: fonts.mono(550), fontSize: 12 },
  bars: { alignSelf: 'stretch', paddingHorizontal: 5, gap: 2 },
  bar: { height: 3, borderRadius: 1.5 },
  more: { fontSize: 8.5, textAlign: 'center' },
  unknownMark: { alignSelf: 'center', width: 10, height: 0, borderTopWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', marginTop: 2 },
  list: { gap: 6 },
  listHeading: { fontFamily: fonts.sans(580), fontSize: 12.5, letterSpacing: 0.2, marginBottom: 2 },
  empty: { fontFamily: fonts.sans(400), fontSize: 14, paddingVertical: 10 },
});
