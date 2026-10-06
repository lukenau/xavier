// 1:1 port of apps/hub/src/routes/config/ConnectorsPage.tsx — provider
// credentials and MCP server auth, read from `hermes auth list` /
// `hermes mcp list` via the CLI-bridge.
//
// Both sheets it opens (the read-only provider detail, and the device-code
// flow) are routes here rather than in-page components: /config/connector and
// /config/device-code, pushed with the provider id and re-read from the shared
// ['connectors'] cache entry on the other side.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SectionHead,
  StatePanel,
  useHideTabBar,
} from '../shell';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { ConnectorProvider, ConnectorsReport } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { BackLink, ConfigCard } from './parts';
import { connectedCount, isMcpBroken, mcpStatusLabel, providerSub, usesDeviceCode } from './connectors';

function StatusDot({ on }: { on: boolean }) {
  const { t } = useTheme();
  return <View style={[styles.dot, { backgroundColor: on ? t('status-up') : t('fg-4') }]} />;
}

function ProviderRow({ provider, isLast }: { provider: ConnectorProvider; isLast: boolean }) {
  const { t } = useTheme();
  const border = isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') };
  const inner = (
    <>
      <StatusDot on={provider.connected} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.providerName, { color: t('fg-0') }]}>
          {provider.name}
        </Text>
        <Text numberOfLines={1} style={[styles.providerSub, { color: t('fg-3') }]}>
          {providerSub(provider)}
        </Text>
      </View>
    </>
  );

  if (usesDeviceCode(provider)) {
    return (
      <View style={[styles.providerRow, border]}>
        {inner}
        <Pressable
          onPress={() => router.push({ pathname: '/config/device-code', params: { id: provider.id } })}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.connectButton,
            { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
            pressed && { opacity: PRESSED_OPACITY },
          ]}
        >
          <Text style={[styles.connectLabel, { color: t('accent') }]}>Connect</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/config/connector', params: { id: provider.id } })}
      accessibilityRole="button"
      style={({ pressed }) => [styles.providerRow, border, pressed && { opacity: PRESSED_OPACITY }]}
    >
      {inner}
      <Text style={[styles.viaTerminal, { color: t('fg-4') }]}>via terminal</Text>
    </Pressable>
  );
}

function McpRow({ row, isLast }: { row: ConnectorsReport['mcp'][number]; isLast: boolean }) {
  const { t } = useTheme();
  const broken = isMcpBroken(row.status);
  const statusColor = row.status === null ? t('fg-4') : broken ? t('status-down') : t('status-up');
  return (
    <View style={[styles.mcpRow, isLast ? null : { borderBottomWidth: 1, borderBottomColor: t('border') }]}>
      <View style={styles.mcpHead}>
        <StatusDot on={row.connected} />
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={[styles.mcpName, { color: t('fg-0') }]}>
            {row.name}
          </Text>
          <Text numberOfLines={1} style={[styles.providerSub, { color: t('fg-3') }]}>
            {row.transport ?? '—'}
          </Text>
        </View>
        <Text style={[styles.mcpStatus, { color: statusColor }]}>{mcpStatusLabel(row.status)}</Text>
      </View>
      {broken ? (
        <Pressable
          onPress={() => router.push('/ops/terminal')}
          accessibilityRole="link"
          style={({ pressed }) => [pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text numberOfLines={1} style={[styles.reauth, { color: t('accent') }]}>
            {row.reauth_cmd} · run in Terminal
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ConnectorsPage() {
  useHideTabBar();
  const q = usePoll(['connectors'], api.connectors, QUERY_TUNING.connectors);

  const providers = q.data?.providers ?? [];
  const mcp = q.data?.mcp ?? [];

  return (
    <Screen
      header={
        <>
          <BackLink />
          <PageTitle right={<RefreshControl queries={q} />}>Connectors</PageTitle>
        </>
      }
    >
      <SectionHead label="Providers" count={connectedCount(q.data?.providers)} />
      {q.isLoading ? <StatePanel tone="pending" title="Reading connectors…" detail="GET /api/connectors" /> : null}
      {q.isError ? <StatePanel tone="error" title="Connectors unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data && providers.length === 0 ? (
        <StatePanel tone="neutral" title="No providers" detail="No connector providers reported." />
      ) : null}
      {providers.length > 0 ? (
        <ConfigCard style={styles.listCard}>
          {providers.map((p, i) => (
            <ProviderRow key={p.id} provider={p} isLast={i === providers.length - 1} />
          ))}
        </ConfigCard>
      ) : null}

      <SectionHead label="MCP servers" count={connectedCount(q.data?.mcp)} />
      {/* No error panel for this section — q.isError only renders under
          Providers (inventory §13.8), reproduced. */}
      {q.isLoading ? <StatePanel tone="pending" title="Reading MCP servers…" detail="GET /api/connectors" /> : null}
      {q.data && mcp.length === 0 ? (
        <StatePanel tone="neutral" title="No MCP servers" detail="No MCP entries reported." />
      ) : null}
      {mcp.length > 0 ? (
        <ConfigCard style={styles.listCard}>
          {mcp.map((m, i) => (
            <McpRow key={m.name} row={m} isLast={i === mcp.length - 1} />
          ))}
        </ConfigCard>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  listCard: { paddingVertical: 4, marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  rowText: { flex: 1, minWidth: 0 },
  providerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 10 },
  providerName: { fontFamily: fonts.sans(540), fontSize: 15 },
  providerSub: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  viaTerminal: { fontFamily: fonts.mono(400), fontSize: 10.5, flexShrink: 0 },
  connectButton: {
    height: 36,
    minWidth: 44,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  connectLabel: { fontFamily: fonts.sans(600), fontSize: 12.5 },
  mcpRow: { paddingVertical: 11 },
  mcpHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mcpName: { fontFamily: fonts.sans(540), fontSize: 14 },
  mcpStatus: { fontFamily: fonts.mono(400), fontSize: 10.5, flexShrink: 0 },
  reauth: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 6, marginLeft: 18 },
});
