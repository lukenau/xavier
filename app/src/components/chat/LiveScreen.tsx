// The Live screen: hands-free voice with Xavier, built around the Aperture.
// Stacked zones that never overlap: the thread's transcript (scroll back to
// find something mid-conversation; it follows the newest message unless you
// have scrolled up), a large "now" line (what you are saying, or the sentence
// Xavier is speaking with its unspoken words dimmed), the Aperture (petrol
// blooms with you, gold with Xavier), and the controls (Mute, state, End).
//
// All of the session lives in live/useLiveSession.ts; this file only renders.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVoiceSettings } from '../../chat/voiceSettings';
import { useThreadDetail } from '../../chat/hooks';
import { selectMessages, selectThread, useChatStore } from '../../chat/store';
import { MessageBubble } from './MessageBubble';
import { fonts } from '../../theme/fonts';
import { dark } from '../../theme/tokens.gen';
import { useTheme } from '../../theme/useTheme';
import { XAVIER_SCREEN } from '../../theme/whimsy';
import { Ground, PRESSED_OPACITY, Toast, useHideTabBar, useReducedMotion } from '../shell';
import { Aperture } from './live/Aperture';
import { sentenceAt } from './live/aperture';
import { useLiveSession, type LivePhase } from './live/useLiveSession';

export type { LivePhase };

export const PHASE_LABEL: Record<LivePhase, string> = {
  off: 'Live',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  reconnecting: 'Reconnecting',
};

/** `m:ss` since the session started. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Hermes's busy acknowledgements (⏩ steer, ↪ redirect, ⏳ queue, ⚡ interrupt)
// and its ⏳ working heartbeats land in the thread as assistant text. In Live
// they are noise; the server already keeps them out of the voice.
const BUSY_NOTICE = /^\s*[⏩↪⏳⚡]/;
function isBusyNotice(m: { role: string; parts: { type: string; text?: string }[] }): boolean {
  if (m.role !== 'assistant') return false;
  const first = m.parts.find((p) => p.type === 'text');
  return !!first?.text && BUSY_NOTICE.test(first.text);
}

/** The line under the state word: what a tap does right now. */
export function phaseHint(phase: LivePhase, muted: boolean, held: boolean): string {
  if (held) return 'on hold for a call';
  if (phase === 'off') return 'tap the dots to start';
  if (phase === 'speaking') return 'tap to cut in';
  if (phase === 'thinking') return 'tap to stop him';
  if (phase === 'reconnecting') return 'talk again once it is back';
  return muted ? 'muted' : 'go ahead';
}

/** The LED panel stays dark in both themes, like Xavier's tiles: the screen
 * ground they share, with the dark theme's border for the unlit dots. */
const PANEL = { panel: XAVIER_SCREEN.ground, dim: dark.border };

