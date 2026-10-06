// Face ID gate → in-app xterm client, ported from apps/hub/src/routes/Terminal.tsx
// and routes/terminal/XtermView.tsx.
//
// The split that makes this screen work on iOS: the SOCKET is React Native's
// (src/terminal/wsClient.ts), the KEYBOARD is React Native's (Composer +
// KeyBar inside a KeyboardStickyView), and the WebView is a renderer with no
// other job. Nothing focusable lives inside WKWebView, which is what the PWA's
// months of keyboard-viewport fighting bought us the knowledge to avoid.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PRESSED_OPACITY, Screen, useHideTabBar } from '../components/shell';
import { pulseScale, usePulseRing } from '../components/home/pulse';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import type { TokenName } from '../theme/tokens.gen';
import { Composer, type ComposerHandle } from './Composer';
import { KeyBar } from './KeyBar';
import { Runbooks } from './Runbooks';
import { SessionPicker } from './SessionPicker';
import { useTerminalFontSize } from './fontSize';
import { bottomSpacerHeight, terminalViewportHeight } from './layout';
import { useTerminalLock } from './lock';
import { TerminalSocket, type TtydStatus } from './wsClient';
import { XtermHost, type XtermHostHandle } from './xtermHost';
import type { XtermTheme } from './xtermHtml';

/** XtermView.tsx:28-33. */
export const STATUS_TONE: Record<TtydStatus, { token: TokenName; label: string }> = {
  connecting: { token: 'status-warn', label: 'connecting' },
  connected: { token: 'status-up', label: 'live' },
  closed: { token: 'fg-4', label: 'disconnected' },
  error: { token: 'status-down', label: 'error' },
};

/** globals.css `pulse-up 2.4s` on the live dot. */
const PULSE_MS = 2400;
const DOT_SIZE = 7;

function LockScreen() {
  const { t } = useTheme();
  const busy = useTerminalLock((s) => s.busy);
  const error = useTerminalLock((s) => s.error);
  const unlock = useTerminalLock((s) => s.unlock);

  return (
    <Screen
      header={
        <Pressable
          accessibilityRole="button"
          onPress={() => router.navigate('/ops')}
          style={({ pressed }) => [styles.backRow, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.backLabel, { color: t('accent') }]}>‹ Ops</Text>
        </Pressable>
      }
    >
      <View style={styles.lockBody}>
        <View
          style={[
            styles.padlock,
            { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
          ]}
        >
          <SymbolView name="lock" size={24} tintColor={t('accent')} weight="regular" />
        </View>
        <Text style={[styles.lockCopy, { color: t('fg-2') }]}>
          Shell access to the VPS. Unlock with Face ID — the session stays live for an hour.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={[styles.lockError, { color: t('status-down') }]}>
            {error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => void unlock()}
          disabled={busy}
          style={[
            styles.unlock,
            {
              backgroundColor: t('accent-soft'),
              borderColor: t('accent-border'),
              opacity: busy ? 0.6 : 1,
            },
          ]}
        >
          <Text style={[styles.unlockLabel, { color: t('accent') }]}>
            {busy ? 'Waiting for Face ID…' : 'Unlock terminal'}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

function TerminalSurface({ onLock }: { onLock: () => void }) {
  useHideTabBar();
  const { t, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { fontSize, smaller, larger } = useTerminalFontSize();
  const [status, setStatus] = useState<TtydStatus>('connecting');
  const [boxHeight, setBoxHeight] = useState(0);
  const [runbooksOpen, setRunbooksOpen] = useState(false);
  const [shellsOpen, setShellsOpen] = useState(false);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const host = useRef<XtermHostHandle>(null);
  const composer = useRef<ComposerHandle>(null);
  /** A runbook or attach command waiting for its sheet to finish dismissing.
   * `fill()` focuses the composer, and iOS drops a focus requested from behind
   * a presenting modal — the keyboard would simply not open. */
  const pendingFill = useRef<string | null>(null);
  /** Last grid the page reported; also the "have we connected yet" flag. */
  const grid = useRef({ cols: 0, rows: 0 });

  const theme: XtermTheme = useMemo(
    () => ({
      background: t('term-bg'),
      foreground: t('term-fg'),
      cursor: t('term-cursor'),
      cursorAccent: t('term-bg'),
      selectionBackground: t('term-selection'),
    }),
    // `t` is a fresh closure every render; the scheme is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheme],
  );

  const socket = useMemo(() => {
    const sock: TerminalSocket = new TerminalSocket({
      onData: (bytes, needsAck) => host.current?.write(bytes, needsAck),
      onStatus: (next) => {
        setStatus(next);
        // The client resets its own backoff; the renderer owns the re-fit.
        if (next === 'connected' && grid.current.cols > 0) {
          sock.resize(grid.current.cols, grid.current.rows);
        }
      },
      onLock: () => void useTerminalLock.getState().lock(),
    });
    return sock;
  }, []);

  useEffect(() => {
    const detach = socket.attachAppState();
    return () => {
      detach();
      socket.close();
    };
  }, [socket]);

  const onSize = useCallback(
    (cols: number, rows: number) => {
      const first = grid.current.cols === 0;
      grid.current = { cols, rows };
      if (first) void socket.connect(cols, rows);
      else socket.resize(cols, rows);
    },
    [socket],
  );

  const onAck = useCallback(() => socket.ack(), [socket]);
  const onKey = useCallback((seq: string) => socket.write(seq), [socket]);
  const sendLine = useCallback(
    (text: string) => {
      socket.write(text);
      host.current?.scrollToBottom();
    },
    [socket],
  );

  const applyPendingFill = useCallback(() => {
    const cmd = pendingFill.current;
    pendingFill.current = null;
    if (cmd !== null) composer.current?.fill(cmd);
  }, []);

  const tone = STATUS_TONE[status];
  const toneColor = t(tone.token);
  const live = status === 'connected';
  const pulse = usePulseRing(live, PULSE_MS);
  const viewportHeight = terminalViewportHeight(boxHeight, keyboardHeight);

  return (
    <View style={[styles.surface, { backgroundColor: t('term-bg') }]}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 4, borderBottomColor: t('border') },
        ]}
      >
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => router.navigate('/ops')}
          style={({ pressed }) => [styles.headerBack, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.headerBackGlyph, { color: t('accent') }]}>‹</Text>
        </Pressable>
        <View style={styles.headerTitle}>
          <View style={styles.dotSlot}>
            {live ? (
              <Animated.View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  styles.dot,
                  {
                    backgroundColor: t('status-up-glow'),
                    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                    transform: [
                      {
                        scale: pulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, pulseScale(DOT_SIZE / 2)],
                        }),
                      },
                    ],
                  },
                ]}
              />
            ) : null}
            <View style={[styles.dot, { backgroundColor: toneColor }]} />
          </View>
          <Text numberOfLines={1} style={[styles.headerName, { color: t('fg-1') }]}>
            xavier · tmux hub-term
          </Text>
          {live ? (
            <Text style={[styles.statusLabel, { color: toneColor }]}>{tone.label}</Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => socket.retryNow()}
              style={({ pressed }) => [styles.retry, pressed && { opacity: PRESSED_OPACITY }]}
            >
              <Text style={[styles.statusLabel, styles.retryLabel, { color: toneColor }]}>
                {tone.label} · retry
              </Text>
            </Pressable>
          )}
        </View>
        <Pressable
          accessibilityLabel="Smaller text"
          accessibilityRole="button"
          onPress={smaller}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.headerGlyph, { color: t('fg-2') }]}>A−</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Larger text"
          accessibilityRole="button"
          onPress={larger}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.headerGlyph, styles.headerGlyphLarge, { color: t('fg-2') }]}>A+</Text>
        </Pressable>
        {/* Native-only affordance: the PWA reaches Claude shells from Ops,
            which the full-bleed terminal covers. */}
        <Pressable
          accessibilityLabel="Claude shells"
          accessibilityRole="button"
          onPress={() => setShellsOpen(true)}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.headerGlyph, { color: t('fg-2') }]}>shells</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Lock terminal"
          accessibilityRole="button"
          onPress={onLock}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <SymbolView name="lock" size={15} tintColor={t('fg-3')} weight="regular" />
        </Pressable>
      </View>

      <View
        style={styles.canvas}
        onLayout={(event) => setBoxHeight(event.nativeEvent.layout.height)}
      >
        {boxHeight > 0 ? (
          <XtermHost
            ref={host}
            theme={theme}
            fontSize={fontSize}
            height={boxHeight}
            viewportHeight={viewportHeight}
            onSize={onSize}
            onAck={onAck}
            onData={onKey}
          />
        ) : null}
      </View>

      <KeyboardStickyView>
        <KeyBar onKey={onKey} onRunbooks={() => setRunbooksOpen(true)} />
        <Composer ref={composer} onSend={sendLine} disabled={status !== 'connected'} />
        <View style={{ height: bottomSpacerHeight(keyboardHeight, insets.bottom) }} />
      </KeyboardStickyView>

      <Runbooks
        open={runbooksOpen}
        onClose={() => setRunbooksOpen(false)}
        onDismissed={applyPendingFill}
        onSnippet={(cmd) => {
          pendingFill.current = cmd;
        }}
      />
      <SessionPicker
        open={shellsOpen}
        onClose={() => setShellsOpen(false)}
        onDismissed={applyPendingFill}
        onAttach={(cmd) => {
          pendingFill.current = cmd;
        }}
      />
    </View>
  );
}

