// The calendar's entry point on Home. Native-only, like MoneyEntryCard, and
// like it always renders — with no data, with stale data, before the first
// sync — so the route can never become unreachable.
//
// It shows what is next, not what is on: all-day entries (someone's vacation,
// a holiday) are on the calendar screen and left off the door.
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { formatMinute, parseIsoDate } from '../../chat/calendarLayout';
import type { CalendarResponse } from '../../lib/calendarTypes';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { freshness, isoDate, nextBusyDay, nextUp, toDays, visibleEvents } from '../calendar/calendarModel';
import { Card } from '../shell';

export interface CalendarCardRow {
  id: string;
  title: string;
  when: string;
}

export interface CalendarCardSummary {
  rows: CalendarCardRow[];
  /** Today's all-day entries, so "no timed events" never reads as a free day. */
  allDay: string | null;
  /** What to say when there are no rows. */
  line: string | null;
  warning: string | null;
}

const DESCRIPTOR = 'work and personal, in one place';

/** Intl puts a narrow no-break space before AM/PM; plain text reads the same. */
function clock(minuteOfDay: number): string {
  return formatMinute(minuteOfDay).replace(/\u202f/g, ' ');
}

const MERIDIEM = / (AM|PM)$/i;

/** "4:30–5:30 PM": one AM/PM when both ends share it (the user, 2026-09-30: titles,
 *  with end times). */
export function timeRange(startMin: number, endMin: number): string {
  const from = clock(startMin);
  if (endMin <= startMin) return from;
  const to = clock(endMin);
  const a = MERIDIEM.exec(from);
  const b = MERIDIEM.exec(to);
  return a && b && a[1] === b[1] ? `${from.replace(MERIDIEM, '')}–${to}` : `${from}–${to}`;
}

export function calendarCardSummary(data: CalendarResponse | undefined, now: Date): CalendarCardSummary {
  if (!data) return { rows: [], allDay: null, line: DESCRIPTOR, warning: null };
  const fresh = freshness(data.synced_at, data.stale_slices, now);
  if (!data.synced_at) return { rows: [], allDay: null, line: null, warning: fresh.label };

  const today = isoDate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const events = visibleEvents(data.events, false);
  const rows = nextUp(events, now).map(({ date, event }) => {
    const start = event.startMin ?? 0;
    const end = event.endMin ?? start;
    const running = date === today && start <= nowMin;
    const range = timeRange(start, end);
    return {
      id: `${date}-${event.id}`,
      title: event.title,
      when: running ? `Now–${clock(end)}` : date === today ? range : `Tomorrow ${range}`,
    };
  });

  const wholeDay = toDays(events, today, today)[0].events.filter((e) => e.startMin === null);
  const allDay = wholeDay.length ? `All day · ${wholeDay.map((e) => e.title).join(', ')}` : null;

  let line: string | null = null;
  if (rows.length === 0) {
    const busy = nextBusyDay(events, now);
    line = busy
      ? `No timed events before ${parseIsoDate(busy).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`
      : 'Nothing scheduled';
  }
  return { rows, allDay, line, warning: fresh.tone === 'warn' ? fresh.label : null };
}

export function CalendarCard({ data, now }: { data: CalendarResponse | undefined; now: Date }) {
  const { t } = useTheme();
  const summary = calendarCardSummary(data, now);
  const spoken = [
    ...summary.rows.map((r) => `${r.when}, ${r.title}`),
    summary.allDay,
    summary.line,
    summary.warning,
  ].filter(Boolean);

  return (
    <Card
      onPress={() => router.push('/calendar')}
      accessibilityLabel={`Calendar — ${spoken.join('. ')}`}
      style={styles.card}
    >
      <View style={styles.row}>
        <SymbolView name="calendar" size={18} tintColor={t('accent')} weight="regular" />
        <View style={styles.text}>
          <Text style={[styles.title, { color: t('fg-0') }]}>Calendar</Text>
          {summary.rows.map((r) => (
            <View key={r.id} style={styles.event}>
              <Text style={[styles.when, { color: t('fg-3') }, MONO_FEATURES]}>{r.when}</Text>
              <Text style={[styles.eventTitle, { color: t('fg-1') }]} numberOfLines={1} ellipsizeMode="tail">
                {r.title}
              </Text>
            </View>
          ))}
          {summary.allDay ? (
            <Text style={[styles.line, { color: t('fg-3') }]} numberOfLines={1}>
              {summary.allDay}
            </Text>
          ) : null}
          {summary.line ? (
            <Text style={[styles.line, { color: t('fg-3') }]} numberOfLines={1}>
              {summary.line}
            </Text>
          ) : null}
          {summary.warning ? (
            <Text accessibilityRole="alert" style={[styles.line, { color: t('status-warn') }]} numberOfLines={1}>
              {summary.warning}
            </Text>
          ) : null}
        </View>
        <SymbolView name="chevron.right" size={15} tintColor={t('fg-4')} weight="regular" />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 13, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(580), fontSize: 15 },
  event: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 },
  when: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  eventTitle: { flex: 1, minWidth: 0, fontFamily: fonts.sans(500), fontSize: 13 },
  line: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 2, ...MONO_FEATURES },
});
