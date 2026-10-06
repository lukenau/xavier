import { StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card } from '../../shell';
import type { CalendarDay, CalendarEvent, CalendarWidget as CalendarWidgetT } from '../../../chat/widget';
import {
  ALL_DAY_LABEL,
  type DayBlock,
  type MonthCell,
  WEEKDAY_INITIALS,
  dayHeading,
  dayNumber,
  monthGrid,
  eventTimeLabel,
  formatHour,
  gapLabel,
  layoutDay,
  weekdayLabel,
} from '../../../chat/calendarLayout';
import { toneSoftToken, toneToken } from './tone';

const EMPTY = 'Nothing scheduled';
/** Below this a block holds one line, so the time rides beside the title
 *  instead of under it — a 30-minute meeting used to show no time at all. */
const TWO_LINE_PX = 34;
const LANE_GAP = 4;

export function CalendarWidget({ widget }: { widget: CalendarWidgetT }) {
  const { t } = useTheme();
  return (
    <Card style={styles.card}>
      {widget.title ? <Text style={[styles.title, { color: t('fg-0') }]}>{widget.title}</Text> : null}
      {widget.view === 'day' ? (
        widget.days.map((day) => <DayView key={day.date} day={day} />)
      ) : widget.view === 'month' ? (
        <MonthView days={widget.days} />
      ) : (
        <View style={styles.week}>
          {widget.days.map((day) => (
            <WeekRow key={day.date} day={day} />
          ))}
        </View>
      )}
    </Card>
  );
}

