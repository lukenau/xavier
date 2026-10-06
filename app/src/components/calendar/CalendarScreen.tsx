// The calendar: both of the user's calendars, read-only, in four views.
//
// What is drawn is a snapshot a cron job keeps (`calendar-sync.py`), not a live
// read — the source takes minutes per week and
// can miss an event. So the header says how fresh the dates ON SCREEN are, a
// day the snapshot has never read says so rather than looking free, and an
// event the last sync did not return is drawn as unconfirmed.
//
// Body of app/(home)/calendar.tsx. Lives here so jest can render it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { SymbolView } from 'expo-symbols';
import { api } from '../../lib/api';
import type { WireEvent } from '../../lib/calendarTypes';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, Screen, SCREEN_GUTTER, SkeletonRows, StatePanel, useHideTabBar } from '../shell';
import { accountTokens } from './accountStyle';
import { AgendaView } from './AgendaView';
import {
  type CalendarView,
  type ScreenEvent,
  coverage,
  freshness,
  freshnessFor,
  isHidden,
  isoDate,
  rangeFor,
  rangeTitle,
  step,
  toDays,
  visibleEvents,
  windowLabel,
} from './calendarModel';
import { DayView } from './DayView';
import { EventSheet } from './EventSheet';
import { MonthView } from './MonthView';
import { useCalendar } from './useCalendar';
import { WeekView } from './WeekView';

const VIEWS: { view: CalendarView; label: string }[] = [
  { view: 'agenda', label: 'Agenda' },
  { view: 'day', label: 'Day' },
  { view: 'week', label: 'Week' },
  { view: 'month', label: 'Month' },
];

export const OFFLINE_NOTE = 'Offline · showing the last snapshot';
export const SYNCING_NOTE = 'syncing this week and next · about 3 min';

// Where he left off, for as long as the app lives: a view and a date he chose
// are worth keeping across a trip to Home and back. A date that was simply
// "today" is not kept — today moves.
let remembered: { view: CalendarView; anchor: string | null } | null = null;

export function forgetCalendarState() {
  remembered = null;
}

function BackLink() {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.back()}
      accessibilityRole="button"
      accessibilityLabel="Home"
      style={({ pressed }) => [styles.backLink, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <SymbolView name="chevron.left" size={15} tintColor={t('accent')} weight="semibold" />
      <Text style={[styles.backLinkLabel, { color: t('accent') }]}>Home</Text>
    </Pressable>
  );
}

function SyncButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Sync now"
      accessibilityState={{ disabled: busy, busy }}
      style={({ pressed }) => [styles.syncButton, { borderColor: t('border') }, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <SymbolView name="arrow.triangle.2.circlepath" size={13} tintColor={busy ? t('fg-4') : t('accent')} weight="semibold" />
      <Text maxFontSizeMultiplier={1.3} style={[styles.syncLabel, { color: busy ? t('fg-4') : t('accent') }]}>
        Sync
      </Text>
    </Pressable>
  );
}

function HiddenLine({ count, shown, onToggle }: { count: number; shown: boolean; onToggle: () => void }) {
  const { t } = useTheme();
  if (count === 0) return null;
  return (
    <View style={styles.hiddenLine}>
      <Text maxFontSizeMultiplier={1.4} style={[styles.hiddenText, { color: t('fg-3') }, MONO_FEATURES]}>
        {shown ? `showing ${count} hidden · team calendars & optional` : `${count} hidden · team calendars & optional`}
      </Text>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={shown ? 'Hide them' : 'Show hidden'}
        hitSlop={10}
        style={({ pressed }) => pressed && { opacity: PRESSED_OPACITY }}
      >
        <Text maxFontSizeMultiplier={1.4} style={[styles.hiddenToggle, { color: t('accent') }]}>{shown ? 'Hide' : 'Show'}</Text>
      </Pressable>
    </View>
  );
}

