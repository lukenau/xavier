// The agenda: the days that have something on them, in order. A day with
// nothing is left out — unless nothing is KNOWN about it, which is said.
import { StyleSheet, Text, View } from 'react-native';
import { dayHeading } from '../../chat/calendarLayout';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { addDays, agendaSections, type ScreenDay, type ScreenEvent } from './calendarModel';
import { EventRow, monthDay, type OnEventPress } from './EventRow';

export const NOTHING_SCHEDULED = 'Nothing scheduled';
export const NOT_SYNCED = 'not synced';

function heading(date: string, today: string): string {
  if (date === today) return `Today · ${dayHeading(date)}`;
  if (date === addDays(today, 1)) return `Tomorrow · ${dayHeading(date)}`;
  return dayHeading(date);
}

export function isPast(day: string, event: ScreenEvent, today: string, nowMin: number): boolean {
  if (day < today) return true;
  if (day > today || event.startMin === null) return false;
  return (event.endMin ?? event.startMin) <= nowMin;
}

type Item = { kind: 'day'; day: ScreenDay } | { kind: 'unknown'; from: string; to: string };

/** Sections and, in date order, one note per run of days the sync has no data for. */
export function agendaItems(days: ScreenDay[]): Item[] {
  const sections = new Map(agendaSections(days).map((d) => [d.date, d]));
  const items: Item[] = [];
  let run = null as { from: string; to: string } | null;
  for (const day of days) {
    if (day.coverage === 'none') {
      run = { from: run?.from ?? day.date, to: day.date };
      continue;
    }
    if (run) items.push({ kind: 'unknown', ...run });
    run = null;
    const section = sections.get(day.date);
    if (section) items.push({ kind: 'day', day: section });
  }
  if (run) items.push({ kind: 'unknown', ...run });
  return items;
}

export function AgendaView({
  days,
  today,
  nowMin,
  onEventPress,
}: {
  days: ScreenDay[];
  today: string;
  nowMin: number;
  onEventPress: OnEventPress;
}) {
  const { t } = useTheme();
  const items = agendaItems(days);
  return (
    <View testID="cal-agenda" style={styles.root}>
      {items.length === 0 ? <Text style={[styles.empty, { color: t('fg-2') }]}>{NOTHING_SCHEDULED}</Text> : null}
      {items.map((item) =>
        item.kind === 'unknown' ? (
          <Text key={`u${item.from}`} style={[styles.unknown, { color: t('status-warn') }, MONO_FEATURES]}>
            {`${monthDay(item.from)} – ${monthDay(item.to)} · ${NOT_SYNCED}`}
          </Text>
        ) : (
          <View key={item.day.date} style={styles.section}>
            <Text
              accessibilityRole="header"
              style={[styles.heading, { color: item.day.date === today ? t('accent') : t('fg-2') }]}
            >
              {heading(item.day.date, today)}
            </Text>
            {item.day.events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                past={isPast(item.day.date, event, today, nowMin)}
                onPress={onEventPress}
              />
            ))}
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 18 },
  section: { gap: 6 },
  heading: { fontFamily: fonts.sans(580), fontSize: 12.5, letterSpacing: 0.2, marginBottom: 2 },
  empty: { fontFamily: fonts.sans(400), fontSize: 14, paddingVertical: 14 },
  unknown: { fontFamily: fonts.mono(400), fontSize: 11, paddingVertical: 6 },
});
