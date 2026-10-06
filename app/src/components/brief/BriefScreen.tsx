// The daily brief as a native screen: one scroll whose texture thins as
// urgency drops (spec §1.2). Not 44 rounded cards — that is the failure mode
// the old web brief had, and the reason the user stopped reading it.
//
// Body of app/(home)/brief.tsx. Lives here so jest can render it (testMatch is
// `src/**`), same as DecisionsScreen.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { api } from '../../lib/api';
import { registerForBrief } from '../../lib/push';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SCREEN_GUTTER,
  SkeletonRows,
  StatePanel,
  useHideTabBar,
} from '../shell';
import { BriefRow, isSwipeable, type RowDensity } from './BriefRow';
import { BucketHead } from './BucketHead';
import { HeldBackSheet } from './HeldBackSheet';
import { ItemSheet } from './ItemSheet';
import { NowBlock } from './NowBlock';
import { RulesSheet } from './RulesSheet';
import { SourceBanner } from './SourceBanner';
import { SwipeRow } from './SwipeRail';
import { Terminus } from './Terminus';
import { UndoRow } from './UndoRow';
import { useBriefActions } from './useBriefActions';
import {
  BRIEF_BUCKETS,
  bucketEmptyCopy,
  bucketView,
  dateLine,
  emptyCopy,
  isEmpty,
  staleServedLabel,
  type Brief,
  type BriefBucket,
  type BriefItem,
} from './briefModel';

const ROW_DENSITY: Record<Exclude<BriefBucket, 'now'>, RowDensity> = {
  today: 'today',
  week: 'week',
  background: 'background',
};

/** `‹ Home` — this screen's own back affordance, mirroring config/parts.tsx's
 * BackLink: every other pushed route ports the PWA's back idiom as content,
 * and the brief was the one screen relying on the edge-swipe alone (H4). */
