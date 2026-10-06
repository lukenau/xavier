// Config › This device, while the demo is on: the way out, under the server
// address it returns to. Drawn like the page rows around it (ConfigHome's
// PageRow); renders nothing outside the demo.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { PRESSED_OPACITY } from '../components/shell';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { useDemoMode } from './mode';
import { exitDemo } from './session';

export function DemoConfigRow() {
  const { t } = useTheme();
  const active = useDemoMode((s) => s.active);
  if (!active) return null;
  return (
    <Pressable
      onPress={() => void exitDemo().then(() => router.push('/config/server'))}
      accessibilityRole="button"
      accessibilityLabel="Exit demo"
      testID="demo-config-exit"
      style={({ pressed }) => [styles.row, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <View style={styles.text}>
        <Text style={[styles.label, { color: t('accent') }]}>Exit demo</Text>
        <Text style={[styles.sub, { color: t('fg-3') }]}>drop the fictional data and connect your own server</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingVertical: 8, paddingLeft: 14 },
  text: { flex: 1, minWidth: 0 },
  label: { fontFamily: fonts.sans(500), fontSize: 14 },
  sub: { fontFamily: fonts.sans(400), fontSize: 12 },
});
