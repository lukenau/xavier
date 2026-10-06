import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { TokenName } from '../../../theme/tokens.gen';
import { Card } from '../../shell';
import type { ChecklistState, ChecklistWidget as ChecklistWidgetT, Tone } from '../../../chat/widget';
import { toneSoftToken, toneToken } from './tone';
import { api } from '../../../lib/api';
import { PRESSED_OPACITY } from '../../shell';

/** A tap is a tick, and a tick on a done item takes it back. `doing` and
 * `blocked` are the agent's to set — tapping one marks it done, which is what
 * a person means when they tap a thing they are in the middle of. */
function nextState(state: ChecklistState): ChecklistState {
  return state === 'done' ? 'todo' : 'done';
}

const MARKER: Record<ChecklistState, string> = {
  todo: '○',
  doing: '◆',
  done: '✓',
  blocked: '!',
};

const STATE_TONE: Record<ChecklistState, Tone> = {
  todo: 'neutral',
  doing: 'accent',
  done: 'up',
  blocked: 'warn',
};

// The label colour is pinned per state rather than taken from the tone so the
// four rows stay legible whatever the tone ramp does: done recedes, doing
// leads, blocked sits between them.
const LABEL_COLOR: Record<ChecklistState, TokenName> = {
  todo: 'fg-2',
  doing: 'fg-0',
  done: 'fg-3',
  blocked: 'fg-1',
};

export function ChecklistWidget({
  widget,
  threadId,
  messageId,
  partIndex,
}: {
  widget: ChecklistWidgetT;
  threadId?: string;
  messageId?: string;
  partIndex?: number;
}) {
  const { t } = useTheme();
  // The server owns the state — this only holds the tap until the part comes
  // back through the socket, so the row does not wait a round trip to move.
  const [pending, setPending] = useState<Record<string, ChecklistState>>({});
  const canTick = !!threadId && !!messageId && partIndex !== undefined;

  async function tick(index: number, item: { id: string; state: ChecklistState }) {
    if (!canTick) return;
    const state = nextState(pending[item.id] ?? item.state);
    setPending((p) => ({ ...p, [item.id]: state }));
    try {
      await api.chatTickChecklist(threadId as string, {
        message_id: messageId as string,
        part_index: partIndex as number,
        item_index: index,
        state,
      });
    } catch {
      // The tick did not land, so the row goes back to what the server says
      // rather than lying about it.
      setPending((p) => {
        const next = { ...p };
        delete next[item.id];
        return next;
      });
    }
  }


  const stateOf = (item: { id: string; state: ChecklistState }) => pending[item.id] ?? item.state;
  const done = widget.items.filter((i) => stateOf(i) === 'done').length;
  const blocked = widget.items.filter((i) => stateOf(i) === 'blocked').length;

  return (
    <Card style={styles.card}>
      {widget.title ? <Text style={[styles.title, { color: t('fg-0') }]}>{widget.title}</Text> : null}

      <View style={styles.items}>
        {widget.items.map((item, index) => {
          const state = pending[item.id] ?? item.state;
          const tone = STATE_TONE[state];
          const wash = state === 'doing' || state === 'blocked' ? t(toneSoftToken(tone)) : null;
          return (
            <Pressable
              key={item.id}
              testID={`checklist-item-${item.id}`}
              accessibilityRole={canTick ? 'checkbox' : undefined}
              accessibilityState={canTick ? { checked: state === 'done' } : undefined}
              accessibilityLabel={`${state}: ${item.label}`}
              disabled={!canTick}
              onPress={() => void tick(index, { id: item.id, state })}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => [
                styles.row,
                wash ? { backgroundColor: wash } : null,
                pressed && canTick ? { opacity: PRESSED_OPACITY } : null,
              ]}
            >
              <Text testID={`checklist-marker-${item.id}`} style={[styles.marker, { color: t(toneToken(tone)) }]}>
                {MARKER[state]}
              </Text>
              <View style={styles.body}>
                <Text
                  style={[
                    styles.label,
                    {
                      color: t(LABEL_COLOR[state]),
                      fontFamily: fonts.sans(state === 'doing' ? 620 : 500),
                    },
                  ]}
                >
                  {item.label}
                </Text>
                {item.note ? <Text style={[styles.note, { color: t('fg-2') }]}>{item.note}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <Text testID="checklist-progress" style={[styles.progress, { color: t('fg-2') }, MONO_FEATURES]}>
        {`${done} of ${widget.items.length} done${blocked > 0 ? ` · ${blocked} blocked` : ''}`}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 9 },
  title: { fontFamily: fonts.sans(620), fontSize: 14.5, lineHeight: 20 },
  items: { gap: 2 },
  // A whole row is the target, and it is at least 36pt tall with 8pt of slop
  // either side — a checklist is a thing you tap while walking (the user,
  // 2026-09-23: "can you make the whole row clickable").
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    gap: 9,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 5,
    marginHorizontal: -7,
  },
  marker: { width: 13, textAlign: 'center', fontFamily: fonts.mono(620), fontSize: 12, lineHeight: 19 },
  body: { flex: 1, minWidth: 0, gap: 1 },
  label: { fontSize: 13, lineHeight: 19 },
  note: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16 },
  progress: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.3 },
});
