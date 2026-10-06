// What the demo shows in place of a feature that needs a real machine behind
// it — the terminal, the Claude Code shells, pairing, a page the demo has no
// copy of. Not an error: a neutral panel that says where the feature lives.
import type { ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { PageTitle, PRESSED_OPACITY, Screen, SectionHead, SheetScreen, StatePanel, useHideTabBar } from '../components/shell';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { DEMO_REPO, useDemoMode } from './mode';

/** Whether the demo is on, or null while the stored flag is being read. A
 * screen that would load something from the hub on mount (a page, the
 * terminal) waits for the answer rather than guess "off" on a cold launch;
 * the root layout starts the read before any screen renders. */
export function useDemoActive(): boolean | null {
  return useDemoMode((s) => (s.hydrated ? s.active : s.reading ? null : false));
}

/** A route that is the real screen outside the demo and `Demo` inside it. */
export function inDemo<P extends object>(Real: ComponentType<P>, Demo: ComponentType<P>): ComponentType<P> {
  function DemoAware(props: P) {
    const demo = useDemoActive();
    if (demo === null) return null;
    return demo ? <Demo {...props} /> : <Real {...props} />;
  }
  return DemoAware;
}

export function ServerOnlyPanel({ title, detail }: { title: string; detail: string }) {
  return <StatePanel tone="neutral" moment={false} title={title} detail={`${detail} See ${DEMO_REPO}.`} />;
}

function BackTo({ label, href }: { label: string; href: '/ops' | '/' }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.navigate(href)}
      style={({ pressed }) => [styles.back, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <Text style={[styles.backLabel, { color: t('accent') }]}>‹ {label}</Text>
    </Pressable>
  );
}

export function TerminalDemo() {
  useHideTabBar();
  return (
    <Screen
      header={
        <>
          <BackTo label="Ops" href="/ops" />
          <PageTitle>Terminal</PageTitle>
        </>
      }
    >
      <ServerOnlyPanel
        title="Runs on your own server"
        detail="The terminal is a shell on the machine you run Xavier on, unlocked with Face ID or your passcode. The demo has no machine behind it."
      />
    </Screen>
  );
}

export function ShellsDemo() {
  return (
    <View style={styles.section}>
      <SectionHead label="Claude shells" />
      <ServerOnlyPanel
        title="Runs on your own server"
        detail="Claude Code sessions live in tmux on your own machines, and this list shows them."
      />
    </View>
  );
}

export function PairDemo() {
  return (
    <SheetScreen eyebrow="Security" title="Pair this iPhone">
      <ServerOnlyPanel
        title="Pairing needs your own server"
        detail="Pairing ties this iPhone's key to a server you run. In the demo, Face ID or your passcode confirms each change instead, and nothing is sent anywhere."
      />
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 14, marginBottom: 10 },
  back: { minHeight: 32, justifyContent: 'center', alignSelf: 'flex-start' },
  backLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
});
