// A delegation, as one block: how many agents, what each was asked, how long
// they have been at it, and each one's own card to open. The transcript used
// to show one anonymous "WORKING 87s" bubble per agent, one message each,
// which the work that followed pushed out of sight (the user, 2026-09-29: "this
// isn't really the best way to do it. and they end up getting hidden up in
// previous messages"). What reaches here is decided by chat/transcript.ts.
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { formatElapsed, type AgentEntry } from '../../../chat/transcript';
import { SubagentCard } from './SubagentCard';
import { elapsedSecondsBetween, useElapsedSeconds } from './useElapsedSeconds';

export const AgentsBlock = memo(
  AgentsBlockRow,
  (before, after) =>
    before.threadId === after.threadId &&
    before.startedAt === after.startedAt &&
    before.endedAt === after.endedAt &&
    before.agents.length === after.agents.length &&
    before.agents.every((a, i) => a.part === after.agents[i].part && a.goal === after.agents[i].goal),
);

function AgentsBlockRow({
  agents,
  startedAt,
  endedAt,
  threadId,
}: {
  agents: AgentEntry[];
  startedAt: string;
  endedAt: string;
  threadId: string;
}) {
  const { t } = useTheme();
  const running = agents.filter((a) => a.part.status === 'running').length;
  const failed = agents.filter((a) => a.part.status === 'error').length;
  const live = useElapsedSeconds(running > 0, startedAt);
  const total = elapsedSecondsBetween(startedAt, endedAt) ?? live;
  const n = agents.length;
  const label = `${n} ${n === 1 ? 'agent' : 'agents'}`;
  const state =
    running > 0
      ? `${running === n ? 'working' : `${running} still working`} · ${formatElapsed(live)}`
      : failed > 0
        ? `${failed} failed · ${formatElapsed(total)}`
        : `done in ${formatElapsed(total)}`;

  return (
    <View
      testID="agents-block"
      style={[styles.wrap, { borderColor: t(running > 0 ? 'accent-border' : 'border') }]}
    >
      <View style={styles.head}>
        <Text style={[styles.glyph, { color: t(running > 0 ? 'accent' : 'fg-3') }]}>⑂</Text>
        <Text style={[styles.label, { color: t('fg-2') }]}>{label}</Text>
        <Text style={[styles.state, { color: t(running > 0 ? 'accent' : failed > 0 ? 'status-down' : 'fg-3') }]}>
          {state}
        </Text>
      </View>
      <View style={styles.body}>
        {agents.map((a, i) => (
          <SubagentCard
            key={a.part.tool_call_id ?? `agent-${i}`}
            part={a.part}
            threadId={threadId}
            startedAt={a.message.created_at}
            goal={a.goal}
            index={i + 1}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12, borderWidth: 1, borderStyle: 'dashed', borderRadius: 11 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 8 },
  glyph: { fontFamily: fonts.mono(500), fontSize: 12 },
  label: { fontFamily: fonts.mono(500), fontSize: 11 },
  state: { marginLeft: 'auto', fontFamily: fonts.mono(400), fontSize: 11 },
  body: { paddingHorizontal: 8, paddingBottom: 8, gap: 6 },
});