function BriefBackLink() {
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

/** A real page title (H4) — the date drops to a subtitle underneath it — plus
 * the refresh control. Sticky, because Screen's header slot is. */
function BriefHeader({
  date,
  stale,
  query,
}: {
  date: string;
  stale: string | null;
  query: { isFetching: boolean; dataUpdatedAt: number; refetch: () => unknown };
}) {
  const { t } = useTheme();
  return (
    <View style={styles.header}>
      <BriefBackLink />
      <PageTitle right={<RefreshControl queries={query} />}>Today’s brief</PageTitle>
      <View style={styles.headerText}>
        <Text maxFontSizeMultiplier={1.6} style={[styles.date, { color: t('fg-4') }]}>
          {dateLine(date)}
        </Text>
        {stale ? (
          <Text
            accessibilityRole="alert"
            maxFontSizeMultiplier={1.6}
            style={[styles.staleDate, { color: t('status-warn') }]}
          >
            {stale}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export default function BriefScreen() {
  // Pushed detail route: the tab bar drops while this screen is focused.
  useHideTabBar();
  const { t } = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  const queryClient = useQueryClient();
  const brief = usePoll(['brief'], () => api.brief(), QUERY_TUNING.brief);
  const data = brief.data;

  // The push ask, once, HERE rather than at launch: iOS grants exactly one
  // chance and a denial is permanent, so it is worth spending only when the
  // thing being offered — this screen — is already in front of him. Fire and
  // forget: registerForBrief swallows its own failures, remembers a denial,
  // and reaches the Face ID gate only when the Expo token changed (F1); every
  // other open is a local no-op.
  useEffect(() => {
    void registerForBrief();
  }, []);

  const [open, setOpen] = useState<BriefItem | null>(null);
  const [heldBackOpen, setHeldBackOpen] = useState(false);
  const [teachOpen, setTeachOpen] = useState(false);

  const refetchBrief = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['brief'] });
  }, [queryClient]);

  const actions = useBriefActions({ brief: data, onSettled: refetchBrief });

  // One row at a time may be open or armed. Scrolling disarms everything —
  // an armed Done left behind a scroll is a mis-tap waiting to happen.
  const onScrollBeginDrag = useCallback(() => actions.disarmAll(), [actions]);

  const sections = useMemo(() => {
    if (!data) return [];
    return BRIEF_BUCKETS.map((bucket) => ({ bucket, items: bucketView(data, bucket) })).filter(
      // An empty FYI list is noise: Background is omitted entirely rather than
      // given a "nothing here" line of its own (spec §4.1).
      ({ bucket, items }) => items.length > 0 || bucketEmptyCopy(bucket) !== null,
    );
  }, [data]);

  if (brief.isLoading) {
    return (
      <Screen
        gutter={false}
        header={<BriefHeader date="" stale={null} query={brief} />}
        refreshing={brief.isFetching}
        onRefresh={refetchBrief}
      >
        <View style={styles.gutter}>
          {/* A Now-height block plus four row-height bars — never a bare
              spinner, so the screen mounts with the geometry it will keep. */}
          <SkeletonRows rows={5} />
        </View>
      </Screen>
    );
  }

  if (brief.isError || !data) {
    return (
      <Screen
        gutter={false}
        header={<BriefHeader date="" stale={null} query={brief} />}
        refreshing={brief.isFetching}
        onRefresh={refetchBrief}
      >
        <View style={styles.gutter}>
          <StatePanel
            tone="error"
            title="Couldn’t read today’s brief"
            detail={brief.error?.message ?? 'hub-api unreachable'}
          />
        </View>
      </Screen>
    );
  }

  const empty = isEmpty(data);
  const copy = emptyCopy(data);

  // A FLAT child list, not sections wrapped in Views: stickyHeaderIndices
  // addresses direct children of the ScrollView, so a wrapper per bucket would
  // silently stop the heads sticking. The banner element is always pushed even
  // when it renders null, so the indices below stay stable.
  const children: React.ReactNode[] = [<SourceBanner key="banner" brief={data} />];
  const stickyHeaderIndices: number[] = [];

  if (empty) {
    children.push(
      copy.tone === 'degraded' ? (
        // Genuinely a fault, and reads like one — the app's error idiom
        // (spec §4.1, H13): a missing input is not a quiet day.
        <View key="empty" style={styles.gutter}>
          <StatePanel tone="error" title={copy.title} detail={copy.detail} />
        </View>
      ) : (
        // A calm day is the most common state of a working brief, so it gets
        // the screen's own prose, not the shell's card chrome — no border, no
        // fill, no radius, the same rule the owner set for the Home card
        // title: a label reads as a label, not as a system notice (H13).
        <View key="empty" style={styles.emptyDay}>
          <Text style={[styles.emptyTitle, { color: t('fg-0') }]}>{copy.title}</Text>
          <Text style={[styles.emptyDetail, { color: t('fg-2') }]}>{copy.detail}</Text>
        </View>
      ),
    );
  } else {
    for (const { bucket, items } of sections) {
      stickyHeaderIndices.push(children.length);
      children.push(<BucketHead key={`head-${bucket}`} bucket={bucket} count={items.length} />);
      if (items.length === 0) {
        children.push(
          <Text key={`empty-${bucket}`} style={[styles.sectionEmpty, { color: t('fg-2') }]}>
            {bucketEmptyCopy(bucket)}
          </Text>,
        );
      } else {
        items.forEach((item, i) => {
          children.push(
            <BriefItemSlot
              key={item.item_id}
              item={item}
              bucket={bucket}
              last={i === items.length - 1}
              actions={actions}
              onOpen={() => setOpen(item)}
            />,
          );
        });
      }
    }
  }
  children.push(
    <Terminus
      key="terminus"
      brief={data}
      onHeldBack={() => setHeldBackOpen(true)}
      onTeach={() => setTeachOpen(true)}
    />,
  );

  return (
    <>
      <Screen
        gutter={false}
        scrollRef={scrollRef}
        onScrollBeginDrag={onScrollBeginDrag}
        stickyHeaderIndices={stickyHeaderIndices}
        header={<BriefHeader date={data.date} stale={staleServedLabel(data)} query={brief} />}
        refreshing={brief.isFetching}
        onRefresh={refetchBrief}
        // One opaque ground for the whole list rather than a per-row fill
        // (H9): Background rows and the terminus never wrap in SwipeRow, so a
        // per-row fill left the corner wash showing through them while every
        // swipeable row painted over it — a hard edge that moved as you
        // scrolled.
        contentStyle={{ backgroundColor: t('bg-0') }}
      >
        {children}
      </Screen>

      <ItemSheet
        item={open}
        brief={data}
        onClose={() => setOpen(null)}
        onOpenRelated={(next) => setOpen(next)}
        actions={actions}
      />
      <HeldBackSheet
        brief={data}
        visible={heldBackOpen}
        onClose={() => setHeldBackOpen(false)}
      />
      <RulesSheet visible={teachOpen} onClose={() => setTeachOpen(false)} />
    </>
  );
}

/**
 * One item's slot in the list: the row, or the undo line that has taken its
 * place. The slot is what makes undo "in place" — the shell's Toast is
 * pointerEvents="none" and cannot host a button (spec §8.1).
 *
 * Wrapped in React.memo with a custom comparator (H6): `actions` is a fresh
 * object on every BriefScreen render — useBriefActions.ts doesn't memoize its
 * return value, and that file is task U's, not ours to change — but every
 * method on it except `rowState` is itself useCallback-stable there, and
 * `rowState`'s only job here is read through the comparator below. So a
 * "stale" `actions` reference is never actually stale in a way that matters,
 * and the comparator re-derives each side's row state directly (one Map
 * lookup) instead of trusting prop identity. That is what lets one row's
 * swipe skip re-rendering the other 40-120 rows and their gestures, without
 * touching useBriefActions.ts at all.
 */
const BriefItemSlot = memo(function BriefItemSlot({
  item,
  bucket,
  last,
  actions,
  onOpen,
}: {
  item: BriefItem;
  bucket: BriefBucket;
  last: boolean;
  actions: ReturnType<typeof useBriefActions>;
  onOpen: () => void;
}) {
  const state = actions.rowState(item.item_id);

  if (state.phase === 'undo') {
    return (
      <UndoRow
        label={state.undoLabel}
        onUndo={() => actions.undo(item)}
        last={last}
        // Chips only after a Done — a snooze is "not now", not "not mine"
        // (Ruling 146).
        reason={
          state.action === 'dismiss'
            ? { explained: state.explained, onExplain: (code) => actions.explain(item, code) }
            : undefined
        }
      />
    );
  }

  if (bucket === 'now') {
    return (
      <SwipeRow item={item} actions={actions} enabled>
        <NowBlock
          item={item}
          onPress={onOpen}
          failure={state.failure}
          last={last}
          accessibilityActions={actions.rotorActions(item)}
          onAccessibilityAction={(e) => actions.onRotorAction(item, e.nativeEvent.actionName, onOpen)}
        />
      </SwipeRow>
    );
  }

  const density = ROW_DENSITY[bucket];
  const row = (
    <BriefRow
      item={item}
      density={density}
      onPress={onOpen}
      failure={state.failure}
      last={last}
      accessibilityActions={isSwipeable(density) ? actions.rotorActions(item) : undefined}
      onAccessibilityAction={
        isSwipeable(density)
          ? (e) => actions.onRotorAction(item, e.nativeEvent.actionName, onOpen)
          : undefined
      }
    />
  );

  if (!isSwipeable(density)) return row;
  return (
    <SwipeRow item={item} actions={actions} enabled>
      {row}
    </SwipeRow>
  );
},
(prev, next) => {
  if (prev.item !== next.item || prev.bucket !== next.bucket || prev.last !== next.last) {
    return false;
  }
  const prevState = prev.actions.rowState(prev.item.item_id);
  const nextState = next.actions.rowState(next.item.item_id);
  // Every field of RowState the slot renders, or a change the comparator
  // cannot see silently freezes the row: tapping a why chip moves only
  // `explained`, and the row went on showing "why?" until this line existed.
  return (
    prevState.phase === nextState.phase &&
    prevState.failure === nextState.failure &&
    prevState.undoLabel === nextState.undoLabel &&
    prevState.action === nextState.action &&
    prevState.explained === nextState.explained
  );
});

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: SCREEN_GUTTER,
    paddingBottom: 10,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    minHeight: 32,
    marginBottom: 4,
  },
  backLinkLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  headerText: { flexShrink: 1, minWidth: 0 },
  date: { fontFamily: fonts.mono(400), fontSize: 11 },
  staleDate: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 3 },
  gutter: { paddingHorizontal: SCREEN_GUTTER },
  emptyDay: { paddingHorizontal: SCREEN_GUTTER, paddingTop: 24 },
  emptyTitle: { fontFamily: fonts.sans(620), fontSize: 18, letterSpacing: -0.36 },
  emptyDetail: { fontFamily: fonts.sans(400), fontSize: 14, marginTop: 5 },
  sectionEmpty: {
    fontFamily: fonts.sans(400),
    fontSize: 14,
    paddingHorizontal: SCREEN_GUTTER,
    paddingVertical: 14,
  },
});
