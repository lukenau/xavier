// 1:1 port of apps/hub/src/routes/config/RoutingPage.tsx.
//
// Telegram routing — where scheduled deliveries land in the user's DM topics.
// Reads GET /api/config/topics (canonical config + live-deliver drift rows) and
// saves through the SAME Face-ID gate the other writes use (challenge bound to
// the exact payload → assertion → apply). A save only marks pending_sync; the
// host applier (topic-routing-sync.sh, every 10 min) pushes it into the Hermes
// cron jobs + the approvals secret — the page says so honestly instead of
// pretending the change is instantly live.
//
// The one web primitive with no native twin is the `<select>` (inventory §11.5):
// iOS renders it as a picker tray, and the closest zero-dependency native
// affordance is ActionSheetIOS, which is what the target button opens here.
import { useState } from 'react';
import { ActionSheetIOS, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import {
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SectionHead,
  StatePanel,
  Toast,
  useHideTabBar,
  type ToastKind,
} from '../shell';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { TopicsRouteRow } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  ActionBar,
  BackLink,
  BarCancel,
  GateButton,
  useActionBarClearance,
} from './parts';
import {
  changedEntries,
  footerNote,
  friendly,
  pluralRoutes,
  savePayload,
  stageEdit,
  targetOptions,
  type TargetOption,
} from './routing';
import { isCancelledGateError, routingErrorMessage } from './writeErrors';

const INTRO =
  'Where each scheduled delivery lands — a DM topic, the plain DM, or local-only (Hub feed, no Telegram). Saves apply via Face ID and take effect within 10 minutes.';

function DriftBadge() {
  const { t } = useTheme();
  return (
    <View style={[styles.driftBadge, { backgroundColor: t('status-warn-soft'), borderColor: t('status-warn-soft') }]}>
      <Text style={[styles.driftLabel, { color: t('status-warn') }]}>Drift</Text>
    </View>
  );
}