function Legend() {
  const { t } = useTheme();
  return (
    <View style={styles.legend} accessibilityLabel="grey is work, blue is personal">
      {(['work', 'personal'] as const).map((account) => (
        <View key={account} style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: t(accountTokens(account).fill), borderLeftColor: t(accountTokens(account).edge) }]} />
          <Text maxFontSizeMultiplier={1.3} style={[styles.legendLabel, { color: t('fg-3') }, MONO_FEATURES]}>
            {account}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Switcher({ view, onChange }: { view: CalendarView; onChange: (view: CalendarView) => void }) {
  const { t } = useTheme();
  return (
    <View style={[styles.switcher, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      {VIEWS.map((v) => {
        const selected = v.view === view;
        return (
          <Pressable
            key={v.view}
            onPress={() => onChange(v.view)}
            accessibilityRole="button"
            accessibilityLabel={`${v.label} view`}
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.segment, selected && { backgroundColor: t('bg-2') }, pressed && { opacity: PRESSED_OPACITY }]}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              style={[styles.segmentLabel, { color: selected ? t('fg-0') : t('fg-3'), fontFamily: fonts.sans(selected ? 600 : 500) }]}
            >
              {v.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Stepper({
  title,
  fresh,
  atToday,
  onStep,
  onToday,
}: {
  title: string;
  fresh: { label: string; tone: 'neutral' | 'warn' } | null;
  atToday: boolean;
  onStep: (dir: 1 | -1) => void;
  onToday: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.stepper}>
      <Pressable onPress={() => onStep(-1)} accessibilityRole="button" accessibilityLabel="Previous" style={({ pressed }) => [styles.stepButton, pressed && { opacity: PRESSED_OPACITY }]}>
        <SymbolView name="chevron.left" size={16} tintColor={t('fg-1')} weight="semibold" />
      </Pressable>
      <View style={styles.stepText}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={1.4} numberOfLines={1} style={[styles.stepTitle, { color: t('fg-0') }]}>
          {title}
        </Text>
        {fresh ? (
          <Text
            accessibilityRole={fresh.tone === 'warn' ? 'alert' : undefined}
            maxFontSizeMultiplier={1.4}
            numberOfLines={1}
            style={[styles.fresh, { color: fresh.tone === 'warn' ? t('status-warn') : t('fg-3') }, MONO_FEATURES]}
          >
            {fresh.label}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onToday}
        accessibilityRole="button"
        accessibilityLabel="Today"
        accessibilityState={{ disabled: atToday }}
        style={({ pressed }) => [styles.todayButton, { borderColor: t('border') }, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text maxFontSizeMultiplier={1.3} style={[styles.todayLabel, { color: atToday ? t('fg-4') : t('accent') }]}>Today</Text>
      </Pressable>
      <Pressable onPress={() => onStep(1)} accessibilityRole="button" accessibilityLabel="Next" style={({ pressed }) => [styles.stepButton, pressed && { opacity: PRESSED_OPACITY }]}>
        <SymbolView name="chevron.right" size={16} tintColor={t('fg-1')} weight="semibold" />
      </Pressable>
    </View>
  );
}

export default function CalendarScreen({ now: fixedNow }: { now?: Date }) {
  // Pushed detail route: the tab bar drops while this screen is focused.
  useHideTabBar();
  const { t } = useTheme();
  const now = fixedNow ?? new Date();
  const today = isoDate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const [view, setView] = useState<CalendarView>(() => remembered?.view ?? 'agenda');
  const [anchor, setAnchor] = useState(() => remembered?.anchor ?? today);
  const [open, setOpen] = useState<WireEvent | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const queryClient = useQueryClient();

  // A day he stepped to on purpose is his; a day that was merely "today"
  // follows the clock, so a night in the background does not show yesterday
  // as today.
  const lastToday = useRef(today);
  useEffect(() => {
    if (lastToday.current !== today) {
      if (anchor === lastToday.current) setAnchor(today);
      lastToday.current = today;
    }
  }, [today, anchor]);
  useEffect(() => {
    remembered = { view, anchor: anchor === today ? null : anchor };
  }, [view, anchor, today]);

  const calendar = useCalendar(now);
  const data = calendar.data;

  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);
  const days = useMemo(
    () => (data ? toDays(visibleEvents(data.events, showHidden), range.from, range.to, data.weeks) : []),
    [data, range.from, range.to, showHidden],
  );
  const hiddenInRange = useMemo(
    () =>
      data
        ? new Set(toDays(data.events.filter(isHidden), range.from, range.to).flatMap((d) => d.events.map((e) => e.id))).size
        : 0,
    [data, range.from, range.to],
  );

  const syncing = requesting || Boolean(data?.sync_requested_at);
  const syncNow = useCallback(() => {
    setRequesting(true);
    api
      .syncCalendar()
      .then(() => queryClient.invalidateQueries({ queryKey: ['calendar'] }))
      .catch(() => undefined)
      .finally(() => setRequesting(false));
  }, [queryClient]);

  const onEventPress = useCallback((event: ScreenEvent) => setOpen(event.wire), []);
  const onDayPress = useCallback((date: string) => {
    setAnchor(date);
    setView('day');
  }, []);

  const fresh = syncing
    ? { label: SYNCING_NOTE, tone: 'neutral' as const }
    : !data?.synced_at
      ? null
      : data.weeks
        ? freshnessFor(range, data.weeks, now)
        : freshness(data.synced_at, data.stale_slices, now);

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <BackLink />
        <Text accessibilityRole="header" maxFontSizeMultiplier={1.4} style={[styles.title, { color: t('fg-0') }]}>
          Calendar
        </Text>
        <Legend />
        <SyncButton busy={syncing} onPress={syncNow} />
      </View>
      <Switcher view={view} onChange={setView} />
      <Stepper
        title={rangeTitle(view, anchor)}
        fresh={fresh}
        atToday={anchor === today}
        onStep={(dir) => setAnchor((a) => step(view, a, dir))}
        onToday={() => setAnchor(today)}
      />
    </View>
  );

  let body: React.ReactNode;
  if (calendar.isLoading) {
    body = <SkeletonRows rows={5} />;
  } else if (!data) {
    body = <StatePanel tone="error" title="Calendar unavailable" detail={calendar.error?.message ?? 'hub-api unreachable'} />;
  } else if (!data.synced_at || !data.window) {
    body = <StatePanel title="Not synced yet" detail="The first sync reads nine weeks from both calendars and takes about half an hour." />;
  } else {
    body = (
      <>
        {calendar.isError ? (
          <Text accessibilityRole="alert" style={[styles.offline, { color: t('status-warn') }, MONO_FEATURES]}>
            {OFFLINE_NOTE}
          </Text>
        ) : null}
        <HiddenLine count={hiddenInRange} shown={showHidden} onToggle={() => setShowHidden((v) => !v)} />
        {coverage(range, data.window) === 'out' ? (
          <StatePanel title="Outside the synced range" detail={`The calendar is synced ${windowLabel(data.window)}. Nothing is known about this date.`} />
        ) : (
          <>
            {view === 'agenda' ? <AgendaView days={days} today={today} nowMin={nowMin} onEventPress={onEventPress} /> : null}
            {view === 'day' ? <DayView day={days[0]} today={today} nowMin={nowMin} onEventPress={onEventPress} /> : null}
            {view === 'week' ? <WeekView days={days} today={today} nowMin={nowMin} onEventPress={onEventPress} onDayPress={onDayPress} /> : null}
            {view === 'month' ? (
              <MonthView days={days} today={today} nowMin={nowMin} selected={anchor} onSelect={setAnchor} onEventPress={onEventPress} />
            ) : null}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <Screen gutter={false} header={header} refreshing={calendar.isFetching} onRefresh={() => void calendar.refetch()}>
        <View style={styles.body}>{body}</View>
      </Screen>
      <EventSheet event={open} onClose={() => setOpen(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: SCREEN_GUTTER, paddingBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 36, paddingRight: 4 },
  backLinkLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  title: { flex: 1, fontFamily: fonts.sans(620), fontSize: 20, letterSpacing: -0.4 },
  legend: { flexDirection: 'row', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2, borderLeftWidth: 2 },
  legendLabel: { fontFamily: fonts.mono(400), fontSize: 10 },
  switcher: { flexDirection: 'row', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 3, marginTop: 8 },
  segment: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segmentLabel: { fontSize: 13 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  stepButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  stepText: { flex: 1, minWidth: 0, alignItems: 'center' },
  stepTitle: { fontFamily: fonts.sans(600), fontSize: 15 },
  fresh: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 1 },
  todayButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth },
  todayLabel: { fontFamily: fonts.sans(560), fontSize: 12.5 },
  body: { paddingHorizontal: SCREEN_GUTTER, paddingTop: 4 },
  offline: { fontFamily: fonts.mono(400), fontSize: 11, marginBottom: 12 },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: 10,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  syncLabel: { fontFamily: fonts.sans(560), fontSize: 12.5 },
  hiddenLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
  hiddenText: { flexShrink: 1, fontFamily: fonts.mono(400), fontSize: 10.5 },
  hiddenToggle: { fontFamily: fonts.sans(560), fontSize: 12.5 },
});
