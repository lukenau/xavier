// 1:1 port of apps/hub/src/components/system/SystemPanel.tsx.
//
// One tightly-scoped read surface: the "understand the system" reads (skills /
// plugins / MCP / doctor), each via the CLI-bridge. READ-ONLY this slice — the
// small "read-only" note keeps the boundary honest. Rows in Skills and Plugins
// are tappable → a detail sheet surfacing the fields the reads already return
// (version / source / status / trust / description) instead of discarding them.
//
// Mounted by the Config surface at /config/system (SystemPage.tsx:7-14), which
// supplies the "‹ Config" back link; MemorySection is NOT part of this panel —
// it has its own /config/memory page and is re-exported here for that task.
import { StyleSheet, Text, View } from 'react-native';
import { RefreshControl } from '../shell';
import { SkillsSection } from './SkillsSection';
import { PluginsSection } from './PluginsSection';
import { McpSection } from './McpSection';
import { DoctorSection } from './DoctorSection';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

export { MemorySection } from './MemorySection';

export function SystemPanel() {
  const { t } = useTheme();
  // Cache-shared observers (same keys as the sections below) — no extra
  // fetches, just so the header's refresh control can refetch every section at
  // once and show the oldest freshness stamp across skills / plugins / mcp /
  // doctor.
  const skills = usePoll(['skills'], api.skills, QUERY_TUNING.skills);
  const plugins = usePoll(['plugins'], api.plugins, QUERY_TUNING.plugins);
  const mcp = usePoll(['mcp'], api.mcp, QUERY_TUNING.mcp);
  const doctor = usePoll(['doctor'], api.doctor, QUERY_TUNING.doctor);

  return (
    <>
      <View style={styles.header}>
        <Text style={[styles.title, { color: t('fg-1') }]}>System</Text>
        <View style={styles.headerRight}>
          <Text style={[styles.note, { color: t('fg-4') }]}>read-only</Text>
          <RefreshControl queries={[skills, plugins, mcp, doctor]} />
        </View>
      </View>
      <SkillsSection />
      <PluginsSection />
      <McpSection />
      <DoctorSection />
    </>
  );
}

const styles = StyleSheet.create({
  // pt-2 pb-1 px-1 gap-3
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 8,
    paddingBottom: 4,
    paddingHorizontal: 4,
  },
  title: { fontFamily: fonts.sans(600), fontSize: 15, letterSpacing: -0.15 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
  note: {
    fontFamily: fonts.mono(400),
    fontSize: 9.5,
    letterSpacing: 1.14,
    textTransform: 'uppercase',
  },
});