export default function TerminalScreen() {
  const unlocked = useTerminalLock((s) => s.unlocked);
  const hydrated = useTerminalLock((s) => s.hydrated);
  const hydrate = useTerminalLock((s) => s.hydrate);
  const lock = useTerminalLock((s) => s.lock);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Render nothing until the unlock stamp has been read: a valid stamp would
  // otherwise flash the lock screen — and its Face ID button — for a frame.
  if (!hydrated) return null;
  if (!unlocked) return <LockScreen />;
  return <TerminalSurface onLock={() => void lock()} />;
}

const styles = StyleSheet.create({
  backRow: { minHeight: 44, justifyContent: 'center', paddingBottom: 10 },
  backLabel: { fontFamily: fonts.sans(520), fontSize: 13 },
  lockBody: { alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 80 },
  padlock: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockCopy: { fontFamily: fonts.sans(400), fontSize: 14, textAlign: 'center', maxWidth: 280 },
  lockError: { fontFamily: fonts.sans(400), fontSize: 12.5, textAlign: 'center', maxWidth: 280 },
  unlock: {
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 24,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  unlockLabel: { fontFamily: fonts.sans(600), fontSize: 14 },

  surface: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  headerBack: { minWidth: 44, minHeight: 36, justifyContent: 'center' },
  headerBackGlyph: { fontFamily: fonts.sans(400), fontSize: 22 },
  headerTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
  dotSlot: { width: DOT_SIZE, height: DOT_SIZE, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2 },
  headerName: { flex: 1, fontFamily: fonts.mono(400), fontSize: 12 },
  statusLabel: { fontFamily: fonts.mono(400), fontSize: 10 },
  retry: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 6 },
  retryLabel: { textDecorationLine: 'underline' },
  headerButton: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  headerGlyph: { fontFamily: fonts.mono(400), fontSize: 12 },
  headerGlyphLarge: { fontSize: 14 },
  canvas: { flex: 1 },
});
