// Root layout: providers + the native tab bar.
//
// Tab set is Home / Ops / Chat / Automations — four, comfortably under the
// six where UIKit
// collapses six or more into four plus a "More" list, and nobody has
// documented how that list behaves under iOS 26 glass. Feed and Money are not
// tabs: they are full-screen pushes on the Home stack (and Feed also from a
// row on Ops), which is why they still hold their PWA paths /feed and
// /finance. See docs/research/native-chrome.md §1.
//
// Term moved into Ops as a NavCard row (app/ops/terminal.tsx, 2026-09-16) —
// Terminal is reachable from four places and was never really a fifth
// destination of its own. Chat took the freed slot: the Hub's first step
// toward being a real Hermes platform (docs/research/hub-chat/VERDICT-V2.md
// §5), a stub today until the gateway plugin and wire protocol land.
//
// Automations took Config's slot (the user, 2026-09-29): what the scheduled jobs
// report is somewhere he goes daily and settings are not. Config is a push on
// the Home stack now, behind the gear in Home's header, at the same /config
// paths.
//
// backgroundColor / blurEffect / shadowColor are all no-ops on iOS 26, so the
// bar's look comes from the system material plus tintColor/iconColor only.
import { ThemeProvider, DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useEffect } from 'react';
import { HubQueryProvider } from '../src/lib/query';
import { useAppStore } from '../src/lib/store';
import { useWhimsyStore } from '../src/whimsy';
import { useTheme } from '../src/theme/useTheme';
import { fonts } from '../src/theme/fonts';
import { TabBarVisibilityProvider, useTabBarHidden } from '../src/components/shell/tabBar';
import { selectNeedsYouCount, useChatStore } from '../src/chat/store';
import { useAutomationsBadge } from '../src/automations/badge';
import { TabErrorBoundary } from '../src/components/shell/ErrorBoundary';
import { installGateSigner } from '../src/lib/gate';
import { loadStoredApiBase } from '../src/lib/api';
import { watchPresence } from '../src/chat/presence';
import { wireFocusManager } from '../src/lib/query';
import { onNotificationTap } from '../src/lib/push';

// Fonts are embedded by the expo-font config plugin (app.json), i.e. they are
// registered before the first JS frame — there is no runtime load to await and
// no splash screen to hold. fonts.sans()/fonts.mono() only ever return family
// names that assets/fonts/ ships.

export default function RootLayout() {
  const hydrate = useAppStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
    void useWhimsyStore.getState().hydrate();
    // The user-set server override (Config › Server address) has to be in
    // effect before the first screen query fires. Fire-and-forget on purpose:
    // api.ts resolves every call path at call time, so whichever calls race
    // ahead of this simply use the build-time base until it lands.
    void loadStoredApiBase();
  }, [hydrate]);

  // Arms the write gate. api.ts owns the challenge -> sign -> apply sequence for
  // every write and fails closed until a signer is registered, so this one call
  // is what turns every write in the app on. Once, at startup, and nowhere else
  // — a second registration site would be a second place to get it wrong.
  useEffect(() => {
    installGateSigner();
  }, []);

  // Foreground/background, so a reply that lands while he is away notifies him
  // and one that lands in front of him does not.
  useEffect(() => watchPresence(), []);

  // React Native has no window focus event, so TanStack's refetchOnWindowFocus
  // — which every query in the app relies on — did nothing at all until this
  // was wired. A thread whose last WebSocket frame went missing therefore
  // stayed wrong until the app was killed and relaunched (the user, 2026-09-22:
  // "the colorado message is still stuck here").
  useEffect(() => wireFocusManager(), []);

  // A notification carries the route it belongs to; nothing was listening for
  // the tap before, so one only ever opened the app on whatever tab it left on.
  useEffect(() => {
    const sub = onNotificationTap();
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <HubQueryProvider>
          <TabBarVisibilityProvider>
            <ThemedShell />
          </TabBarVisibilityProvider>
        </HubQueryProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function ThemedShell() {
  const { scheme, t } = useTheme();
  const hidden = useTabBarHidden();
  const needsYou = useChatStore(selectNeedsYouCount);
  const automationsNeedYou = useAutomationsBadge();

  // Wrapping in expo-router's ThemeProvider is the documented fix for the
  // white/black flash iOS 26 shows between tab transitions when the default
  // (white-grounded) navigation theme is left in place.
  const navigationTheme: Theme = {
    ...(scheme === 'dark' ? DarkTheme : DefaultTheme),
    dark: scheme === 'dark',
    colors: {
      primary: t('accent'),
      background: t('bg-0'),
      card: t('bg-1'),
      text: t('fg-1'),
      border: t('border'),
      notification: t('status-down'),
    },
  };

  return (
    <ThemeProvider value={navigationTheme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <NativeTabs
        hidden={hidden}
        minimizeBehavior="onScrollDown"
        tintColor={t('accent')}
        iconColor={{ default: t('fg-3'), selected: t('accent') }}
        labelStyle={{
          default: { fontFamily: fonts.sans(500), color: t('fg-3') },
          selected: { fontFamily: fonts.sans(500), color: t('accent') },
        }}
        unstable_screenErrorBoundary={TabErrorBoundary}
      >
        <NativeTabs.Trigger name="(home)">
          <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} />
          <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="ops">
          {/* Lucide "activity" pulse, SF Symbols' nearest equal. No .fill variant. */}
          <NativeTabs.Trigger.Icon sf="waveform.path.ecg" />
          <NativeTabs.Trigger.Label>Ops</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="chat">
          <NativeTabs.Trigger.Icon sf={{ default: 'message', selected: 'message.fill' }} />
          <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
          {/* Threads with an open attention row. Empty string = no badge, so a
              quiet estate shows bare chrome. The count is whatever this session
              has heard about: the store fills on the Chat tab's bootstrap and
              then live over the socket. */}
          {/* The element itself is the dot: an empty string still draws one,
              so a tab with nothing waiting kept a red dot for ever ("remove
              red dots when there isn't a notification in those tabs", the user
              2026-09-30). No badge means no badge. */}
          {needsYou > 0 ? <NativeTabs.Trigger.Badge>{String(needsYou)}</NativeTabs.Trigger.Badge> : null}
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="automations">
          <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} />
          <NativeTabs.Trigger.Label>Automations</NativeTabs.Trigger.Label>
          {/* Jobs whose latest word is an alert, a warning or a failure he has
              not opened. Empty until the chat session is unlocked: the count
              sits behind the same cookie the runs do. */}
          {automationsNeedYou > 0 ? (
            <NativeTabs.Trigger.Badge>{String(automationsNeedYou)}</NativeTabs.Trigger.Badge>
          ) : null}
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
