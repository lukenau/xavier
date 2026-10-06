// 1:1 port of apps/hub/src/routes/config/ConfigHome.tsx — the Config tab root.
//
// ONE list, one mental model: every group row links to its settings page
// (/config/g/:id) and the live special pages ride INSIDE the group they serve —
// labelled by what they DO ('Memory status · live') so they never collide with
// the group's settings. The list is static structure + live counts, so the
// special pages stay reachable even while the config tree is loading or down.
//
// Two PWA pieces are absent by construction, not by omission:
//   • the `api.mode === 'mock'` pill — hub-app has no mock mode (api.ts's
//     header, "Two deliberate departures"), so there is no state to render.
//   • the gateway confirm <Sheet> — natively a sheet is a route, so it lives
//     at app/(home)/config/gateway.tsx and this screen only pushes it.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { PageTitle, PRESSED_OPACITY, Screen, SectionHead, StatePanel, useHideTabBar } from '../shell';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { CONFIG_GROUPS, PAGE_ROWS, configGroupOf } from './groups';
import { ChevronRight, HomeLink } from './parts';
import { ThemeToggle } from './ThemeToggle';
import { WhimsyToggle } from '../../whimsy';

function GroupRow({
  label,
  sub,
  count,
  href,
  isLast,
}: {
  label: string;
  sub: string;
  count: string;
  href: string;
  isLast: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="link"
      style={({ pressed }) => [
        styles.groupRow,
        isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.groupLabel, { color: t('fg-0') }]}>
          {label}
        </Text>
        <Text style={[styles.rowSub, { color: t('fg-3') }]}>{sub}</Text>
      </View>
      <Text style={[styles.count, { color: t('fg-4') }]}>{count}</Text>
      <ChevronRight />
    </Pressable>
  );
}

function PageRow({ label, sub, href, isLast }: { label: string; sub: string; href: string; isLast: boolean }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="link"
      style={({ pressed }) => [
        styles.pageRow,
        isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.pageLabel, { color: t('fg-1') }]}>
          {label}
        </Text>
        <Text style={[styles.rowSub, { color: t('fg-3') }]}>{sub}</Text>
      </View>
      <ChevronRight />
    </Pressable>
  );
}

function GatewayButton({ label, action }: { label: string; action: 'restart' | 'drain' }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/config/gateway', params: { action } })}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.gatewayButton,
        { backgroundColor: t('bg-1'), borderColor: t('border-strong') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.gatewayLabel, { color: t('fg-1') }]}>{label}</Text>
    </Pressable>
  );
}

export function ConfigHome() {
  // A push on the Home stack since 2026-09-29, no longer a tab root.
  useHideTabBar();
  const cfg = usePoll(['config-full'], api.configFull, QUERY_TUNING['config-full']);

  // Live leaf counts per group (unknown sections roll into 'misc').
  const counts = new Map<string, number>();
  for (const s of cfg.data?.sections ?? []) {
    const gid = configGroupOf(s.id);
    counts.set(gid, (counts.get(gid) ?? 0) + s.leaves.length);
  }

  return (
    <Screen
      header={
        <>
          <HomeLink />
          <PageTitle>Config</PageTitle>
        </>
      }
    >
      {/* Everything below is Xavier's server config. Appearance is a viewer
          preference for this device only, so it gets its own heading rather
          than being filed among gateway keys. */}
      <SectionHead label="This device" />
      <View style={styles.themeSlot}>
        <ThemeToggle />
      </View>
      <PageRow
        label="Server address"
        sub="which hub this build talks to"
        href="/config/server"
        isLast={false}
      />
      <SectionHead label="Xavier" />
      <View style={styles.themeSlot}>
        <WhimsyToggle />
      </View>

      <SectionHead label="Settings" count={cfg.data ? `${cfg.data.leaf_count} keys` : ''} />
      {cfg.isError ? (
        <View style={styles.errorSlot}>
          <StatePanel tone="error" title="Config unavailable" detail={cfg.error?.message ?? ''} />
        </View>
      ) : null}
      <View style={styles.list}>
        {CONFIG_GROUPS.map((g, gi) => {
          const pages = PAGE_ROWS[g.id] ?? [];
          const lastGroup = gi === CONFIG_GROUPS.length - 1;
          return (
            <View key={g.id}>
              <GroupRow
                label={g.label}
                sub={g.sub}
                count={counts.get(g.id) ? `${counts.get(g.id)}` : ''}
                href={`/config/g/${g.id}`}
                isLast={lastGroup && pages.length === 0}
              />
              {pages.map((p, pi) => (
                <PageRow
                  key={p.href}
                  label={p.label}
                  sub={p.sub}
                  href={p.href}
                  isLast={lastGroup && pi === pages.length - 1}
                />
              ))}
            </View>
          );
        })}
      </View>

      <SectionHead label="Gateway" />
      <View style={styles.gatewayRow}>
        <GatewayButton label="Restart gateway" action="restart" />
        <GatewayButton label="Drain" action="drain" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  themeSlot: { marginBottom: 18 },
  list: { flexDirection: 'column', marginBottom: 16 },
  errorSlot: { marginBottom: 12 },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 56,
    paddingVertical: 9,
  },
  pageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 50,
    paddingVertical: 8,
    paddingLeft: 14,
  },
  rowText: { flex: 1, minWidth: 0 },
  groupLabel: { fontFamily: fonts.sans(550), fontSize: 15 },
  pageLabel: { fontFamily: fonts.sans(500), fontSize: 14 },
  rowSub: { fontFamily: fonts.sans(400), fontSize: 12 },
  count: { fontFamily: fonts.mono(400), fontSize: 11, flexShrink: 0, ...MONO_FEATURES },
  gatewayRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  gatewayButton: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gatewayLabel: { fontFamily: fonts.sans(550), fontSize: 13 },
});
