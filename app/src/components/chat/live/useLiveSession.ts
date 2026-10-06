// Everything a Live session does, behind one hook: the /api/live socket, the
// mic, gapless playback, earcons and haptics, mute, phone-call/Siri holds and
// AirPods route changes. The screen only renders what this returns.
//
// The session deliberately survives the app going to the background: the
// build carries UIBackgroundModes=audio (expo-audio's config plugin default),
// and a running playAndRecord session keeps the app, socket and timers alive
// with the screen locked. It ends on End, unmount, or the server's own end.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import { haptic } from '../../../whimsy';
import { useChatLock } from '../../../chat/lock';
import { connectLive, type LiveClient, type LiveStatus } from '../../../lib/live/client';
import type { LiveServerFrame, LiveTts } from '../../../lib/live/protocol';
import { createPcmPlayer, TTS_RATE, type AudioContextLike, type PcmPlayer } from '../../../lib/live/player';
import { configureLiveAudio, startMic, type Mic } from '../../../lib/live/mic';
import { playEarcon, type Earcon, type ToneContextLike } from '../../../lib/live/earcons';
import { LIVE_VP_BYPASS, nativeLiveAudio } from '../../../lib/live/aec';
import { createNativeLiveAudio, NATIVE_RATE, type NativeLiveAudio } from '../../../lib/live/native';
import type { LiveAudioNative } from '../../../../modules/live-audio';
import { APERTURE_MODE, splitHeard, type ApertureMode } from './aperture';

type AudioApi = typeof import('react-native-audio-api');

export type LivePhase = 'off' | 'listening' | 'thinking' | 'speaking' | 'reconnecting';

const WORKING_FIRST_MS = 1200;
const WORKING_EVERY_MS = 3000;
const LEVEL_POLL_MS = 50;
/** No mic frame for this long during a session means the recorder stalled. */
const MIC_STALL_MS = 2000;
/** Starting guess for the voice's speaking rate; recalibrated from every
 * finished turn (its real audio length over its text length). */
const MS_PER_CHAR = 65;

/** What the server's `ended{reason}` means to the person holding the phone. */
export const ENDED_NOTICE: Record<string, string> = {
  idle: 'Live ended after a few quiet minutes.',
  unavailable: 'Live lost its connection to the speech service. Try again in a moment.',
  unconfigured:
    'Live voice is not set up on this server. It needs a Deepgram API key: DEEPGRAM_API_KEY in the server’s .env.',
};

export interface LiveDeps {
  loadAudioApi: () => Promise<AudioApi>;
  connect: typeof connectLive;
  startMic: typeof startMic;
  /** The native voice-processing engine, or null to use react-native-audio-api. */
  nativeAudio: () => LiveAudioNative | null;
  /** The server refused the session (1008): drop back to the Face ID lock. */
  relock: () => void;
}

const defaultDeps: LiveDeps = {
  // A lazy require, not import(): jest's module mocks only see require, and
  // the native module must not load before Live is opened.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadAudioApi: async () => require('react-native-audio-api') as AudioApi,
  connect: connectLive,
  startMic,
  nativeAudio: nativeLiveAudio,
  relock: () => void useChatLock.getState().lock(),
};

