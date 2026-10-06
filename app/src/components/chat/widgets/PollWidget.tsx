import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { Card, PRESSED_OPACITY } from '../../shell';
import type { PollWidget as PollWidgetT } from '../../../chat/widget';
import { toneToken } from './tone';
import { DISABLED_OPACITY } from './ButtonRowWidget';

export function PollWidget({
  widget,
  onVote,
}: {
  widget: PollWidgetT;
  onVote?: (optionId: string) => void;
}) {
  const { t } = useTheme();
  const total = widget.options.reduce((sum, o) => sum + Math.max(0, o.votes), 0);
  const open = widget.selectedId === null && !widget.closed;
  // Open but with nowhere to send a vote: the options must not look pressable
  // (they had press feedback and did nothing, forever).
  const inert = onVote === undefined;

  return (
    <Card style={styles.card}>
      <Text style={[styles.question, { color: t('fg-0') }]}>{widget.question}</Text>

      <View style={styles.options}>
        {widget.options.map((option) =>
          open ? (
            <Pressable
              key={option.id}
              testID={`poll-option-${option.id}`}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ disabled: inert }}
              disabled={inert}
              onPress={() => onVote?.(option.id)}
              style={({ pressed }) => [
                styles.choice,
                { borderColor: t('border-strong'), backgroundColor: t('bg-2') },
                inert && { opacity: DISABLED_OPACITY },
                pressed && !inert && { opacity: PRESSED_OPACITY },
              ]}
            >
              <Text style={[styles.choiceLabel, { color: t('fg-1') }]}>{option.label}</Text>
            </Pressable>
          ) : (
            <Result
              key={option.id}
              label={option.label}
              votes={Math.max(0, option.votes)}
              share={total > 0 ? Math.max(0, option.votes) / total : 0}
              chosen={option.id === widget.selectedId}
              id={option.id}
            />
          ),
        )}
      </View>

      <Text testID="poll-footer" style={[styles.footer, { color: t('fg-2') }]}>
        {`${total} vote${total === 1 ? '' : 's'}${widget.closed ? ' · closed' : ''}`}
      </Text>
    </Card>
  );
}

function Result({
  id,
  label,
  votes,
  share,
  chosen,
}: {
  id: string;
  label: string;
  votes: number;
  share: number;
  chosen: boolean;
}) {
  const { t } = useTheme();
  return (
    <View testID={`poll-result-${id}`} style={styles.result}>
      <View style={styles.resultHead}>
        <Text
          style={[
            styles.resultLabel,
            { color: t(chosen ? toneToken('accent') : 'fg-2'), fontFamily: fonts.sans(chosen ? 620 : 500) },
          ]}
          numberOfLines={2}
        >
          {chosen ? `✓ ${label}` : label}
        </Text>
        <Text style={[styles.count, { color: t('fg-3') }, MONO_FEATURES]}>
          {`${Math.round(share * 100)}% · ${votes}`}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: t('bg-2') }]}>
        <View
          testID={`poll-bar-${id}`}
          style={[
            styles.fill,
            { flex: share, backgroundColor: t(chosen ? toneToken('accent') : 'fg-4') },
          ]}
        />
        <View style={{ flex: 1 - share }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10 },
  question: { fontFamily: fonts.sans(620), fontSize: 14.5, lineHeight: 20 },
  options: { gap: 7 },
  choice: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  choiceLabel: { fontFamily: fonts.sans(520), fontSize: 13.5 },
  result: { gap: 4 },
  resultHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  resultLabel: { flex: 1, minWidth: 0, fontSize: 13 },
  count: { flexShrink: 0, fontFamily: fonts.mono(500), fontSize: 11 },
  track: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { borderRadius: 3 },
  footer: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.3 },
});
