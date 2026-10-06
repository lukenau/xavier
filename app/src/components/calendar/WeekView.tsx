// The week as one timeline per day (the user, 2026-09-30: option 2d over a seven-
// column grid, which on a phone left 44 pt a column and five letters a title).
// Each day lists its meetings in order with the free time between them said in
// words, so "when am I free this week" is read, not measured. Days already over
// fold into one line; a day's header opens it in Day view.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { parseIsoDate } from '../../chat/calendarLayout';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { accountTokens } from './accountStyle';
import { NOT_SYNCED } from './AgendaView';
import type { ScreenDay, ScreenEvent } from './calendarModel';
import { eventLabel, type OnEventPress } from './EventRow';
import { dayRows, freeLabel } from './weekTimeline';
import { timeRange } from '../home/CalendarCard';

const PAST_OPACITY = 0.45;
const DOT = 8;
const RAIL_W = 16;

function dayName(iso: string): string {
  const d = parseIsoDate(iso);
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`;
}

function shortRange(e: ScreenEvent): string {
  return timeRange(e.startMin as number, e.endMin ?? (e.startMin as number)).replace(/ AM/g, 'a').replace(/ PM/g, 'p');
}

function DayTimeline({
  day,
  today,
  nowMin,
  onEventPress,
  onDayPress,
}: {
  day: ScreenDay;
  today: string;
  nowMin: number;
  onEventPress: OnEventPress;
  onDayPress: (date: string) => void;
}) {
  const { t } = useTheme();
  const isToday = day.date === today;
  const allDay = day.events.filter((e) => e.startMin === null);
  const timedCount = day.events.length - allDay.length;
  const rows = dayRows(day.events, isToday ? nowMin : null);

  return (
    <View style={[styles.day, { borderTopColor: t('border') }]}>
      <Pressable
        testID={`cal-week-head-${day.date}`}
        onPress={() => onDayPress(day.date)}
        accessibilityRole="button"
        accessibilityLabel={`${isToday ? 'Today, ' : ''}${dayName(day.date)}, ${timedCount} event${timedCount === 1 ? '' : 's'}, open the day`}
        style={({ pressed }) => [styles.dayHead, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text maxFontSizeMultiplier={1.4} style={[styles.dayName, { color: isToday ? t('accent') : t('fg-1') }, MONO_FEATURES]}>
          {isToday ? `TODAY · ${dayName(day.date).toUpperCase()}` : dayName(day.date).toUpperCase()}
        </Text>
        {day.coverage !== 'none' && timedCount > 0 ? (
          <Text maxFontSizeMultiplier={1.4} style={[styles.count, { color: t('fg-3') }, MONO_FEATURES]}>
            {`${timedCount} event${timedCount === 1 ? '' : 's'}`}
          </Text>
        ) : null}
      </Pressable>

      {day.coverage === 'none' ? (
        <Text testID={`cal-week-unsynced-${day.date}`} style={[styles.note, { color: t('status-warn') }, MONO_FEATURES]}>
          {NOT_SYNCED}
        </Text>
      ) : (
        <>
          {allDay.map((e) => (
            <Pressable
              key={e.id}
              testID={`cal-event-${e.id}`}
              onPress={() => onEventPress(e)}
              accessibilityRole="button"
              accessibilityLabel={eventLabel(e, day.date)}
              style={({ pressed }) => pressed && { opacity: PRESSED_OPACITY }}
            >
              <Text numberOfLines={1} style={[styles.note, { color: t(accountTokens(e.wire.account).edge) }, MONO_FEATURES]}>
                {`all day · ${e.title}`}
              </Text>
            </Pressable>
          ))}
          {timedCount === 0 ? (
            <Text style={[styles.note, styles.railIndent, { color: t('fg-3') }, MONO_FEATURES]}>free all day</Text>
          ) : (
            <View style={styles.rail}>
              <View style={[styles.railLine, { backgroundColor: t('border') }]} />
              {rows.map((row, i) =>
                row.kind === 'gap' ? (
                  <Text key={`g${i}`} style={[styles.gap, { color: t('fg-3') }, MONO_FEATURES]}>
                    {freeLabel(row.minutes)}
                  </Text>
                ) : row.kind === 'now' ? (
                  <View key="now" testID="cal-now" style={styles.nowRow}>
                    <View style={[styles.nowDot, { backgroundColor: t('accent') }]} />
                    <View style={[styles.nowLine, { backgroundColor: t('accent') }]} />
                  </View>
                ) : (
                  <Pressable
                    key={row.event.id}
                    testID={`cal-event-${row.event.id}`}
                    onPress={() => onEventPress(row.event)}
                    accessibilityRole="button"
                    accessibilityLabel={eventLabel(row.event, day.date) + (row.overlaps ? ', overlaps another' : '')}
                    style={({ pressed }) => [
                      styles.eventRow,
                      (row.past || row.event.unconfirmed) && { opacity: PAST_OPACITY },
                      pressed && { opacity: PRESSED_OPACITY },
                    ]}
                  >
                    <View
                      style={[styles.dot, { borderColor: t(accountTokens(row.event.wire.account).edge), backgroundColor: t('bg-0') }]}
                    />
                    <Text maxFontSizeMultiplier={1.3} style={[styles.time, { color: t('fg-2') }, MONO_FEATURES]}>
                      {shortRange(row.event)}
                    </Text>
                    <Text
                      maxFontSizeMultiplier={1.4}
                      numberOfLines={1}
                      style={[
                        styles.title,
                        { color: row.event.wire.account === 'personal' ? t('petrol') : t('fg-0') },
                      ]}
                    >
                      {row.event.title}
                    </Text>
                    {row.overlaps ? (
                      <Text style={[styles.overlap, { color: t('status-warn') }, MONO_FEATURES]}>overlaps</Text>
                    ) : null}
                  </Pressable>
                ),
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

export function WeekView({
  days,
  today,
  nowMin,
  onEventPress,
  onDayPress,
}: {
  days: ScreenDay[];
  today: string;
  nowMin: number;
  onEventPress: OnEventPress;
  onDayPress: (date: string) => void;
}) {
  const { t } = useTheme();
  const [showPast, setShowPast] = useState(false);
  const past = days.filter((d) => d.date < today);
  const folded = past.length > 0 && past.length < days.length && !showPast;
  const shown = folded ? days.filter((d) => d.date >= today) : days;
  const pastLabel = past.length ? `${dayName(past[0].date)} – ${dayName(past[past.length - 1].date)}` : '';
  const pastCount = past.reduce((n, d) => n + d.events.filter((e) => e.startMin !== null).length, 0);

  return (
    <View testID="cal-weekview">
      {folded ? (
        <Pressable
          testID="cal-week-past"
          onPress={() => setShowPast(true)}
          accessibilityRole="button"
          accessibilityLabel={`Show ${pastLabel}`}
          style={({ pressed }) => [styles.pastRow, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.note, { color: t('fg-3') }, MONO_FEATURES]}>
            {`${pastLabel} · ${pastCount} event${pastCount === 1 ? '' : 's'} ›`}
          </Text>
        </Pressable>
      ) : null}
      {shown.map((day) => (
        <DayTimeline key={day.date} day={day} today={today} nowMin={nowMin} onEventPress={onEventPress} onDayPress={onDayPress} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pastRow: { minHeight: 36, justifyContent: 'center' },
  day: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 10, gap: 4 },
  dayHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10, minHeight: 32 },
  dayName: { fontFamily: fonts.mono(550), fontSize: 11.5, letterSpacing: 0.4 },
  count: { fontFamily: fonts.mono(400), fontSize: 10 },
  note: { fontFamily: fonts.mono(400), fontSize: 10.5, lineHeight: 16 },
  railIndent: { paddingLeft: RAIL_W },
  rail: { position: 'relative', paddingLeft: RAIL_W },
  railLine: { position: 'absolute', left: 4, top: 8, bottom: 8, width: 1.5 },
  gap: { fontFamily: fonts.mono(400), fontSize: 9.5, paddingVertical: 3 },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 34 },
  dot: { position: 'absolute', left: -RAIL_W + 0.5, width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 1.5 },
  time: { fontFamily: fonts.mono(400), fontSize: 10.5, width: 84 },
  title: { flex: 1, minWidth: 0, fontFamily: fonts.sans(520), fontSize: 13.5 },
  overlap: { fontFamily: fonts.mono(400), fontSize: 9 },
  nowRow: { flexDirection: 'row', alignItems: 'center', height: 12 },
  nowDot: { position: 'absolute', left: -RAIL_W, width: DOT, height: DOT, borderRadius: DOT / 2 },
  nowLine: { flex: 1, height: 1.5 },
});
