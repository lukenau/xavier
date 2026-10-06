// The Feed screen body, shared by both of its routes, ported from
// apps/hub/src/routes/Feed.tsx (docs/inventory/feed.md §1).
//
// The Feed is what replaced Chat: Xavier writes here (briefs, run outputs,
// alerts), the user reads here. Conversation stays on Telegram; artifacts land in
// this reverse-chron inbox. Briefs open in the locked-down brief reader —
// agent-generated HTML is built from untrusted inputs and never runs script
// with the hub's credentials.
//
// Feed stopped being a tab (design spec §Locked decisions 3) and is reached
// from two places: a push on the Home stack (/feed, from XavierCard and
// PagesShelf) and a push on the Ops stack (/ops/feed, the Ops row). They are
// two route files because each must live on its own stack — pushing the Home
// route from Ops would switch tabs — but they must never become two screens,
// so the body lives here and both routes re-export it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { FeedItem } from '../../lib/types';
import { relTime } from '../../shared/time';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { openBrief, resolveBriefUri } from '../briefs';
import {
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SkeletonCard,
  StatePanel,
  useHideTabBar,
} from '../shell';
import { FeedCard } from './FeedCard';
import { FeedDetailSheet } from './FeedDetailSheet';
import { emptyTitle, FILTERS, filterItems, type FeedFilter } from './feedModel';
import { readFeedSeenTs, writeFeedSeenTs } from './feedSeen';

const EMPTY_DETAIL = "Xavier's briefs, run outputs, and alerts land here as they're generated.";

export default function FeedScreen() {
  // Pushed detail route on both stacks: the tab bar drops while it is focused.
  useHideTabBar();
  const { t } = useTheme();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [open, setOpen] = useState<FeedItem | null>(null);
  // null = the stored value has not arrived yet, so nothing is "new" — see
  // feedSeen.ts for why this is the closest reproduction of the PWA's
  // synchronous read that AsyncStorage allows.
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const seenRead = useRef<Promise<number> | null>(null);

  const feed = usePoll(['feed'], api.feed, QUERY_TUNING.feed);

  // Feed.tsx:119 — read ONCE per mount and never updated again. Items that
  // arrive during this mount keep their dot until the screen remounts; that is
  // the PWA's behaviour (PARITY-INVENTORY OQ-16) and is reproduced, not fixed.
  useEffect(() => {
    const read = readFeedSeenTs();
    seenRead.current = read;
    let cancelled = false;
    read.then((value) => {
      if (!cancelled) setLastSeen(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Feed.tsx:123-126 — the newest ts, unfiltered, on every data load. Chained
  // behind the read so a cached first payload cannot clobber the value the
  // read is still fetching (the PWA gets that ordering for free).
  useEffect(() => {
    const top = feed.data?.items[0]?.ts;
    if (!top) return;
    void (seenRead.current ?? Promise.resolve(0)).then(() => writeFeedSeenTs(top));
  }, [feed.data]);

  const items = useMemo(() => filterItems(feed.data?.items ?? [], filter), [feed.data, filter]);
  const status = feed.data?.status_line;

  function onOpen(item: FeedItem) {
    if (item.kind === 'brief') {
      // The PWA's `open.kind === 'brief' && safeHref(open.link)` branch. The
      // gate is resolveBriefUri, not safeHref: a brief's HTML is rendered, so
      // it must come from the hub origin (task-19-report.md's security round).
      // A brief whose link fails that falls through to the text sheet, exactly
      // as a brief with an unparsable link does in the PWA.
      const uri = resolveBriefUri(item.link);
      if (uri) {
        openBrief(uri, item.title);
        return;
      }
    }
    setOpen(item);
  }

  return (
    <>
      <Screen header={<PageTitle right={<RefreshControl queries={[feed]} />}>Feed</PageTitle>}>
        <View style={styles.chipRow}>
          {FILTERS.map((f) => {
            const active = f.id === filter;
            return (
              <Pressable
                key={f.id}
                accessibilityRole="button"
                accessibilityLabel={f.label}
                accessibilityState={{ selected: active }}
                onPress={() => setFilter(f.id)}
                style={({ pressed }) => [
                  styles.chip,
                  {
                    backgroundColor: t(active ? 'accent-soft' : 'bg-1'),
                    borderColor: t(active ? 'accent-border' : 'border'),
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={[styles.chipLabel, { color: t(active ? 'accent' : 'fg-3') }]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {status ? (
          <View
            style={[
              styles.statusCard,
              { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
            ]}
          >
            <Text style={[styles.statusWho, { color: t('accent') }]}>xavier</Text>
            <Text style={[styles.statusText, { color: t('fg-1') }]}>{status.text}</Text>
            <Text style={[styles.statusAge, { color: t('fg-4') }]}>{relTime(status.ts)}</Text>
          </View>
        ) : null}

        {feed.isLoading && !feed.data ? <SkeletonCard height={220} /> : null}
        {feed.isError ? (
          <StatePanel tone="error" title="Feed unavailable" detail={feed.error?.message} />
        ) : null}
        {feed.data && items.length === 0 ? (
          <StatePanel tone="neutral" title={emptyTitle(filter)} detail={EMPTY_DETAIL} />
        ) : null}
        {items.map((item) => (
          <FeedCard
            key={item.id}
            item={item}
            isNew={lastSeen !== null && item.ts > lastSeen}
            onOpen={onOpen}
          />
        ))}
      </Screen>

      <FeedDetailSheet item={open} onClose={() => setOpen(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  chip: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginBottom: 12,
  },
  statusWho: {
    flexShrink: 0,
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  statusText: { flex: 1, minWidth: 0, fontFamily: fonts.sans(400), fontSize: 13 },
  statusAge: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10, ...MONO_FEATURES },
});