function RouteRow({
  row,
  value,
  options,
  edited,
  disabled,
  last,
  onChange,
}: {
  row: TopicsRouteRow;
  value: string;
  options: TargetOption[];
  edited: boolean;
  disabled: boolean;
  last: boolean;
  onChange: (target: string) => void;
}) {
  const { t } = useTheme();
  const f = friendly(row.name);
  const showDrift = row.drift === true && !edited;
  const selected = options.find((o) => o.value === value);

  function openPicker() {
    if (disabled) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: f.label,
        options: [...options.map((o) => o.label), 'Cancel'],
        cancelButtonIndex: options.length,
      },
      (index) => {
        if (index < options.length) onChange(options[index].value);
      },
    );
  }

  return (
    <View style={[styles.routeRow, last ? null : { borderBottomWidth: 1, borderBottomColor: t('border') }]}>
      <View style={styles.routeText}>
        <View style={styles.routeTitleRow}>
          <Text numberOfLines={1} style={[styles.routeLabel, { color: t('fg-0') }]}>
            {f.label}
          </Text>
          {showDrift ? <DriftBadge /> : null}
          {edited ? <Text style={[styles.editedLabel, { color: t('accent') }]}>· edited</Text> : null}
        </View>
        <Text numberOfLines={1} style={[styles.routeSub, { color: t('fg-3') }]}>
          {f.sub}
        </Text>
        {showDrift ? (
          <Text numberOfLines={1} style={[styles.liveLine, { color: t('status-warn') }]}>
            live: {row.live_deliver ?? 'unknown'}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={openPicker}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Target for ${f.label}`}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.select,
          {
            backgroundColor: edited ? t('accent-soft') : t('bg-1'),
            borderColor: edited ? t('accent-border') : t('border-strong'),
            opacity: disabled ? 0.6 : 1,
          },
          pressed && !disabled && { opacity: PRESSED_OPACITY },
        ]}
      >
        <Text numberOfLines={1} style={[styles.selectLabel, { color: edited ? t('accent') : t('fg-1') }]}>
          {selected?.label ?? value}
        </Text>
      </Pressable>
    </View>
  );
}

/** Bottom Face-ID save bar — mirrors the ConfigSectionPage ReviewBar. */
function SaveBar({
  count,
  applying,
  onApply,
  onCancel,
}: {
  count: number;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  return (
    <ActionBar>
      <View style={styles.barHead}>
        <View style={styles.barHeadText}>
          <Text style={[styles.barEyebrow, { color: t('fg-3') }]}>Pending routing change</Text>
          <Text numberOfLines={1} style={[styles.barLine, { color: t('fg-0') }]}>
            {pluralRoutes(count, 're-targeted')}
            <Text style={[styles.barLineSuffix, { color: t('fg-3') }]}> · applies within 10 min</Text>
          </Text>
        </View>
        <BarCancel onPress={onCancel} disabled={applying} />
      </View>
      <GateButton
        label={applying ? 'Waiting for Face ID…' : `Save ${count} change${count === 1 ? '' : 's'} · Face ID`}
        busy={applying}
        onPress={onApply}
      />
    </ActionBar>
  );
}

export function RoutingPage() {
  useHideTabBar();
  const { t } = useTheme();
  const qc = useQueryClient();
  const report = usePoll(['topics-routing'], api.topicsConfig, QUERY_TUNING['topics-routing']);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);

  const data = report.data;
  const changed = data ? changedEntries(edits, data.config.routes) : [];
  const dirty = changed.length > 0;
  const driftCount = (data?.routes ?? []).filter((r) => r.drift === true).length;
  const barClearance = useActionBarClearance(dirty);
  const options = data ? targetOptions(data.config.topics) : [];

  function stage(name: string, target: string) {
    if (!data || applying) return;
    setEdits((e) => stageEdit(e, name, target, data.config.routes));
  }

  async function save() {
    if (!data || !dirty || applying) return;
    setApplying(true);
    try {
      await api.saveTopicRouting(savePayload(data.config, changed));
      setEdits({});
      await qc.invalidateQueries({ queryKey: ['topics-routing'] });
      setToast({ kind: 'ok', text: 'Routing saved — the sync applier makes it live within 10 minutes.' });
    } catch (err) {
      // A cancelled Face ID says nothing at all here (OQ-10).
      if (isCancelledGateError(err)) {
        setApplying(false);
        return;
      }
      setToast({ kind: 'err', text: routingErrorMessage(err) });
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <Screen
        contentStyle={barClearance}
        header={
          <>
            <BackLink />
            <PageTitle right={<RefreshControl queries={[report]} />}>Telegram routing</PageTitle>
          </>
        }
      >
        <Text style={[styles.intro, { color: t('fg-2') }]}>{INTRO}</Text>

        {report.isLoading ? (
          <StatePanel tone="pending" title="Reading routing config…" detail="telegram-topics.json · via hub-api" />
        ) : report.isError ? (
          <StatePanel
            tone="error"
            title="Routing config unavailable"
            detail={report.error?.message || 'hub-api unreachable'}
          />
        ) : data ? (
          <>
            {data.pending_sync ? (
              <View style={[styles.notice, { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }]}>
                <Text style={[styles.noticeTitle, { color: t('accent') }]}>Saved — waiting for sync</Text>
                <Text style={[styles.noticeBody, { color: t('fg-2') }]}>
                  The applier picks this up within 10 minutes and pushes it into the cron jobs.
                </Text>
              </View>
            ) : null}
            {driftCount > 0 && !data.pending_sync ? (
              <View
                style={[styles.notice, { backgroundColor: t('status-warn-soft'), borderColor: t('status-warn-soft') }]}
              >
                <Text style={[styles.noticeTitle, { color: t('status-warn') }]}>
                  {pluralRoutes(driftCount, 'drifted')}
                </Text>
                <Text style={[styles.noticeBody, { color: t('fg-2') }]}>
                  Live delivery differs from this config — re-save to reconcile, or wait for the next sync.
                </Text>
              </View>
            ) : null}

            <SectionHead label="Routes" count={`chat ${data.config.chat_id}`} />
            <View style={styles.list}>
              {data.routes.map((row, i) => (
                <RouteRow
                  key={row.name}
                  row={row}
                  value={edits[row.name] ?? row.target}
                  options={options}
                  edited={edits[row.name] !== undefined}
                  disabled={applying}
                  last={i === data.routes.length - 1}
                  onChange={(target) => stage(row.name, target)}
                />
              ))}
            </View>

            <Text style={[styles.footer, { color: t('fg-4') }]}>
              {footerNote(Object.keys(data.config.topics).length, data.live_snapshot_at)}
            </Text>
          </>
        ) : null}
      </Screen>

      {dirty ? (
        <SaveBar count={changed.length} applying={applying} onApply={save} onCancel={() => setEdits({})} />
      ) : null}
      {toast ? <Toast kind={toast.kind} text={toast.text} onDone={() => setToast(null)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  intro: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18.75, marginBottom: 14 },
  notice: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 15, paddingVertical: 12, marginBottom: 14 },
  noticeTitle: { fontFamily: fonts.sans(600), fontSize: 13 },
  noticeBody: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 18, marginTop: 2 },
  list: { flexDirection: 'column', marginBottom: 16 },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 56,
    paddingVertical: 9,
  },
  routeText: { flex: 1, minWidth: 0 },
  routeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  routeLabel: { fontFamily: fonts.sans(550), fontSize: 14.5, flexShrink: 1 },
  routeSub: { fontFamily: fonts.sans(400), fontSize: 12 },
  liveLine: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 2 },
  driftBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1, flexShrink: 0 },
  driftLabel: { fontFamily: fonts.sans(600), fontSize: 10, letterSpacing: 0.1 },
  editedLabel: { fontFamily: fonts.sans(500), fontSize: 11, flexShrink: 0 },
  select: {
    flexShrink: 0,
    maxWidth: 150,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  selectLabel: { fontFamily: fonts.sans(550), fontSize: 13 },
  footer: { fontFamily: fonts.sans(400), fontSize: 11, marginTop: 4, paddingHorizontal: 1 },
  barHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 11 },
  barHeadText: { flex: 1, minWidth: 0 },
  barEyebrow: { fontFamily: fonts.sans(400), fontSize: 11 },
  barLine: { fontFamily: fonts.sans(550), fontSize: 13 },
  barLineSuffix: { fontFamily: fonts.sans(400), fontSize: 11 },
});
