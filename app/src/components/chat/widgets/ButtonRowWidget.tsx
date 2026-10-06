import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { PRESSED_OPACITY } from '../../shell';
import type { ButtonRowWidget as ButtonRowWidgetT } from '../../../chat/widget';
import { toneSoftToken, toneToken } from './tone';

export const DISABLED_OPACITY = 0.5;

export function ButtonRowWidget({
  widget,
  onPress,
}: {
  widget: ButtonRowWidgetT;
  onPress?: (buttonId: string) => void;
}) {
  const { t } = useTheme();
  const disabled = onPress === undefined;
  return (
    <View style={styles.wrap}>
      {widget.prompt ? (
        <Text style={[styles.prompt, { color: t('fg-2') }]}>{widget.prompt}</Text>
      ) : null}
      <View style={styles.row}>
        {widget.buttons.map((button) => (
          <Pressable
            key={button.id}
            disabled={disabled}
            onPress={() => onPress?.(button.id)}
            accessibilityRole="button"
            accessibilityLabel={button.label}
            accessibilityState={{ disabled }}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: t(toneSoftToken(button.tone)),
                borderColor: t(button.tone === 'neutral' ? 'border-strong' : toneToken(button.tone)),
              },
              disabled && { opacity: DISABLED_OPACITY },
              pressed && { opacity: PRESSED_OPACITY },
            ]}
          >
            <Text style={[styles.label, { color: t(toneToken(button.tone)) }]}>{button.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  prompt: { fontFamily: fonts.sans(400), fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  label: { fontFamily: fonts.sans(520), fontSize: 13 },
});