export function LiveSurface({ threadId, onNewSession }: { threadId: string; onNewSession?: () => void }) {
  useHideTabBar();
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const settings = useVoiceSettings((s) => s.settings);
  const hydrateSettings = useVoiceSettings((s) => s.hydrate);
  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  const live = useLiveSession(threadId, settings.tts);
  const { phase } = live;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (live.startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live.startedAt]);

  useThreadDetail(threadId);
  const allMessages = useChatStore(selectMessages(threadId));
  const messages = useMemo(() => allMessages.filter((m) => !isBusyNotice(m)), [allMessages]);
  const threadTitle = useChatStore(selectThread(threadId))?.title ?? '';
  const subtitle = threadTitle.startsWith('Live · ') ? threadTitle.slice('Live · '.length) : '';

  // Follow the newest message unless the user scrolled up to look at something.
  const transcript = useRef<ScrollView>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);
  const onContent = useCallback(() => {
    if (atBottom.current) transcript.current?.scrollToEnd?.({ animated: true });
    else setBehind(true);
  }, []);
  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number }; layoutMeasurement: { height: number }; contentSize: { height: number } } }) => {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
      if (atBottom.current) setBehind(false);
    },
    [],
  );
  const jumpToNow = useCallback(() => {
    atBottom.current = true;
    setBehind(false);
    transcript.current?.scrollToEnd?.({ animated: true });
  }, []);

  const size = Math.min(width - 64, height * 0.3, 300);
  const colors = useMemo(
    () => ({ ...PANEL, you: t('petrol'), xavier: t('accent'), warn: t('status-warn') }),
    [t],
  );

  const onStage = useCallback(() => {
    if (phase === 'off') void live.start();
    else if (phase === 'speaking' || phase === 'thinking') live.interrupt();
  }, [phase, live]);

  const [heard, rest] = live.replyCut ? [sentenceAt(live.reply, live.progress)[0], ''] : sentenceAt(live.reply, live.progress);
  const speakingNow = phase === 'speaking' && live.reply;
  const elapsed = live.startedAt === null ? null : formatElapsed((now - live.startedAt) / 1000);
  const label = live.held ? 'On hold' : PHASE_LABEL[phase];

  return (
    <View style={[styles.surface, { backgroundColor: t('bg-0') }]} testID="live-surface">
      <Ground />
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <SymbolView name="chevron.left" size={20} tintColor={t('accent')} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={[styles.headerTitle, { color: t('fg-1') }]} numberOfLines={1}>
            Live{elapsed ? <Text style={[styles.clock, { color: t('fg-3') }]}>{`  ${elapsed}`}</Text> : null}
          </Text>
          {subtitle ? (
            <Text testID="live-subtitle" style={[styles.subtitle, { color: t('fg-3') }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {onNewSession ? (
          <Pressable
            accessibilityLabel="New live session"
            accessibilityRole="button"
            onPress={onNewSession}
            style={({ pressed }) => [styles.headerButton, pressed && { opacity: PRESSED_OPACITY }]}
          >
            <SymbolView name="square.and.pencil" size={19} tintColor={t('fg-3')} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel="Voice settings"
          accessibilityRole="button"
          onPress={() => router.push('/live-settings')}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <SymbolView name="slider.horizontal.3" size={19} tintColor={t('fg-3')} />
        </Pressable>
      </View>

      <View style={styles.transcriptZone}>
        <ScrollView
          ref={transcript}
          contentContainerStyle={styles.transcriptBody}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={onContent}
          onScroll={onScroll}
          scrollEventThrottle={64}
          testID="live-transcript"
        >
          {messages.length === 0 && phase === 'off' ? (
            <Text style={[styles.empty, { color: t('fg-4') }]}>
              Tap the dots and start talking. Xavier answers out loud, and the conversation is kept here.
            </Text>
          ) : null}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </ScrollView>
        {behind ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to now"
            onPress={jumpToNow}
            testID="live-jump"
            style={({ pressed }) => [
              styles.jump,
              { backgroundColor: t('bg-2'), borderColor: t('border') },
              pressed && { opacity: PRESSED_OPACITY },
            ]}
          >
            <SymbolView name="arrow.down" size={13} tintColor={t('fg-1')} />
            <Text style={[styles.jumpText, { color: t('fg-1') }]}>Jump to now</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.now} testID="live-now">
        {speakingNow ? (
          <Text style={[styles.nowText, { color: t('fg-0') }]} numberOfLines={3} testID="live-reply">
            {heard}
            <Text style={{ color: t('fg-4') }}>{rest}</Text>
            {live.replyCut ? <Text style={{ color: t('fg-4') }}> —</Text> : null}
          </Text>
        ) : live.you && phase !== 'off' ? (
          <Text testID="live-you" style={[styles.nowText, { color: t('petrol') }]} numberOfLines={3}>
            {live.youFinal ? live.you : `${live.you}…`}
          </Text>
        ) : null}
      </View>

      {phase === 'reconnecting' ? (
        <View
          accessibilityRole="alert"
          testID="live-reconnecting"
          style={[styles.banner, { backgroundColor: t('bg-2'), borderColor: t('status-warn') }]}
        >
          <Text style={[styles.bannerText, { color: t('status-warn') }]}>
            Reconnecting. The conversation is kept; talk again once it is back.
          </Text>
        </View>
      ) : null}

      {live.unavailable && phase === 'off' ? (
        <View
          accessibilityRole="alert"
          testID="live-unavailable"
          style={[styles.banner, { backgroundColor: t('bg-2'), borderColor: t('status-warn') }]}
        >
          <Text style={[styles.bannerText, { color: t('status-warn') }]}>{live.unavailable}</Text>
        </View>
      ) : null}

      <Pressable
        style={styles.stage}
        onPress={onStage}
        testID="live-stage"
        accessibilityRole="button"
        accessibilityLabel={phase === 'off' ? 'Start Live' : phase === 'speaking' ? 'Cut in' : `Live, ${label}`}
      >
        <Aperture
          size={size}
          level={live.level}
          mode={live.mode}
          progress={live.progressSV}
          colors={colors}
          reduceMotion={reduceMotion}
        />
      </Pressable>

      <View style={[styles.foot, { paddingBottom: insets.bottom + 16 }]}>
        <RoundButton
          symbol={live.muted ? 'mic.slash.fill' : 'mic.fill'}
          label={live.muted ? 'Unmute' : 'Mute'}
          tint={live.muted ? t('status-warn') : t('fg-1')}
          bg={t('bg-2')}
          border={t('border')}
          disabled={phase === 'off'}
          onPress={live.toggleMute}
          testID="live-mute"
        />
        <View style={styles.state}>
          <Text testID="live-state" style={[styles.stateWord, { color: t('fg-0') }]}>
            {label}
          </Text>
          <Text style={[styles.stateHint, { color: t('fg-3') }]}>{phaseHint(phase, live.muted, live.held)}</Text>
        </View>
        <RoundButton
          symbol="xmark"
          label="End Live"
          tint={t('status-down')}
          bg={t('bg-2')}
          border={t('border')}
          disabled={phase === 'off'}
          onPress={live.end}
          testID="live-end"
        />
      </View>

      {live.notice ? <Toast kind="err" text={live.notice} onDone={live.clearNotice} /> : null}
    </View>
  );
}

function RoundButton(props: {
  symbol: string;
  label: string;
  tint: string;
  bg: string;
  border: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: props.bg, borderColor: props.border, opacity: props.disabled ? 0.35 : 1 },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <SymbolView name={props.symbol as never} size={22} tintColor={props.tint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 4 },
  headerButton: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  headerText: { flex: 1, minWidth: 0, marginLeft: 2 },
  headerTitle: { fontFamily: fonts.sans(600), fontSize: 16 },
  clock: { fontFamily: fonts.mono(400), fontSize: 12, fontVariant: ['tabular-nums'] },
  subtitle: { fontFamily: fonts.sans(400), fontSize: 12, marginTop: 1 },
  transcriptZone: { flex: 1, minHeight: 140 },
  transcriptBody: { paddingHorizontal: 14, paddingVertical: 8, gap: 2, flexGrow: 1, justifyContent: 'flex-end' },
  empty: { fontFamily: fonts.sans(500), fontSize: 17, lineHeight: 24, paddingHorizontal: 10 },
  jump: {
    position: 'absolute',
    bottom: 8,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
  },
  jumpText: { fontFamily: fonts.sans(560), fontSize: 13 },
  now: { minHeight: 64, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 6 },
  nowText: { fontFamily: fonts.sans(520), fontSize: 22, lineHeight: 29 },
  banner: { marginHorizontal: 16, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  bannerText: { fontFamily: fonts.sans(500), fontSize: 13, textAlign: 'center' },
  stage: { alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingTop: 8,
  },
  state: { alignItems: 'center', gap: 3, flex: 1 },
  stateWord: { fontFamily: fonts.sans(600), fontSize: 26 },
  stateHint: { fontFamily: fonts.sans(400), fontSize: 13 },
  round: { width: 56, height: 56, borderRadius: 28, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
