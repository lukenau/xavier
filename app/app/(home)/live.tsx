// Live's own page, on the Home stack (path stays `/live`: a group segment
// adds nothing to a URL; app/(home)/_layout.tsx says the same of /config).
//
// The route owns the one thing the Live surface must not: WHICH thread. Live
// is thread-scoped (a voice turn lands in a chat thread exactly as a typed one
// does), so this page resolves the dedicated pinned "Live" thread on open,
// remembered in AsyncStorage, created once on first open, never one of your
// other conversations (src/chat/liveThread.ts), and hands the id down. On
// failure it shows a StatePanel with Retry instead of dead chrome.
//
// Body lives in src/components/chat/LiveScreen.tsx so it stays under jest's
// testMatch (app/** is outside it; see routeTree.test.ts).
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatLockGate } from '../../src/components/chat/ChatLockGate';
import { LiveSurface } from '../../src/components/chat/LiveScreen';
import { PRESSED_OPACITY, StatePanel } from '../../src/components/shell';
import { createLiveThread, resolveLiveThreadId } from '../../src/chat/liveThread';
import { inDemo, LiveDemo } from '../../src/demo/ServerOnly';
import { fonts } from '../../src/theme/fonts';
import { useTheme } from '../../src/theme/useTheme';

function LivePage({ fresh, freshUsed }: { fresh: boolean; freshUsed: RefObject<boolean> }) {
  const { t } = useTheme();
  // The page hides the navigation header, so the loading and error panels
  // must clear the status bar / Dynamic Island themselves.
  const insets = useSafeAreaInsets();
  const inset = { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 };
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Bumped when a new session is started from the page itself, so the surface
  // remounts against the new thread (and tears the old session down).
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    setThreadId(null);
    // A fresh thread is made once per visit: the lock screen unmounts this page
    // each time chat re-locks, and remounting must resume that thread, not make
    // (and pin) another empty one.
    const makeFresh = fresh && !freshUsed.current;
    (makeFresh ? createLiveThread() : resolveLiveThreadId())
      .then((id) => {
        if (makeFresh) freshUsed.current = true;
        if (live) setThreadId(id);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : 'Could not open the Live thread.');
      });
    return () => {
      live = false;
    };
  }, [attempt, fresh, freshUsed]);

  const newSession = useCallback(() => {
    setError(null);
    createLiveThread()
      .then((id) => {
        setThreadId(id);
        setSessionKey((key) => key + 1);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not start a new Live session.');
      });
  }, []);

  if (error) {
    return (
      <View style={[styles.fill, inset, { backgroundColor: t('bg-0') }]}>
        <StatePanel tone="error" title="Live unavailable" detail={error} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry"
          onPress={() => setAttempt((n) => n + 1)}
          style={({ pressed }) => [
            styles.retry,
            { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
            pressed && { opacity: PRESSED_OPACITY },
          ]}
        >
          <Text style={[styles.retryLabel, { color: t('accent') }]}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (!threadId) {
    return (
      <View style={[styles.fill, inset, { backgroundColor: t('bg-0') }]}>
        <StatePanel tone="pending" title="Preparing Live…" />
      </View>
    );
  }

  return <LiveSurface key={sessionKey} threadId={threadId} onNewSession={newSession} />;
}

function LiveRoute() {
  // `?fresh=1` is Home's "start a new session" door (LiveEntryCard): open the
  // page ON A NEW THREAD instead of resuming the remembered one. Whether that
  // thread exists yet is kept here, above the gate, because the page itself is
  // unmounted while chat is locked.
  const { fresh } = useLocalSearchParams<{ fresh?: string }>();
  const freshUsed = useRef(false);
  // The gate wraps the RESOLVER, not just the surface: chatCreateThread is
  // cookie-gated, so resolving before the Face ID unlock would just 401.
  return (
    <ChatLockGate
      copy="Live voice. Unlock with Face ID — the session stays live for an hour."
      unlockLabel="Unlock Live"
    >
      <LivePage fresh={fresh === '1'} freshUsed={freshUsed} />
    </ChatLockGate>
  );
}

// Live needs a server to hear and answer; the demo says so instead, and never
// asks for the microphone.
export default inDemo(LiveRoute, LiveDemo);

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'center' },
  retry: {
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 24,
    marginTop: 16,
  },
  retryLabel: { fontFamily: fonts.sans(600), fontSize: 14 },
});
