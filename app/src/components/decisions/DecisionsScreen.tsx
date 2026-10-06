// Decision Inbox — every pending decision awaiting the user as an actionable card,
// grouped by stakes ("Needs your answer" first, frozen last). Ported from
// apps/hub/src/routes/Decisions.tsx (docs/inventory/feed.md §2). Card rendering
// and the Face-ID answer flow live in ./DecisionCards.tsx, shared with the
// Money decision sections.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { Decision } from '../../lib/types';
import { relTime } from '../../shared/time';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SectionHead,
  StatePanel,
  Toast,
  useHideTabBar,
} from '../shell';
import { DecisionGroups, useDecisionAnswers } from './DecisionCards';

const INTRO =
  'Everything waiting on you, as cards. Answers apply via Face ID and land in an ' +
  'append-only ledger the agents read — nothing is ever deleted.';

function AnsweredRow({ decision, last }: { decision: Decision; last: boolean }) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const a = decision.answer;
  const optionLabel =
    a?.option_key === 'dismiss'
      ? 'dismissed'
      : (decision.options.find((o) => o.key === a?.option_key)?.label ?? (a?.option_key || 'note'));

  return (
    <View
      style={[
        styles.answeredRow,
        last ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={decision.title}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.answeredHead, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <View style={styles.answeredText}>
          <Text numberOfLines={1} style={[styles.answeredTitle, { color: t('fg-2') }]}>
            {decision.title}
          </Text>
          <Text
            style={[
              styles.answeredOption,
              { color: t(decision.status === 'dismissed' ? 'fg-4' : 'status-up') },
            ]}
          >
            {optionLabel}
            {a?.ts ? ` · ${relTime(a.ts)}` : ''}
          </Text>
        </View>
        <Text style={[styles.answeredChevron, { color: t('fg-4') }]}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.answeredBody}>
          <Text style={[styles.answeredSummary, { color: t('fg-3') }]}>{decision.summary}</Text>
          {a?.note ? (
            <Text style={[styles.answeredNote, { color: t('fg-2') }]}>note: {a.note}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export default function DecisionsScreen() {
  // Pushed detail route: the tab bar drops while this screen is focused.
  useHideTabBar();
  const { t } = useTheme();
  // 60s here; Home/Money observe the SAME ['decisions'] key at 120s
  // (QUERY_TUNING['decisions-shared']), so the effective cadence depends on
  // which screens are mounted — the PWA's behaviour (inventory §2.1 OQ-10).
  const report = usePoll(['decisions'], api.decisions, QUERY_TUNING['decisions-page']);
  const { applying, toast, clearToast, answer } = useDecisionAnswers();

  const data = report.data;

  return (
    <>
      <Screen
        header={<PageTitle right={<RefreshControl queries={[report]} />}>Decisions</PageTitle>}
      >
        <Text style={[styles.intro, { color: t('fg-2') }]}>{INTRO}</Text>

        {report.isLoading ? (
          <StatePanel
            tone="pending"
            title="Reading the decision queue…"
            detail="decisions/*.json · via hub-api"
          />
        ) : report.isError ? (
          <StatePanel
            tone="error"
            title="Decision queue unavailable"
            detail={report.error instanceof Error ? report.error.message : 'hub-api unreachable'}
          />
        ) : data ? (
          <>
            {data.open.length === 0 ? (
              <StatePanel tone="neutral" title="Queue clear" detail="Nothing is waiting on you." />
            ) : (
              <DecisionGroups decisions={data.open} applying={applying} onAnswer={answer} />
            )}

            {data.answered.length > 0 ? (
              <View style={styles.answeredSection}>
                <SectionHead label="Recently answered" count={`${data.answered.length}`} />
                <View>
                  {data.answered.map((d, i) => (
                    <AnsweredRow key={d.id} decision={d} last={i === data.answered.length - 1} />
                  ))}
                </View>
              </View>
            ) : null}

            {data.errors.length > 0 ? (
              <Text style={[styles.errors, { color: t('status-warn') }]}>
                unreadable card file{data.errors.length === 1 ? '' : 's'}: {data.errors.join(', ')}
              </Text>
            ) : null}
          </>
        ) : null}
      </Screen>

      {toast ? <Toast kind={toast.kind} text={toast.text} onDone={clearToast} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: 14, fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18.75 },
  answeredSection: { marginTop: 18 },
  answeredRow: { paddingVertical: 9 },
  answeredHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  answeredText: { flex: 1, minWidth: 0 },
  answeredTitle: { fontFamily: fonts.sans(540), fontSize: 13 },
  answeredOption: { marginTop: 1, fontFamily: fonts.mono(400), fontSize: 10.5 },
  answeredChevron: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10 },
  answeredBody: { marginTop: 5 },
  answeredSummary: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 17.25 },
  answeredNote: { marginTop: 3, fontFamily: fonts.mono(400), fontSize: 11.5, lineHeight: 17.25 },
  errors: { marginTop: 12, fontFamily: fonts.mono(400), fontSize: 10.5 },
});
