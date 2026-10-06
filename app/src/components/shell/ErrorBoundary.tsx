// 1:1 port of apps/hub/src/components/shell/ErrorBoundary.tsx (SHELL-10).
//
// The PWA mounts one of these around the route switch with label "This tab"
// (App.tsx:74) because a standalone PWA has no reload affordance. Natively the
// same job is done per tab by expo-router's own boundary plumbing:
// `<NativeTabs unstable_screenErrorBoundary={TabErrorBoundary}>` in
// app/_layout.tsx, which supplies { error, retry }.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from './Card';
import { Screen } from './Screen';

export interface ErrorCardProps {
  /** "{label} hit an error"; the PWA's fallback is "This view". */
  label?: string;
  message: string;
  onRetry: () => void;
}

export function ErrorCard({ label = 'This view', message, onRetry }: ErrorCardProps) {
  const { t } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.card,
        { backgroundColor: t('status-down-wash'), borderColor: t('status-down-border') },
      ]}
    >
      <Text style={[styles.title, { color: t('status-down') }]}>{label} hit an error</Text>
      <Text style={[styles.message, { color: t('fg-3') }]}>{message}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: t('bg-1'), borderColor: t('border-strong') },
          pressed && { opacity: PRESSED_OPACITY },
        ]}
      >
        <Text style={[styles.buttonLabel, { color: t('fg-1') }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

/** Pass to `<NativeTabs unstable_screenErrorBoundary={…}>`. */
export function TabErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <Screen>
      <ErrorCard label="This tab" message={error.message} onRetry={retry} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 20,
    marginVertical: 20,
    borderWidth: 1,
    alignItems: 'center',
  },
  title: { fontFamily: fonts.sans(550), fontSize: 14, marginBottom: 4, textAlign: 'center' },
  message: {
    fontFamily: fonts.mono(400),
    fontSize: 11,
    marginBottom: 14,
    textAlign: 'center',
  },
  button: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, borderWidth: 1 },
  buttonLabel: { fontFamily: fonts.sans(550), fontSize: 13 },
});
