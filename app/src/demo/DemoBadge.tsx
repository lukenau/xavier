// The demo's always-visible label: a small pill over every screen saying the
// data is fictional, so no screenshot or screen of the demo can pass for a real
// hub. Tapping it offers the way out.
//
// It floats in the breathing room Screen leaves above every page header
// (SCREEN_TOP_PAD), clear of the content. A thread draws its own header right
// under the status bar, so there the pill sits just below that header instead.
// The server address screen is the one place it steps aside: that screen's
// body already says, in full, that the demo is on, and offers the way out.
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EYEBROW_FONT_SIZE, EYEBROW_LETTER_SPACING, PRESSED_OPACITY } from '../components/shell';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { useDemoMode } from './mode';
import { exitDemo } from './session';

/** ThreadScreen's header: 4 above, a 36pt row, 8 below and a hairline. */
const THREAD_HEADER = 49;
const GAP = 4;

export function confirmLeaveDemo(): void {
  Alert.alert('Demo mode', 'Everything here is fictional and stays on this iPhone. Nothing is sent to a server.', [
    { text: 'Keep exploring', style: 'cancel' },
    {
      text: 'Exit demo',
      style: 'destructive',
      onPress: () => {
        void exitDemo().then(() => router.navigate('/config/server'));
      },
    },
  ]);
}

export function DemoBadge() {
  const active = useDemoMode((s) => s.active);
  return active ? <Pill /> : null;
}

function Pill() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { t } = useTheme();
  if (pathname === '/config/server') return null;
  const top = insets.top + (pathname.startsWith('/chat/thread') ? THREAD_HEADER + GAP : GAP);
  return (
    <View pointerEvents="box-none" style={[styles.slot, { top }]}>
      <Pressable
        onPress={confirmLeaveDemo}
        accessibilityRole="button"
        accessibilityLabel="Demo mode. Everything shown is fictional."
        accessibilityHint="Opens the option to exit the demo."
        testID="demo-badge"
        style={({ pressed }) => [
          styles.pill,
          { backgroundColor: t('bg-1'), borderColor: t('accent-border') },
          pressed && { opacity: PRESSED_OPACITY },
        ]}
      >
        <View style={[styles.dot, { backgroundColor: t('accent') }]} />
        <Text style={[styles.label, { color: t('accent') }]}>Demo · fictional data</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 20,
    paddingHorizontal: 9,
    borderRadius: 10,
    borderWidth: 1,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  label: {
    fontFamily: fonts.mono(500),
    fontSize: EYEBROW_FONT_SIZE,
    letterSpacing: EYEBROW_LETTER_SPACING,
    textTransform: 'uppercase',
  },
});
