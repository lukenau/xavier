import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Card } from '../../shell';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { FormWidget as FormWidgetT } from '../../../chat/widget';
import { ButtonRowWidget } from './ButtonRowWidget';

export function FormWidget({
  widget,
  onSubmit,
}: {
  widget: FormWidgetT;
  onSubmit?: (values: Record<string, string>) => void;
}) {
  const { t } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = widget.fields.some((f) => f.required && !(values[f.id] ?? '').trim());

  return (
    <Card style={styles.card}>
      {widget.title ? <Text style={[styles.title, { color: t('fg-0') }]}>{widget.title}</Text> : null}
      {widget.fields.map((field) => (
        <View key={field.id} style={styles.field}>
          <Text style={[styles.label, { color: t('fg-3') }]}>
            {field.label}
            {field.required ? <Text style={{ color: t('status-warn') }}> *</Text> : null}
          </Text>
          <TextInput
            value={values[field.id] ?? ''}
            onChangeText={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
            placeholder={field.placeholder ?? undefined}
            placeholderTextColor={t('fg-3')}
            keyboardType={field.type === 'number' ? 'numeric' : 'default'}
            multiline={field.type === 'textarea'}
            style={[
              styles.input,
              field.type === 'textarea' && styles.textarea,
              { color: t('fg-1'), backgroundColor: t('bg-0'), borderColor: t('border') },
            ]}
          />
        </View>
      ))}
      <ButtonRowWidget
        widget={{ kind: 'button_row', prompt: null, buttons: [{ id: 'submit', label: widget.submitLabel, tone: 'accent' }] }}
        onPress={onSubmit && !missing ? () => onSubmit(values) : undefined}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10 },
  title: { fontFamily: fonts.sans(620), fontSize: 14.5, letterSpacing: -0.2 },
  field: { gap: 4 },
  label: { fontFamily: fonts.mono(550), fontSize: 9, letterSpacing: 1.1, textTransform: 'uppercase' },
  input: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, fontFamily: fonts.sans(400), fontSize: 14 },
  textarea: { minHeight: 72, textAlignVertical: 'top' },
});
