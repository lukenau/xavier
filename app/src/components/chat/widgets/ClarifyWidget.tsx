// The one way Xavier asks the user a question.
//
// The answer does NOT go back as a chat message. The gateway's clarify call is
// parked on an event waiting for exactly this id, and resolving it returns the
// answer straight into the model's tool result — the same mechanism Discord's
// buttons have used in production for a year. A reply typed into the composer
// also resolves it, because the adapter calls `mark_awaiting_text` whenever
// there are choices, so these controls are a convenience and never the only way.
//
// What is sent is the 1-based INDEX, not the label: `_coerce_multi_select_text`
// accepts "numbers and/or exact labels separated by commas", and an index can
// never be broken by a label that itself contains a comma.
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card } from '../../shell';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { PRESSED_OPACITY } from '../../shell';
import type { ClarifyWidget as ClarifyWidgetT } from '../../../chat/widget';

/** What `resolve_gateway_clarify` is handed. Exported because it is the whole
 * contract with the gateway and is worth testing without a render. */
export function answerText(choices: string[], selected: number[], freeText: string): string | null {
  const typed = freeText.trim();
  if (typed) return typed;
  if (selected.length === 0) return null;
  return selected
    .slice()
    .sort((a, b) => a - b)
    .map((i) => String(i + 1))
    .join(',');
}

export function ClarifyWidget({
  widget,
  answered = null,
  resolved = false,
  onAnswer,
}: {
  widget: ClarifyWidgetT;
  /** The answer already recorded, if this question is settled. */
  answered?: string | null;
  /** The server closed this question's attention row. It records THAT it was
   * answered, not with what, so a remounted card can say "Answered" and must
   * not offer a second POST the gateway can only resolve once. */
  resolved?: boolean;
  onAnswer?: (text: string) => Promise<unknown>;
}) {
  const { t } = useTheme();
  const [selected, setSelected] = useState<number[]>([]);
  const [freeText, setFreeText] = useState('');
  const [typing, setTyping] = useState(false);
  const [attempt, setAttempt] = useState<{ text: string; state: 'sending' | 'sent' | 'failed' } | null>(null);
  const inFlight = useRef(false);

  const known = answered ?? (attempt?.state === 'sent' ? attempt.text : null);
  const pending = answerText(widget.choices, selected, freeText);
  const failed = attempt?.state === 'failed' ? attempt : null;

  // Commits only once the server took it: a card that read "Answered" while the
  // POST 502'd left the gateway's clarify parked until it timed out.
  async function submit(text: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setAttempt({ text, state: 'sending' });
    try {
      await onAnswer?.(text);
      setAttempt({ text, state: 'sent' });
    } catch {
      setAttempt({ text, state: 'failed' });
    } finally {
      inFlight.current = false;
    }
  }

  function tapChoice(i: number) {
    if (!widget.multiSelect) {
      setSelected([i]);
      void submit(String(i + 1));
      return;
    }
    setSelected((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));
  }

  if (known !== null || resolved) {
    return (
      <Card style={styles.card}>
        <Text style={[styles.question, { color: t('fg-2') }]}>{widget.question}</Text>
        <Text style={[styles.settled, { color: t('petrol') }]}>
          {known !== null ? `Answered: ${labelsFor(widget.choices, known)}` : 'Answered'}
        </Text>
      </Card>
    );
  }

  if (attempt?.state === 'sending') {
    return (
      <Card style={styles.card}>
        <Text style={[styles.question, { color: t('fg-2') }]}>{widget.question}</Text>
        <Text style={[styles.settled, { color: t('fg-3') }]}>
          {`Sending: ${labelsFor(widget.choices, attempt.text)}…`}
        </Text>
      </Card>
    );
  }

  return (
    <Card tone="accent" style={styles.card}>
      <Text style={[styles.question, { color: t('fg-0') }]}>{widget.question}</Text>

      {widget.choices.length > 0 ? (
        <View style={styles.choices}>
          {widget.choices.map((choice, i) => {
            const on = selected.includes(i);
            return (
              <Pressable
                key={`${choice}-${i}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => tapChoice(i)}
                style={({ pressed }) => [
                  styles.chip,
                  {
                    backgroundColor: on ? t('accent-soft') : t('bg-0'),
                    borderColor: on ? t('accent-border') : t('border'),
                  },
                  pressed && { opacity: PRESSED_OPACITY },
                ]}
              >
                <Text style={[styles.chipLabel, { color: on ? t('accent') : t('fg-1') }]}>{choice}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {typing || widget.choices.length === 0 ? (
        <TextInput
          value={freeText}
          onChangeText={setFreeText}
          placeholder="Type an answer"
          placeholderTextColor={t('fg-4')}
          multiline
          style={[styles.input, { color: t('fg-1'), backgroundColor: t('bg-0'), borderColor: t('border') }]}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setTyping(true)}
          style={({ pressed }) => [pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.escape, { color: t('fg-3') }]}>Something else…</Text>
        </Pressable>
      )}

      {widget.multiSelect || typing || widget.choices.length === 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: pending === null }}
          disabled={pending === null}
          onPress={() => pending && void submit(pending)}
          style={({ pressed }) => [
            styles.send,
            { backgroundColor: pending ? t('accent') : t('bg-2'), opacity: pending ? 1 : 0.6 },
            pressed && { opacity: PRESSED_OPACITY },
          ]}
        >
          <Text style={[styles.sendLabel, { color: pending ? t('on-accent') : t('fg-4') }]}>Answer</Text>
        </Pressable>
      ) : null}

      {failed ? (
        <View style={styles.failedRow}>
          <Text style={[styles.failed, { color: t('status-down') }]}>
            {`“${labelsFor(widget.choices, failed.text)}” didn’t go through.`}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void submit(failed.text)}
            style={({ pressed }) => [pressed && { opacity: PRESSED_OPACITY }]}
          >
            <Text style={[styles.retry, { color: t('accent') }]}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

/** The gateway is handed indices; a person should be shown the words. */
function labelsFor(choices: string[], sent: string): string {
  const parts = sent.split(',').map((p) => p.trim());
  const asLabels = parts.map((p) => {
    const i = Number(p) - 1;
    return Number.isInteger(i) && i >= 0 && i < choices.length ? choices[i] : p;
  });
  return asLabels.join(', ');
}

const styles = StyleSheet.create({
  card: { gap: 10 },
  question: { fontFamily: fonts.sans(500), fontSize: 14.5, lineHeight: 20 },
  settled: { fontFamily: fonts.sans(400), fontSize: 13 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7 },
  chipLabel: { fontFamily: fonts.sans(500), fontSize: 13.5 },
  escape: { fontFamily: fonts.sans(400), fontSize: 12.5, textDecorationLine: 'underline' },
  input: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, minHeight: 60, fontFamily: fonts.sans(400), fontSize: 14, textAlignVertical: 'top' },
  send: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 18, paddingVertical: 8 },
  sendLabel: { fontFamily: fonts.sans(600), fontSize: 13.5 },
  failedRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  failed: { fontFamily: fonts.sans(500), fontSize: 12.5 },
  retry: { fontFamily: fonts.sans(600), fontSize: 12.5, textDecorationLine: 'underline' },
});