function DayView({ day }: { day: CalendarDay }) {
  const { t } = useTheme();
  const layout = layoutDay(day.events);

  return (
    <View testID={`cal-day-${day.date}`} style={styles.day}>
      <Text style={[styles.dayHeading, { color: t('fg-2') }]}>{day.label ?? dayHeading(day.date)}</Text>

      {layout.allDay.length > 0 ? (
        <View style={styles.allDay}>
          {layout.allDay.map((event) => (
            <Chip key={event.id} event={event} time={ALL_DAY_LABEL} />
          ))}
        </View>
      ) : null}

      {day.events.length === 0 ? <Text style={[styles.empty, { color: t('fg-2') }]}>{EMPTY}</Text> : null}

      {layout.blocks.length > 0 ? (
        <View style={styles.grid}>
          <View style={[styles.gutter, { height: layout.height }]}>
            {layout.bands.map((band) =>
              band.kind === 'hour' ? (
                <Text
                  key={`h${band.hour}`}
                  style={[styles.hour, { top: band.top - 5, color: t('fg-3') }, MONO_FEATURES]}
                >
                  {formatHour(band.hour)}
                </Text>
              ) : null,
            )}
          </View>
          <View style={[styles.track, { height: layout.height }]}>
            {layout.bands.map((band) =>
              band.kind === 'hour' ? (
                <View key={`r${band.hour}`} style={[styles.rule, { top: band.top, backgroundColor: t('border') }]} />
              ) : (
                <View key={`g${band.top}`} style={[styles.gap, { top: band.top, height: band.height }]}>
                  <View style={[styles.gapRule, { backgroundColor: t('border') }]} />
                  <Text style={[styles.gapLabel, { color: t('fg-3') }, MONO_FEATURES]}>{gapLabel(band.hours)}</Text>
                  <View style={[styles.gapRule, { backgroundColor: t('border') }]} />
                </View>
              ),
            )}
            {layout.blocks.map((block) => (
              <Block key={block.event.id} block={block} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Block({ block }: { block: DayBlock }) {
  const { t } = useTheme();
  const time = eventTimeLabel(block.event);
  const twoLine = block.height >= TWO_LINE_PX;
  return (
    <View
      testID={`cal-event-${block.event.id}`}
      style={[styles.slot, { top: block.top, height: block.height, left: block.left, width: block.width }]}
    >
      <View
        style={[
          styles.block,
          twoLine ? null : styles.blockTight,
          {
            marginRight: block.lanes > 1 ? LANE_GAP : 0,
            backgroundColor: t(toneSoftToken(block.event.tone)),
            borderLeftColor: t(toneToken(block.event.tone)),
          },
        ]}
      >
        {twoLine ? (
          <>
            <Text style={[styles.blockTitle, { color: t('fg-0') }]} numberOfLines={block.height >= 56 ? 2 : 1}>
              {block.event.title}
            </Text>
            <Text style={[styles.blockMeta, { color: t('fg-2') }, MONO_FEATURES]} numberOfLines={1}>
              {block.event.location ? `${time} · ${block.event.location}` : time}
            </Text>
          </>
        ) : (
          <View style={styles.tightRow}>
            <Text style={[styles.tightTime, { color: t('fg-2') }, MONO_FEATURES]} numberOfLines={1}>
              {time}
            </Text>
            <Text style={[styles.blockTitle, styles.tightTitle, { color: t('fg-0') }]} numberOfLines={1}>
              {block.event.title}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

// A row per day, not seven columns: at 400px a real week grid gives each day
// ~50px, which truncates every title to nothing.
function WeekRow({ day }: { day: CalendarDay }) {
  const { t } = useTheme();
  return (
    <View testID={`cal-day-${day.date}`} style={[styles.weekRow, { borderTopColor: t('border') }]}>
      <View style={styles.weekHead}>
        <Text style={[styles.weekday, { color: t('fg-3') }]}>{day.label ?? weekdayLabel(day.date)}</Text>
        <Text style={[styles.weekDate, { color: t('fg-1') }, MONO_FEATURES]}>{dayNumber(day.date)}</Text>
      </View>
      <View style={styles.weekEvents}>
        {day.events.length === 0 ? (
          <Text style={[styles.empty, { color: t('fg-2') }]}>{EMPTY}</Text>
        ) : (
          day.events.map((event) => <Chip key={event.id} event={event} time={eventTimeLabel(event)} />)
        )}
      </View>
    </View>
  );
}

// A month is a grid, not a list: thirty rows of "Nothing scheduled" tell you
// nothing, and the shape of a busy week is the whole point at this range
// (the user, 2026-09-22). Each day carries a bar per event, capped — the count is
// the signal, the titles are a day view away.
const MAX_DOTS = 4;

function MonthView({ days }: { days: CalendarDay[] }) {
  const { t } = useTheme();
  const rows = monthGrid(days);
  return (
    <View style={styles.month}>
      <View style={styles.monthHead}>
        {WEEKDAY_INITIALS.map((d, i) => (
          <Text key={i} style={[styles.weekdayInitial, { color: t('fg-3') }]}>
            {d}
          </Text>
        ))}
      </View>
      {rows.map((row, ri) => (
        <View key={ri} style={[styles.monthRow, { borderTopColor: t('border') }]}>
          {row.map((cell, ci) => (
            <MonthDay key={ci} cell={cell} />
          ))}
        </View>
      ))}
    </View>
  );
}

function MonthDay({ cell }: { cell: MonthCell }) {
  const { t } = useTheme();
  if (!cell.inRange) return <View style={styles.monthCell} />;
  const shown = cell.events.slice(0, MAX_DOTS);
  const extra = cell.events.length - shown.length;
  return (
    <View testID={`cal-month-${cell.date}`} style={styles.monthCell}>
      <Text style={[styles.monthDay, { color: cell.events.length ? t('fg-0') : t('fg-3') }, MONO_FEATURES]}>
        {cell.day}
      </Text>
      <View style={styles.monthBars}>
        {shown.map((event) => (
          <View key={event.id} style={[styles.monthBar, { backgroundColor: t(toneToken(event.tone)) }]} />
        ))}
        {extra > 0 ? (
          <Text style={[styles.monthMore, { color: t('fg-3') }, MONO_FEATURES]}>{`+${extra}`}</Text>
        ) : null}
      </View>
    </View>
  );
}

function Chip({ event, time }: { event: CalendarEvent; time: string }) {
  const { t } = useTheme();
  return (
    <View
      testID={`cal-event-${event.id}`}
      style={[
        styles.chip,
        { backgroundColor: t(toneSoftToken(event.tone)), borderLeftColor: t(toneToken(event.tone)) },
      ]}
    >
      <Text style={[styles.chipTitle, { color: t('fg-1') }]} numberOfLines={1}>
        {event.title}
      </Text>
      <Text style={[styles.chipTime, { color: t('fg-2') }, MONO_FEATURES]} numberOfLines={1}>
        {time}
      </Text>
    </View>
  );
}

const GUTTER_W = 40;

const styles = StyleSheet.create({
  card: { gap: 10 },
  title: { fontFamily: fonts.sans(620), fontSize: 14.5, lineHeight: 20 },
  day: { gap: 8 },
  dayHeading: { fontFamily: fonts.sans(550), fontSize: 12.5, letterSpacing: 0.2 },
  allDay: { gap: 4 },
  empty: { fontFamily: fonts.sans(400), fontSize: 12, fontStyle: 'italic' },
  grid: { flexDirection: 'row' },
  gutter: { width: GUTTER_W, position: 'relative' },
  hour: { position: 'absolute', right: 8, fontFamily: fonts.mono(400), fontSize: 9.5 },
  track: { flex: 1, minWidth: 0, position: 'relative' },
  rule: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
  gap: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  gapRule: { flex: 1, height: StyleSheet.hairlineWidth },
  gapLabel: { fontFamily: fonts.mono(400), fontSize: 9.5, letterSpacing: 0.3 },
  slot: { position: 'absolute' },
  block: {
    flex: 1,
    borderRadius: 7,
    borderLeftWidth: 2.5,
    paddingHorizontal: 7,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  blockTight: { justifyContent: 'center', paddingVertical: 0 },
  blockTitle: { fontFamily: fonts.sans(580), fontSize: 11.5, lineHeight: 15 },
  blockMeta: { fontFamily: fonts.mono(400), fontSize: 9.5, lineHeight: 14 },
  tightRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  tightTime: { fontFamily: fonts.mono(400), fontSize: 9.5 },
  tightTitle: { flex: 1, minWidth: 0 },
  month: { marginTop: 2 },
  monthHead: { flexDirection: 'row' },
  weekdayInitial: {
    flex: 1,
    textAlign: 'center',
    fontFamily: fonts.mono(550),
    fontSize: 9,
    letterSpacing: 0.6,
    paddingBottom: 4,
  },
  monthRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  monthCell: { flex: 1, minHeight: 44, alignItems: 'center', paddingTop: 4, paddingBottom: 5, gap: 3 },
  monthDay: { fontFamily: fonts.mono(550), fontSize: 11 },
  monthBars: { alignSelf: 'stretch', paddingHorizontal: 3, gap: 2 },
  monthBar: { height: 2.5, borderRadius: 1.5 },
  monthMore: { fontSize: 8, textAlign: 'center' },
  week: { marginTop: 2 },
  weekRow: { flexDirection: 'row', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 8 },
  weekHead: { width: 38, alignItems: 'flex-start' },
  weekday: { fontFamily: fonts.mono(550), fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase' },
  weekDate: { fontFamily: fonts.mono(620), fontSize: 15, lineHeight: 19 },
  weekEvents: { flex: 1, minWidth: 0, gap: 4, justifyContent: 'center' },
  chip: {
    borderRadius: 7,
    borderLeftWidth: 2.5,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  chipTitle: { fontFamily: fonts.sans(550), fontSize: 12, lineHeight: 16 },
  chipTime: { fontFamily: fonts.mono(400), fontSize: 9.5, lineHeight: 13, letterSpacing: 0.2 },
});
