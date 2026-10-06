// Home — 1:1 port of apps/hub/src/routes/Home.tsx (docs/inventory/home.md).
//
// Home answers three questions in five seconds: is Xavier alive, what did he
// make for me today, does anything need me. Everything else lives in a tab.
//
// Two native-only pieces, both deliberate:
//   • MoneyEntryCard — Money is no longer a tab, so Home carries the door.
//   • the gate toast — the Oura sync's write gate is not wired yet (Task 21),
//     and a tap that silently does nothing is worse than one that says why.
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Screen, SkeletonCard, Toast } from '../../src/components/shell';
import {
  AttentionChips,
  BriefCard,
  BrowserCard,
  CalendarCard,
  DecisionsBanner,
  DiscordRow,
  Header,
  MoneyEntryCard,
  OuraRow,
  PagesShelf,
  Rise,
  SpendCard,
  XavierCard,
  failedRunCount,
} from '../../src/components/home';
import { useCalendar } from '../../src/components/calendar/useCalendar';
import { api } from '../../src/lib/api';
import { QUERY_TUNING, usePoll } from '../../src/lib/query';
import { fonts } from '../../src/theme/fonts';
import { useTheme } from '../../src/theme/useTheme';

export default function HomeScreen() {
  const { t } = useTheme();
  const [gateError, setGateError] = useState<string | null>(null);

  const health = usePoll(['health'], api.health, QUERY_TUNING.health);
  const vitals = usePoll(['vitals'], api.vitals, QUERY_TUNING.vitals);
  const sessions = usePoll(['sessions'], api.sessions, QUERY_TUNING['sessions-home']);
  const pairing = usePoll(['pairing'], api.pairing, QUERY_TUNING['pairing-home']);
  const runs = usePoll(['cron-logs'], () => api.cronLogs(15), QUERY_TUNING['cron-logs-home']);
  const backups = usePoll(['backups'], api.backups, QUERY_TUNING.backups);
  // The Oura row needs a page and a sync job this repository does not ship; show
  // it only where that job exists.
  const cron = usePoll(['cron'], api.cron, QUERY_TUNING.cron);
  const myPages = usePoll(['my-pages'], api.myPages, QUERY_TUNING['my-pages-home']);
  const spendToday = usePoll(
    ['spend-timeseries', 'today'],
    () => api.spendTimeseries('today'),
    QUERY_TUNING['spend-timeseries-home-today'],
  );
  const spendTodaySummary = usePoll(
    ['spend-summary', 'today'],
    () => api.spendSummary('today'),
    QUERY_TUNING['spend-summary-home-today'],
  );
  const spendMtd = usePoll(
    ['spend-summary', 'mtd'],
    () => api.spendSummary('mtd'),
    QUERY_TUNING['spend-summary-home-mtd'],
  );
  const decisions = usePoll(['decisions'], api.decisions, QUERY_TUNING['decisions-shared']);
  // MoneyEntryCard's number. Same key and tuning the Money screen uses, so the
  // two share one cache entry rather than double-polling /finance.
  const finance = usePoll(['finance'], api.finance, QUERY_TUNING.finance);
  // The same ['calendar'] key the calendar screen reads, so opening it is instant.
  const now = new Date();
  const calendar = useCalendar(now);

  return (
    <>
      <Screen
        header={
          <Rise index={0}>
            <Header health={health.data} now={new Date()} busy={vitals.data?.agent.busy ?? false} />
          </Rise>
        }
      >
        <Rise index={1}>
          <DecisionsBanner decisions={decisions.data?.open ?? []} />
        </Rise>

        <Rise index={1}>
          {vitals.isLoading && !vitals.data ? (
            <SkeletonCard height={150} />
          ) : (
            <XavierCard
              vitals={vitals.data}
              sessions={sessions.data}
              pairing={pairing.data}
              runs={runs.data}
            />
          )}
        </Rise>

        <Rise index={2}>
          <BrowserCard />
        </Rise>

        <Rise index={2}>
          <BriefCard />
        </Rise>

        <Rise index={2}>
          <CalendarCard data={calendar.data} now={now} />
        </Rise>

        {/* The two cockpit doors sit together: money, then health. */}
        <Rise index={3}>
          <MoneyEntryCard finance={finance.data} />
        </Rise>

        {cron.data?.jobs.some((j) => j.name === 'oura-sync') ? (
          <Rise index={3}>
            <OuraRow onGateError={setGateError} />
          </Rise>
        ) : null}

        <Rise index={3}>
          {/* Complete library — yes, today's brief appears in both: the card is
              "read this now", the shelf is "everything he's published". */}
          <PagesShelf pages={myPages.data?.pages} />
        </Rise>

        <Rise index={5}>
          <DiscordRow sessions={sessions.data} />
        </Rise>

        <Rise index={6}>
          {spendToday.isLoading && !spendToday.data ? (
            <SkeletonCard height={100} />
          ) : spendToday.isError ? (
            <Text style={[styles.spendError, { color: t('fg-4') }]}>
              spend unavailable — {spendToday.error.message}
            </Text>
          ) : (
            <SpendCard
              today={spendToday.data}
              mtd={spendMtd.data}
              todaySummary={spendTodaySummary.data}
            />
          )}
        </Rise>

        <Rise index={7}>
          <AttentionChips
            health={health.data}
            backups={backups.data}
            failedRuns={failedRunCount(runs.data)}
          />
        </Rise>
      </Screen>
      {gateError ? (
        <Toast kind="err" variant="config" text={gateError} onDone={() => setGateError(null)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  spendError: { fontFamily: fonts.mono(400), fontSize: 12, paddingVertical: 6, paddingHorizontal: 2 },
});
