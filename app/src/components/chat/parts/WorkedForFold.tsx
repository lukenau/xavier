// "Worked for Ns, N tools" — what a turn's completed tool calls collapse into
// once the message they belong to is done streaming. Design reference:
// completed tools fold after the turn; errors and anything still pending
// never do (MessageBubble.tsx is what keeps those OUT of the list this
// component is handed — see its own comment for why they render at their
// original position instead of ever reaching here).
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { PRESSED_OPACITY } from '../../shell';
import type { ToolCallPart as ToolCallPartT } from '../../../chat/types';
import { ToolCallPart } from './ToolCallPart';

export function WorkedForFold({ parts }: { parts: ToolCallPartT[] }) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  if (parts.length === 0) return null;

  const totalMs = parts.reduce((sum, p) => sum + (p.duration_ms ?? 0), 0);
  const seconds = Math.round(totalMs / 1000);

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.row, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text style={[styles.label, { color: t('fg-2') }]}>
          Worked for {seconds}s, {parts.length} tool{parts.length === 1 ? '' : 's'} {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.body}>
          {parts.map((part, i) => (
            <ToolCallPart key={part.tool_call_id ?? i} part={part} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 2, marginBottom: 4 },
  row: { minHeight: 22, justifyContent: 'center' },
  label: { fontFamily: fonts.mono(400), fontSize: 11 },
  body: { marginTop: 4, paddingLeft: 9 },
});
