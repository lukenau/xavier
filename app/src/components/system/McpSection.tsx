// SystemPanel.tsx:356-400 — MCP connectors. Not collapsible, rows not tappable.
import { StyleSheet, Text, View } from 'react-native';
import { SectionHead, StatePanel } from '../shell';
import { OpsCard } from '../ops/parts';
import { mcpMeta, mcpStatusLabel } from './systemFormat';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

export function McpSection() {
  const { t } = useTheme();
  const q = usePoll(['mcp'], api.mcp, QUERY_TUNING.mcp);
  const servers = q.data?.servers ?? [];

  return (
    <View style={styles.section}>
      <SectionHead label="MCP Connectors" count={q.data ? `${q.data.enabled}/${q.data.count}` : ''} />
      {q.isLoading ? (
        <StatePanel tone="pending" title="Reading connectors…" detail="connector list" />
      ) : null}
      {q.isError ? <StatePanel tone="error" title="MCP unavailable" detail={q.error?.message ?? ''} /> : null}
      {q.data && servers.length === 0 ? (
        <StatePanel tone="neutral" title="No MCP connectors" detail="No MCP servers are configured." />
      ) : null}
      {q.data && servers.length > 0 ? (
        <OpsCard>
          {servers.map((s, i) => (
            <View
              key={s.name}
              style={[
                styles.row,
                i === servers.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
              ]}
            >
              {/* `box-shadow: 0 0 10px var(--status-up-glow)` — an even blur
                  with no offset, which is exactly what a zero-offset RN shadow
                  paints. */}
              <View
                style={[
                  styles.dot,
                  { backgroundColor: s.enabled ? t('status-up') : t('fg-4') },
                  s.enabled ? { shadowColor: t('status-up-glow'), ...styles.glow } : null,
                ]}
              />
              <View style={styles.rowText}>
                <Text style={[styles.name, { color: t('fg-0') }]}>{s.name}</Text>
                <Text style={[styles.meta, { color: t('fg-3') }]} numberOfLines={1} ellipsizeMode="tail">
                  {mcpMeta(s)}
                </Text>
              </View>
              <Text style={[styles.status, { color: s.enabled ? t('status-up') : t('fg-4') }]}>
                {mcpStatusLabel(s)}
              </Text>
            </View>
          ))}
        </OpsCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  rowText: { flex: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  glow: { shadowOpacity: 1, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  name: { fontFamily: fonts.sans(540), fontSize: 14 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  status: { fontFamily: fonts.mono(400), fontSize: 10.5, flexShrink: 0 },
});
