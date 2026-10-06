// Home's first card in two situations, and nothing otherwise.
//
// No server chosen yet (the build's placeholder address, which leads nowhere):
// the first-run card — what the app needs, a way to give it, and a way to look
// around the demo first. In the demo: what this is, and the way out.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Card, EYEBROW_FONT_SIZE, EYEBROW_LETTER_SPACING, PRESSED_OPACITY } from '../components/shell';
import { loadStoredApiBase, resolveApiBase } from '../lib/api';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { demoReady, useDemoMode } from './mode';
import { enterDemo, exitDemo } from './session';

function Button({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }
          : { backgroundColor: t('bg-1'), borderColor: t('border-strong') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: primary ? t('accent') : t('fg-1') }]}>{label}</Text>
    </Pressable>
  );
}

/** Whether a server has been chosen: a saved address or one built in. Read
 * again on every return to Home, so the card goes once an address is saved. */
function useServerChosen(): boolean | null {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const check = useCallback(() => {
    let live = true;
    void loadStoredApiBase().then(() => {
      if (live) setChosen(resolveApiBase().source !== 'default');
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(check, [check]);
  useFocusEffect(check);
  return chosen;
}

export function HomeCard() {
  const { t } = useTheme();
  const { active, hydrated } = useDemoMode();
  const chosen = useServerChosen();
  useEffect(() => {
    void demoReady();
  }, []);

  if (!hydrated) return null;
  if (active) {
    return (
      <Card tone="accent" style={styles.card} testID="demo-home-card">
        <Text style={[styles.eyebrow, { color: t('accent') }]}>Demo</Text>
        <Text style={[styles.headline, { color: t('fg-0') }]}>You're exploring the demo</Text>
        <Text style={[styles.body, { color: t('fg-2') }]}>
          Every name, number and message here is fictional, and nothing you do leaves this iPhone. Changes still ask
          for Face ID or your passcode, as they would on your own server.
        </Text>
        <View style={styles.row}>
          <Button label="Exit demo" onPress={() => void exitDemo().then(() => router.push('/config/server'))} />
        </View>
      </Card>
    );
  }
  if (chosen !== false) return null;
  return (
    <Card tone="strong" style={styles.card} testID="first-run-card">
      <Text style={[styles.eyebrow, { color: t('fg-4') }]}>Get started</Text>
      <Text style={[styles.headline, { color: t('fg-0') }]}>Connect your server</Text>
      <Text style={[styles.body, { color: t('fg-2') }]}>
        Xavier talks to a server you run yourself, over your own private network. Enter its address, or look around
        a demo with fictional data first.
      </Text>
      <View style={styles.row}>
        <Button label="Set server address" onPress={() => router.push('/config/server')} />
        <Button label="Explore demo" primary onPress={() => void enterDemo()} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  eyebrow: {
    fontFamily: fonts.mono(400),
    fontSize: EYEBROW_FONT_SIZE,
    letterSpacing: EYEBROW_LETTER_SPACING,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  headline: { fontFamily: fonts.sans(600), fontSize: 16, marginBottom: 4 },
  body: { fontFamily: fonts.sans(400), fontSize: 13, lineHeight: 19, marginBottom: 12 },
  row: { flexDirection: 'row', gap: 10 },
  button: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontFamily: fonts.sans(550), fontSize: 13 },
});