export function useLiveSession(threadId: string, tts: LiveTts, deps: LiveDeps = defaultDeps) {
  const [phase, setPhase] = useState<LivePhase>('off');
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [you, setYou] = useState('');
  const [youFinal, setYouFinal] = useState(false);
  const [reply, setReply] = useState('');
  const [replyCut, setReplyCut] = useState(false);
  const [progress, setProgress] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Why Live cannot run at all on this server; stays up until the next start.
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const level = useSharedValue(0);
  const mode = useSharedValue<ApertureMode>(APERTURE_MODE.off);
  const progressSV = useSharedValue(0);

  const api = useRef<AudioApi | null>(null);
  const ctx = useRef<(AudioContextLike & ToneContextLike) | null>(null);
  const client = useRef<LiveClient | null>(null);
  const player = useRef<PcmPlayer | null>(null);
  const mic = useRef<Mic | null>(null);
  const mutedRef = useRef(false);
  const phaseRef = useRef<LivePhase>('off');
  const replyTurn = useRef<number | null>(null);
  const replyText = useRef('');
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const working = useRef<ReturnType<typeof setInterval> | null>(null);
  const workingStart = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msPerChar = useRef(MS_PER_CHAR);
  const heardLen = useRef(-1);
  const subs = useRef<{ remove(): void }[]>([]);
  const generation = useRef(0);
  // Mic restarts run one at a time: a call ending and an AirPods route change
  // arrive together, and two overlapping restarts would run two recorders.
  const micChain = useRef<Promise<void>>(Promise.resolve());
  const sessionActive = useRef(false);
  // A call or Siri holds the session; the mic is silent on purpose meanwhile.
  const heldRef = useRef(false);
  const lastMicFrame = useRef(0);
  const micRestarts = useRef(0);
  const native = useRef<NativeLiveAudio | null>(null);
  const onNative = useRef(false);

  const tone = useCallback((kind: Earcon) => {
    if (onNative.current) native.current?.tone(kind);
    else if (ctx.current) playEarcon(ctx.current, kind);
  }, []);

  const toPhase = useCallback(
    (next: LivePhase) => {
      phaseRef.current = next;
      setPhase(next);
      if (working.current) clearInterval(working.current);
      if (workingStart.current) clearTimeout(workingStart.current);
      working.current = null;
      workingStart.current = null;
      if (next === 'thinking') {
        workingStart.current = setTimeout(() => {
          tone('working');
          working.current = setInterval(() => tone('working'), WORKING_EVERY_MS);
        }, WORKING_FIRST_MS);
      }
    },
    [tone],
  );

  useEffect(() => {
    const m: Record<LivePhase, ApertureMode> = {
      off: APERTURE_MODE.off,
      listening: muted ? APERTURE_MODE.muted : APERTURE_MODE.listening,
      thinking: APERTURE_MODE.thinking,
      speaking: APERTURE_MODE.speaking,
      reconnecting: APERTURE_MODE.reconnecting,
    };
    mode.value = m[phase];
    if (phase !== 'listening' && phase !== 'speaking') level.value = 0;
  }, [phase, muted, mode, level]);

  const teardown = useCallback(() => {
    generation.current += 1;
    for (const t of timers.current) clearInterval(t);
    timers.current = [];
    if (working.current) clearInterval(working.current);
    if (workingStart.current) clearTimeout(workingStart.current);
    working.current = null;
    workingStart.current = null;
    for (const s of subs.current) s.remove();
    subs.current = [];
    const m = mic.current;
    mic.current = null;
    if (m) void m.stop().catch(() => {});
    client.current?.stop();
    client.current = null;
    player.current?.cancel();
    player.current = null;
  }, []);

  /** Give the audio session back so other apps' audio resumes. */
  const release = useCallback(() => {
    if (!sessionActive.current) return;
    sessionActive.current = false;
    if (onNative.current) void native.current?.stop().catch(() => {});
    else void api.current?.AudioManager.setAudioSessionActivity(false).catch(() => {});
  }, []);

  const end = useCallback(() => {
    if (phaseRef.current === 'off') return;
    tone('end');
    haptic('tap');
    teardown();
    // Let the end tone play out before the engine stops; a new session
    // started meanwhile (generation moved) keeps the session.
    const gen = generation.current;
    setTimeout(() => {
      if (generation.current === gen) release();
    }, 350);
    setStartedAt(null);
    setYou('');
    setReply('');
    heldRef.current = false;
    setHeld(false);
    toPhase('off');
  }, [release, teardown, toPhase, tone]);

  const apply = useCallback(
    (frame: LiveServerFrame) => {
      const p = player.current;
      switch (frame.type) {
        case 'state':
          toPhase(frame.value);
          return;
        case 'heard':
          setYou(frame.text);
          setYouFinal(frame.final);
          if (frame.final) {
            tone('heard');
            haptic('tap');
          }
          return;
        case 'speak_start':
          replyTurn.current = frame.turn_id;
          replyText.current = '';
          heardLen.current = -1;
          setReply('');
          setReplyCut(false);
          setProgress(0);
          progressSV.value = 0;
          p?.start(frame.turn_id);
          return;
        case 'audio':
          p?.push(frame.data);
          return;
        case 'speak_end':
          if (frame.turn_id === replyTurn.current) p?.end();
          return;
        case 'caption':
          if (frame.turn_id === replyTurn.current) {
            replyText.current += frame.text;
            setReply(replyText.current);
          }
          return;
        case 'cancel':
          p?.cancel(frame.turn_id);
          if (frame.turn_id === replyTurn.current) setReplyCut(true);
          return;
        case 'duck':
          p?.duck(true);
          return;
        case 'unduck':
          p?.duck(false);
          return;
        case 'ended':
          if (frame.reason === 'unconfigured') setUnavailable(ENDED_NOTICE.unconfigured);
          else setNotice(ENDED_NOTICE[frame.reason] ?? 'Live ended.');
          end();
          return;
        case 'notice':
          setNotice(frame.message);
          return;
        default:
          return;
      }
    },
    [end, progressSV, toPhase, tone],
  );

  const onMicFrame = useCallback(
    (pcm: ArrayBuffer, lvl: number) => {
      lastMicFrame.current = Date.now();
      client.current?.sendAudio(mutedRef.current ? new ArrayBuffer(pcm.byteLength) : pcm);
      if (phaseRef.current === 'listening' && !mutedRef.current) level.value = Math.min(1, lvl * 5);
    },
    [level],
  );

  const playerCallbacks = useCallback(
    () => ({
      onProgress: (turnId: number, playedMs: number) => {
        client.current?.playback(turnId, playedMs);
      },
      onDrained: (turnId: number) => {
        client.current?.drained(turnId);
        progressSV.value = 1;
        setProgress(1);
      },
    }),
    [progressSV],
  );

  const restartMic = useCallback((): Promise<void> => {
    const gen = generation.current;
    const next = micChain.current.then(async () => {
      if (gen !== generation.current) return;
      const old = mic.current;
      mic.current = null;
      if (old) await old.stop().catch(() => {});
      if (gen !== generation.current) return;
      lastMicFrame.current = Date.now();
      const fresh = await deps.startMic(onMicFrame, {
        onError: (message) => client.current?.diag(`mic error: ${message}`),
      });
      if (gen !== generation.current) {
        await fresh.stop().catch(() => {});
        return;
      }
      mic.current = fresh;
      // Evidence for the server log: what the native side reports right after start.
      // The input's kind, not its name: a Bluetooth device's name is often its
      // owner's ("…'s AirPods").
      const devices = await api.current?.AudioManager.getDevicesInfo?.().catch(() => null);
      const input = (devices as { currentInputs?: { category?: string }[] } | null)?.currentInputs
        ?.map((d) => d.category)
        .join(',');
      client.current?.diag(`mic started: recording=${fresh.isRecording()} input=${input ?? '?'}`);
    });
    micChain.current = next.catch(() => {});
    return next;
  }, [deps, onMicFrame]);

  const start = useCallback(async () => {
    if (phaseRef.current !== 'off') return;
    teardown();
    const gen = generation.current;
    micRestarts.current = 0;
    setNotice(null);
    setUnavailable(null);
    setYou('');
    setReply('');
    setStartedAt(Date.now());
    toPhase('listening');
    const startTimers = () => {
      timers.current.push(
        setInterval(() => {
          if (heldRef.current) {
            // On hold the mic is meant to be silent; the clock starts again after.
            lastMicFrame.current = Date.now();
            return;
          }
          if (phaseRef.current === 'off' || Date.now() - lastMicFrame.current < MIC_STALL_MS) return;
          lastMicFrame.current = Date.now();
          if (onNative.current) {
            // The native engine restarts itself; a stall it did not recover
            // from is reported, never papered over with a restart loop.
            if (micRestarts.current === 0) {
              micRestarts.current = 1;
              client.current?.diag('mic watchdog: native engine sent no frames for 2 s');
              setNotice("The microphone isn't sending audio. Live can't hear you.");
            }
            return;
          }
          // One restart per session. Each restart stops and restarts the
          // library's audio engine, and repeating that freezes the page.
          if (micRestarts.current >= 1) {
            if (micRestarts.current === 1) {
              micRestarts.current += 1;
              client.current?.diag('mic watchdog: still no frames after a restart, giving up');
              setNotice("The microphone isn't sending audio on this build. Live can't hear you.");
            }
            return;
          }
          micRestarts.current += 1;
          client.current?.diag(
            `mic watchdog: no frames for 2 s (recording=${mic.current?.isRecording()}), restarting the mic`,
          );
          void restartMic();
        }, 1000),
        setInterval(() => {
          const p = player.current;
          if (phaseRef.current !== 'speaking' || !p) return;
          level.value = Math.min(1, p.level() * 4);
          // Caption highlight from the audio actually heard: the real length
          // once the turn's audio is all in, the calibrated rate until then.
          const text = replyText.current;
          if (!text) return;
          if (p.complete() && p.receivedMs() > 0) msPerChar.current = p.receivedMs() / text.length;
          const total = p.complete() ? p.receivedMs() : Math.max(p.receivedMs(), text.length * msPerChar.current);
          const share = total > 0 ? Math.min(1, p.playedMsNow() / total) : 0;
          progressSV.value = share;
          const len = splitHeard(text, share)[0].length;
          if (len !== heardLen.current) {
            heardLen.current = len;
            setProgress(share);
          }
        }, LEVEL_POLL_MS),
      );
    };
    const onStatus = (s: LiveStatus) => {
      if (s === 'reconnecting') toPhase('reconnecting');
      else if (s === 'locked') {
        // The chat session expired or was revoked. Retrying would be refused
        // the same way; the chat lock asks for Face ID again.
        setNotice('Live is locked. Unlock with Face ID to talk again.');
        end();
        deps.relock();
      } else if (s === 'refused') {
        // The server's Origin check refused the app: a configuration problem
        // on the server, not a lapsed session, so chat stays unlocked.
        setNotice('The server refused Live from this app (its Origin check). Check HUB_ORIGIN in its .env.');
        end();
      }
    };
    try {
      const mod = deps.nativeAudio();
      onNative.current = mod !== null;
      if (mod) {
        // Apple voice processing on our own engine: echo cancelled, so you can
        // talk over Xavier. Route changes and engine restarts are handled
        // natively (same engine, never rebuilt); JS only hears about them.
        const nat = native.current ?? createNativeLiveAudio(mod);
        native.current = nat;
        // With voice processing bypassed (aec.ts) there is no echo cancellation,
        // and the server must treat speech during a reply as possible echo.
        const bypass = LIVE_VP_BYPASS && !!mod.setVoiceProcessingBypassed;
        client.current = deps.connect({
          threadId,
          aec: !bypass,
          micRate: NATIVE_RATE,
          tts,
          onFrame: apply,
          onStatus,
        });
        subs.current.push(
          nat.onDiag((message) => client.current?.diag(message)),
          nat.onInterruption((began) => {
            if (began) {
              player.current?.cancel();
              client.current?.hold();
            }
            heldRef.current = began;
            setHeld(began);
          }),
        );
        sessionActive.current = true;
        lastMicFrame.current = Date.now();
        const info = await nat.start(onMicFrame);
        if (gen !== generation.current) {
          // The session ended while the engine was starting (the permission
          // prompt was up, say, when the server refused it). If that end has
          // already given the audio session back, the engine started after the
          // stop; stop it again rather than leave the mic running.
          if (!sessionActive.current) void nat.stop().catch(() => {});
          return;
        }
        if (bypass) mod.setVoiceProcessingBypassed?.(true);
        client.current?.diag(
          `native audio: voiceProcessing=${info.voiceProcessing} route=${info.route} input=${info.inputFormat} micMode=${info.micMode ?? '?'}`,
        );
        tone('start');
        haptic('tap');
        player.current = nat.createPlayer(playerCallbacks());
        startTimers();
        return;
      }
      const audio = api.current ?? (await deps.loadAudioApi());
      api.current = audio;
      await configureLiveAudio(audio);
      sessionActive.current = true;
      if (gen !== generation.current) {
        // Ended during the permission prompt: hand the session back now, since
        // that end found nothing to release yet.
        if (phaseRef.current === 'off') release();
        return;
      }
      client.current = deps.connect({
        threadId,
        aec: false,
        tts,
        onFrame: apply,
        onStatus,
      });
      // The mic attaches BEFORE anything plays, so the engine's input is set
      // up on an idle engine: enabling input on a running one can change the
      // hardware format mid-flight, and the configuration change that follows
      // makes the library rebuild its engine while the mic never settles.
      await restartMic();
      if (gen !== generation.current) return;
      if (!ctx.current) {
        ctx.current = new audio.AudioContext({
          sampleRate: TTS_RATE,
        }) as unknown as AudioContextLike & ToneContextLike;
      }
      tone('start');
      haptic('tap');
      player.current = createPcmPlayer(ctx.current, playerCallbacks());
      audio.AudioManager.observeAudioInterruptions(true);
      subs.current.push(
        audio.AudioManager.addSystemEventListener('interruption', (e) => {
          if (e.type === 'began') {
            // A call or Siri: stop the speaker, but let Xavier finish working
            // (the reply lands in the thread either way).
            player.current?.cancel();
            client.current?.hold();
            heldRef.current = true;
            setHeld(true);
          } else {
            void audio.AudioManager.setAudioSessionActivity(true)
              .then(() => (ctx.current as { resume?: () => Promise<unknown> } | null)?.resume?.())
              .then(() => restartMic())
              .catch(() => {});
            heldRef.current = false;
            setHeld(false);
          }
        }),
        audio.AudioManager.addSystemEventListener('routeChange', (e) => {
          client.current?.diag(`route change: ${e.reason}`);
          if (e.reason === 'NewDeviceAvailable' || e.reason === 'OldDeviceUnavailable') void restartMic();
        }),
      );
      startTimers();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Live could not start.');
      teardown();
      release();
      setStartedAt(null);
      toPhase('off');
    }
  }, [
    apply,
    deps,
    end,
    level,
    onMicFrame,
    playerCallbacks,
    progressSV,
    release,
    restartMic,
    teardown,
    threadId,
    toPhase,
    tone,
    tts,
  ]);

  const interrupt = useCallback(() => {
    client.current?.interrupt();
    player.current?.cancel();
    setReplyCut(true);
    haptic('tap');
    toPhase('listening');
  }, [toPhase]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
    if (mutedRef.current) level.value = 0;
    haptic('select');
  }, [level]);

  useEffect(
    () => () => {
      teardown();
      release();
    },
    [release, teardown],
  );

  // Only a native module that has the picker gets the button.
  const micModes = deps.nativeAudio();
  const showMicModes = micModes?.showMicModes ? () => micModes.showMicModes?.() : null;

  return {
    showMicModes,
    phase,
    muted,
    held,
    you,
    youFinal,
    reply,
    replyCut,
    progress,
    startedAt,
    notice,
    clearNotice: () => setNotice(null),
    unavailable,
    level,
    mode,
    progressSV,
    start,
    end,
    interrupt,
    toggleMute,
  };
}
