// The Face ID lock screen chat sits behind — port of the shape
// src/terminal/TerminalScreen.tsx's LockScreen established (same
// hydrate-then-branch flow, same unlock button), generalized so both
// ChatScreen (the tab root) and ThreadScreen (a pushed detail) can gate
// behind the ONE shared `hub_chat_session` cookie (chat/session.py) without
// two copies drifting. Re-locking (a 1008 mid-session, or the 55-minute
// stamp expiring) drops back to this screen from wherever the user was.
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useChatLock } from '../../chat/lock';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { Screen } from '../shell';

export interface ChatLockGateProps {
  header?: ReactNode;
  children: ReactNode;
  /** What is behind the lock, when it is not the chat itself. Automations sits
   * behind the same session: a run's output is the same material a thread holds. */
  copy?: string;
  unlockLabel?: string;
}

const DEFAULT_COPY = 'Chat with Xavier. Unlock with Face ID — the session stays live for an hour.';

export function ChatLockGate({ header, children, copy = DEFAULT_COPY, unlockLabel = 'Unlock chat' }: ChatLockGateProps) {
  const unlocked = useChatLock((s) => s.unlocked);
  const hydrated = useChatLock((s) => s.hydrated);
  const hydrate = useChatLock((s) => s.hydrate);
  const busy = useChatLock((s) => s.busy);
  const error = useChatLock((s) => s.error);
  const unlock = useChatLock((s) => s.unlock);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Opening a locked Chat tab prompts Face ID straight away rather than asking
  // for a tap first — the stamp lapses hourly and the user's own reading of
  // "chat locked, unlock with Face ID" is that it should just ask. Once per
  // mount only: a cancelled prompt must leave the button, not re-prompt in a
  // loop (`error` is set on cancel, and a fresh mount is a deliberate retry).
  const prompted = useRef(false);
  useEffect(() => {
    if (!hydrated || unlocked || busy || error || prompted.current) return;
    prompted.current = true;
    void unlock();
  }, [hydrated, unlocked, busy, error, unlock]);

  // Render nothing until the unlock stamp has been read: a valid stamp would
  // otherwise flash the lock screen — and its Face ID button — for a frame.
  if (!hydrated) return null;

  if (!unlocked) {
    return (
      <Screen header={header}>
        <LockBody busy={busy} error={error} copy={copy} unlockLabel={unlockLabel} onUnlock={() => void unlock()} />
      </Screen>
    );
  }

  return <>{children}</>;
}

function LockBody({
  busy,
  error,
  copy,
  unlockLabel,
  onUnlock,
}: {
  busy: boolean;
  error: string | null;
  copy: string;
  unlockLabel: string;
  onUnlock: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.body}>
      <View style={[styles.padlock, { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }]}>
        <SymbolView name="lock" size={24} tintColor={t('accent')} weight="regular" />
      </View>
      <Text style={[styles.copy, { color: t('fg-2') }]}>{copy}</Text>
      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: t('status-down') }]}>
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={onUnlock}
        disabled={busy}
        style={[styles.unlock, { backgroundColor: t('accent-soft'), borderColor: t('accent-border'), opacity: busy ? 0.6 : 1 }]}
      >
        <Text style={[styles.unlockLabel, { color: t('accent') }]}>
          {busy ? 'Waiting for Face ID…' : unlockLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 80 },
  padlock: { width: 56, height: 56, borderRadius: 28, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  copy: { fontFamily: fonts.sans(400), fontSize: 14, textAlign: 'center', maxWidth: 280 },
  error: { fontFamily: fonts.sans(400), fontSize: 12.5, textAlign: 'center', maxWidth: 280 },
  unlock: { minHeight: 44, borderRadius: 999, borderWidth: 1, paddingHorizontal: 24, paddingVertical: 12, justifyContent: 'center' },
  unlockLabel: { fontFamily: fonts.sans(600), fontSize: 14 },
});
