// A turn's quiet work, as one line. The plugin delivers a message per tool
// call, so a six-tool turn arrived as six separate "Worked for 8s, 1 tool"
// folds with a "Thought for 0s" above most of them — the user's screenshot of it
// was seven stacked folds and no answer in sight (2026-09-22). This is the
// prototype's shape instead: "Worked for 41s · 6 tools", expanding to the
// thinking and the calls in order.
//
// What reaches here is decided by `chat/transcript.ts`, which keeps errors and
// anything waiting on you OUT — those never collapse.
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { PRESSED_OPACITY } from '../../shell';
import type { Part, ToolCallPart as ToolCallPartT } from '../../../chat/types';
import { ToolCallPart } from './ToolCallPart';

/** Folded tool calls change only when one of the parts they fold changes. */
export const ActivityBlock = memo(ActivityBlockRow, (before, after) =>
  before.toolCount === after.toolCount &&
  before.durationMs === after.durationMs &&
  before.parts.length === after.parts.length &&
  before.parts.every((part, i) => part === after.parts[i]));

function ActivityBlockRow({
  parts,
  toolCount,
  durationMs,
}: {
  parts: Part[];
  toolCount: number;
  durationMs: number;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);

  const thinking = parts
    .filter((p): p is Extract<Part, { type: 'reasoning' }> => p.type === 'reasoning')
    .map((p) => p.text.trim())
    .filter((text) => text.length > 0);
  const tools = parts.filter((p): p is ToolCallPartT => p.type === 'tool_call');
  if (tools.length === 0 && thinking.length === 0) return null;

  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const label =
    tools.length > 0
      ? `Worked for ${seconds}s · ${toolCount} tool${toolCount === 1 ? '' : 's'}`
      : `Thought for ${seconds}s`;

  return (
    <View style={[styles.wrap, { borderColor: t('border') }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.head, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text style={[styles.label, { color: t('fg-3') }]}>{label}</Text>
        {thinking.length > 0 ? (
          <Text style={[styles.thought, { color: t('fg-3') }]}>· thinking</Text>
        ) : null}
        <Text style={[styles.chevron, { color: t('fg-3') }]}>{open ? '▾' : '▸'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {thinking.map((text, i) => (
            <Text key={`r${i}`} style={[styles.reasoning, { color: t('fg-3'), borderLeftColor: t('border-strong') }]}>
              {text}
            </Text>
          ))}
          {tools.map((part, i) => (
            <ToolCallPart key={part.tool_call_id ?? `t${i}`} part={part} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12, borderWidth: 1, borderStyle: 'dashed', borderRadius: 11 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 8 },
  label: { fontFamily: fonts.mono(400), fontSize: 11 },
  thought: { fontFamily: fonts.mono(400), fontSize: 11 },
  chevron: { marginLeft: 'auto', fontFamily: fonts.sans(400), fontSize: 11 },
  body: { paddingHorizontal: 11, paddingBottom: 10, gap: 8 },
  reasoning: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 19, borderLeftWidth: 2, paddingLeft: 10 },
});
