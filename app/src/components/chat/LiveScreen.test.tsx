// LiveScreen + useLiveSession: the screen's wiring between the /api/live
// client, the mic, the player and what the screen shows. The transport, player
// and mic have their own suites (src/lib/live); here they are fakes.
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { LiveServerFrame } from '../../lib/live/protocol';
import { DEFAULT_VOICE_SETTINGS } from '../../lib/live/settings';
import { useVoiceSettings } from '../../chat/voiceSettings';
import { useChatStore } from '../../chat/store';
import { useChatLock } from '../../chat/lock';
import { formatElapsed, LiveSurface, phaseHint } from './LiveScreen';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('./live/Aperture', () => ({ Aperture: () => null }));
jest.mock('react-native-reanimated', () => ({ useSharedValue: (v: unknown) => ({ value: v }) }));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(cb, [cb]);
  },
}));

const mockClient = {
  sendAudio: jest.fn(),
  playback: jest.fn(),
  drained: jest.fn(),
  interrupt: jest.fn(),
  hold: jest.fn(),
  diag: jest.fn(),
  stop: jest.fn(),
};
let mockConnectOpts: {
  threadId: string;
  aec: boolean;
  micRate?: number;
  tts: { voice: string };
  onFrame(f: LiveServerFrame): void;
  onStatus(s: string): void;
} | null = null;
jest.mock('../../lib/live/client', () => ({
  connectLive: (opts: typeof mockConnectOpts) => {
    mockConnectOpts = opts;
    return mockClient;
  },
}));

const mockClock = { played: 0, received: 0, complete: false };
const mockPlayer = {
  start: jest.fn(),
  push: jest.fn(),
  end: jest.fn(),
  cancel: jest.fn(),
  duck: jest.fn(),
  level: () => 0,
  playedMsNow: () => mockClock.played,
  receivedMs: () => mockClock.received,
  complete: () => mockClock.complete,
};
let mockPlayerCb: { onProgress(t: number, ms: number): void; onDrained(t: number): void } | null = null;
jest.mock('../../lib/live/player', () => ({
  ...jest.requireActual('../../lib/live/player'),
  TTS_RATE: 24000,
  createPcmPlayer: (_ctx: unknown, cb: typeof mockPlayerCb) => {
    mockPlayerCb = cb;
    return mockPlayer;
  },
}));

let mockMicFrame: ((pcm: ArrayBuffer, level: number) => void) | null = null;
let mockMicError: ((m: string) => void) | null = null;
let mockMicLive = 0;
let mockMicMax = 0;
let mockMicGate: Promise<void> | null = null;
const mockMicStop = jest.fn(() => {
  mockMicLive -= 1;
  return Promise.resolve();
});
jest.mock('../../lib/live/mic', () => ({
  configureLiveAudio: jest.fn(() => mockConfigureGate ?? Promise.resolve()),
  startMic: jest.fn(async (cb: (pcm: ArrayBuffer, level: number) => void, opts?: { onError?: (m: string) => void }) => {
    mockMicError = opts?.onError ?? null;
    mockOrder.push('mic');
    if (mockMicGate) await mockMicGate;
    await new Promise((r) => setTimeout(r, 0));
    mockMicFrame = cb;
    mockMicLive += 1;
    mockMicMax = Math.max(mockMicMax, mockMicLive);
    return { stop: mockMicStop, isRecording: () => true };
  }),
}));
jest.mock('../../chat/hooks', () => ({ useThreadDetail: () => ({ data: null, refetch: jest.fn() }) }));
jest.mock('./MessageBubble', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Text } = require('react-native');
  return { MessageBubble: ({ message }: { message: { id: string; parts: { text?: string }[] } }) => <Text testID={`bubble-${message.id}`}>{message.parts.map((p) => p.text ?? '').join('')}</Text> };
});
jest.mock('../../lib/live/earcons', () => ({ ...jest.requireActual('../../lib/live/earcons'), playEarcon: jest.fn() }));
// The native voice-processing engine: null = the react-native-audio-api path.
const mockNative = {
  mod: null as null | ReturnType<typeof fakeNative>,
};
function fakeNative() {
  const listeners = new Map<string, Set<(e: never) => void>>();
  return {
    requestPermission: jest.fn(async () => true),
    start: jest.fn(async () => ({
      voiceProcessing: true,
      inputFormat: 'mono 24k',
      route: 'iPhone Microphone',
      sampleRate: 24000,
    })),
    stop: jest.fn(async () => {}),
    enqueue: jest.fn(),
    playTone: jest.fn(),
    clear: jest.fn(),
    setDucked: jest.fn(),
    addListener(name: string, cb: (e: never) => void) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(cb);
      return { remove: () => set.delete(cb) };
    },
    fire(name: string, e: unknown) {
      for (const cb of listeners.get(name) ?? []) (cb as (x: unknown) => void)(e);
    },
  };
}
jest.mock('../../../modules/live-audio', () => ({ LiveAudio: null }));
jest.mock('../../lib/live/aec', () => ({ nativeLiveAudio: () => mockNative.mod }));
jest.mock('../../whimsy', () => ({ ...jest.requireActual('../../whimsy'), haptic: jest.fn() }));

const mockSystem: Record<string, (e: { type?: string; reason?: string }) => void> = {};
let mockConfigureGate: Promise<void> | null = null;
const mockActivity = jest.fn((_on: boolean) => Promise.resolve(true));
const mockOrder: string[] = [];
jest.mock('react-native-audio-api', () => ({
  AudioContext: class {
    constructor() {
      mockOrder.push('context');
    }
    resume() {
      return Promise.resolve(true);
    }
  },
  AudioManager: {
    observeAudioInterruptions: jest.fn(),
    getDevicesInfo: jest.fn(() => Promise.resolve({ currentInputs: [{ name: 'iPhone Microphone', category: 'MicrophoneBuiltIn' }] })),
    setAudioSessionActivity: (on: boolean) => mockActivity(on),
    addSystemEventListener: (name: string, cb: (e: { type?: string; reason?: string }) => void) => {
      mockSystem[name] = cb;
      return { remove: jest.fn() };
    },
  },
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let renderer!: TestRenderer.ReactTestRenderer;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <LiveSurface threadId="th-1" />
      </SafeAreaProvider>,
    );
  });
  await flush();
}

async function tapStage(): Promise<void> {
  const stage = renderer.root.findByProps({ testID: 'live-stage' });
  await act(async () => stage.props.onPress());
  await flush();
}

async function emit(frame: LiveServerFrame): Promise<void> {
  await act(async () => mockConnectOpts!.onFrame(frame));
}

function flat(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(flat).join('');
  const props = (c as { props?: { children?: unknown } } | null)?.props;
  return props ? flat(props.children) : '';
}
const text = (id: string): string => {
  const node = renderer.root.findAll((n) => n.props.testID === id && n.type === Text)[0];
  return node ? flat(node.props.children) : '';
};
const press = async (id: string): Promise<void> => {
  const node = renderer.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === 'function')[0];
  await act(async () => node.props.onPress());
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConnectOpts = null;
  mockNative.mod = null;
  mockMicLive = 0;
  mockMicMax = 0;
  mockMicGate = null;
  mockConfigureGate = null;
  mockClock.played = 0;
  mockClock.received = 0;
  mockClock.complete = false;
  useVoiceSettings.setState({ settings: DEFAULT_VOICE_SETTINGS, hydrated: true, hydrating: false });
  useChatStore.getState().reset();
});

const ISO = '2026-01-01T09:00:00Z';
function hydrate(title: string, texts: [string, 'user' | 'assistant'][]): void {
  useChatStore.getState().hydrateSnapshot(
    {
      id: 'th-1', kind: 'chat', title, status: 'idle', pinned: true, archived: false, last_seq: texts.length,
      created_at: ISO, updated_at: ISO, last_read_seq: 0, unread: 0, preview: null, preview_role: null,
      hermes_session_id: null, origin_thread_id: null, origin_message_id: null,
    } as never,
    texts.map(([text, role], i) => ({
      id: `m${i}`, thread_id: 'th-1', seq: i + 1, role, author_type: role === 'user' ? 'human' : 'agent',
      status: 'complete', parts: [{ type: 'text', text }], created_at: ISO, updated_at: ISO,
    })) as never,
  );
}
afterEach(() => {
  act(() => renderer?.unmount());
});

test('helpers', () => {
  expect(formatElapsed(61)).toBe('1:01');
  expect(formatElapsed(-4)).toBe('0:00');
  expect(phaseHint('speaking', false, false)).toBe('tap to cut in');
  expect(phaseHint('listening', true, false)).toBe('muted');
  expect(phaseHint('listening', false, true)).toBe('on hold for a call');
});

test('tapping the dots starts a session on this thread with the saved voice', async () => {
  await mount();
  expect(text('live-state')).toBe('Live');
  await tapStage();
  expect(mockConnectOpts?.threadId).toBe('th-1');
  expect(mockConnectOpts?.aec).toBe(false);
  expect(mockConnectOpts?.tts.voice).toBe(DEFAULT_VOICE_SETTINGS.tts.voice);
  expect(text('live-state')).toBe('Listening');
});

test('state frames drive the state word; heard shows what was said', async () => {
  await mount();
  await tapStage();
  await emit({ type: 'heard', text: "what's on my", final: false });
  expect(text('live-you')).toBe("what's on my…");
  await emit({ type: 'heard', text: "what's on my calendar", final: true });
  expect(text('live-you')).toBe("what's on my calendar");
  await emit({ type: 'state', value: 'thinking' });
  expect(text('live-state')).toBe('Thinking');
});

test('a spoken turn flows into the player and its captions', async () => {
  await mount();
  await tapStage();
  const pcm = new ArrayBuffer(8);
  await emit({ type: 'speak_start', turn_id: 3 });
  await emit({ type: 'caption', turn_id: 3, text: 'Five things' });
  await emit({ type: 'audio', data: pcm });
  await emit({ type: 'caption', turn_id: 3, text: ' tomorrow.' });
  await emit({ type: 'speak_end', turn_id: 3 });
  await emit({ type: 'state', value: 'speaking' });
  expect(mockPlayer.start).toHaveBeenCalledWith(3);
  expect(mockPlayer.push).toHaveBeenCalledWith(pcm);
  expect(mockPlayer.end).toHaveBeenCalled();
  expect(text('live-reply')).toBe('Five things tomorrow.');
  act(() => mockPlayerCb!.onProgress(3, 420));
  act(() => mockPlayerCb!.onDrained(3));
  expect(mockClient.playback).toHaveBeenCalledWith(3, 420);
  expect(mockClient.drained).toHaveBeenCalledWith(3);
});

test('a caption for an old turn is ignored', async () => {
  await mount();
  await tapStage();
  await emit({ type: 'state', value: 'speaking' });
  await emit({ type: 'speak_start', turn_id: 4 });
  await emit({ type: 'caption', turn_id: 3, text: 'stale' });
  await emit({ type: 'caption', turn_id: 4, text: 'Fresh.' });
  expect(text('live-reply')).toBe('Fresh.');
});

test('cancel, duck and unduck reach the player', async () => {
  await mount();
  await tapStage();
  await emit({ type: 'state', value: 'speaking' });
  await emit({ type: 'speak_start', turn_id: 2 });
  await emit({ type: 'caption', turn_id: 2, text: 'Five things tomorrow.' });
  await emit({ type: 'duck' });
  await emit({ type: 'unduck' });
  await emit({ type: 'cancel', turn_id: 2 });
  expect(mockPlayer.duck.mock.calls).toEqual([[true], [false]]);
  expect(mockPlayer.cancel).toHaveBeenCalledWith(2);
  expect(text('live-reply')).toContain('—');
});

test('a tap while Xavier speaks cuts him off', async () => {
  await mount();
  await tapStage();
  await emit({ type: 'state', value: 'speaking' });
  await tapStage();
  expect(mockClient.interrupt).toHaveBeenCalled();
  expect(mockPlayer.cancel).toHaveBeenCalled();
  expect(text('live-state')).toBe('Listening');
});

test('reconnecting shows the banner until the server is back', async () => {
  await mount();
  await tapStage();
  await act(async () => mockConnectOpts!.onStatus('reconnecting'));
  expect(renderer.root.findAll((n) => n.props.testID === 'live-reconnecting').length).toBeGreaterThan(0);
  await emit({ type: 'state', value: 'listening' });
  expect(renderer.root.findAll((n) => n.props.testID === 'live-reconnecting').length).toBe(0);
});

test('mute sends silence instead of the mic', async () => {
  await mount();
  await tapStage();
  const voice = new Int16Array([1000, -1000]).buffer;
  act(() => mockMicFrame!(voice, 0.4));
  expect(mockClient.sendAudio).toHaveBeenLastCalledWith(voice);
  await press('live-mute');
  act(() => mockMicFrame!(voice, 0.4));
  const sent = mockClient.sendAudio.mock.calls.at(-1)![0] as ArrayBuffer;
  expect(sent.byteLength).toBe(4);
  expect(Array.from(new Int16Array(sent))).toEqual([0, 0]);
  expect(text('live-state')).toBe('Listening');
});

test('going to the background keeps the session alive', async () => {
  const spy = jest.spyOn(AppState, 'addEventListener');
  await mount();
  await tapStage();
  for (const [, cb] of spy.mock.calls) act(() => (cb as (s: string) => void)('background'));
  expect(mockClient.stop).not.toHaveBeenCalled();
  expect(mockMicStop).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('a phone call holds the session and resumes after', async () => {
  await mount();
  await tapStage();
  act(() => mockSystem.interruption({ type: 'began' }));
  expect(mockClient.hold).toHaveBeenCalled();
  expect(mockClient.interrupt).not.toHaveBeenCalled();
  expect(mockPlayer.cancel).toHaveBeenCalled();
  expect(text('live-state')).toBe('On hold');
  await act(async () => mockSystem.interruption({ type: 'ended' }));
  await flush();
  expect(text('live-state')).not.toBe('On hold');
});

test('End stops the client and the mic; ended from the server does too', async () => {
  await mount();
  await tapStage();
  await press('live-end');
  expect(mockClient.stop).toHaveBeenCalled();
  expect(mockMicStop).toHaveBeenCalled();
  expect(text('live-state')).toBe('Live');
  await tapStage();
  mockClient.stop.mockClear();
  await emit({ type: 'ended', reason: 'idle' });
  expect(mockClient.stop).toHaveBeenCalled();
  expect(text('live-state')).toBe('Live');
});

test('leaving the page ends the session', async () => {
  await mount();
  await tapStage();
  act(() => renderer.unmount());
  expect(mockClient.stop).toHaveBeenCalled();
  renderer = TestRenderer.create(<></>);
});

test('the thread history is on the page and the title names the session', async () => {
  hydrate('Live · what is on my calendar tomorrow', [
    ["what's on my calendar tomorrow", 'user'],
    ['Five things tomorrow.', 'assistant'],
  ]);
  await mount();
  expect(text('bubble-m0')).toBe("what's on my calendar tomorrow");
  expect(text('bubble-m1')).toBe('Five things tomorrow.');
  expect(text('live-subtitle')).toBe('what is on my calendar tomorrow');
});

test('gateway busy notices stay out of the Live transcript', async () => {
  hydrate('Live', [
    ['stop, check my email instead', 'user'],
    ['↪ Redirected current run (iteration 2/60, running: web_search). I\'ll adjust using your correction.', 'assistant'],
    ['Three new emails.', 'assistant'],
  ]);
  await mount();
  expect(renderer.root.findAll((n) => n.props.testID === 'bubble-m1').length).toBe(0);
  expect(text('bubble-m2')).toBe('Three new emails.');
});

test('scrolled back, new messages offer a jump to now instead of yanking the view', async () => {
  hydrate('Live', [['one', 'user']]);
  await mount();
  const list = renderer.root.findByProps({ testID: 'live-transcript' });
  act(() =>
    list.props.onScroll({
      nativeEvent: { contentOffset: { y: 0 }, layoutMeasurement: { height: 300 }, contentSize: { height: 1200 } },
    }),
  );
  act(() => list.props.onContentSizeChange(0, 1400));
  expect(renderer.root.findAll((n) => n.props.testID === 'live-jump').length).toBeGreaterThan(0);
  await press('live-jump');
  expect(renderer.root.findAll((n) => n.props.testID === 'live-jump').length).toBe(0);
  expect(renderer.root.findAll((n) => n.props.testID === 'live-subtitle').length).toBe(0);
});

test('End while the mic is still starting leaves no recorder running', async () => {
  let release!: () => void;
  mockMicGate = new Promise<void>((r) => {
    release = r;
  });
  await mount();
  const stage = renderer.root.findByProps({ testID: 'live-stage' });
  await act(async () => {
    stage.props.onPress();
  });
  await press('live-end');
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(mockMicLive).toBe(0);
});

test('a call ending and a route change at once never run two recorders', async () => {
  await mount();
  await tapStage();
  await act(async () => {
    mockSystem.interruption({ type: 'ended' });
    mockSystem.routeChange({ reason: 'NewDeviceAvailable' });
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(mockMicMax).toBe(1);
  expect(mockMicLive).toBe(1);
});

test('End releases the audio session', async () => {
  await mount();
  await tapStage();
  mockActivity.mockClear();
  await press('live-end');
  expect(mockActivity).not.toHaveBeenCalled();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  expect(mockActivity).toHaveBeenCalledWith(false);
});

test('the caption highlight follows the audio actually played', async () => {
  await mount();
  await tapStage();
  await emit({ type: 'state', value: 'speaking' });
  await emit({ type: 'speak_start', turn_id: 1 });
  await emit({ type: 'caption', turn_id: 1, text: 'Five things tomorrow.' });
  await emit({ type: 'speak_end', turn_id: 1 });
  mockClock.received = 2000;
  mockClock.complete = true;
  mockClock.played = 1100; // 55% of the real audio, whatever the text length
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
  const reply = renderer.root.findAll((n) => n.props.testID === 'live-reply' && n.type === Text)[0];
  const heard = typeof reply.props.children[0] === 'string' ? reply.props.children[0] : '';
  expect(heard.trim()).toBe('Five things');
});

test('a working tone starts soon after Xavier goes quiet to think, then repeats', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { playEarcon } = require('../../lib/live/earcons') as { playEarcon: jest.Mock };
  await mount();
  await tapStage();
  playEarcon.mockClear();
  await emit({ type: 'state', value: 'thinking' });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1300));
  });
  expect(playEarcon.mock.calls.filter((c) => c[1] === 'working').length).toBe(1);
});

test('the mic attaches before anything plays (its input is set up on an idle engine)', async () => {
  mockOrder.length = 0;
  await mount();
  await tapStage();
  expect(mockOrder.indexOf('mic')).toBeGreaterThanOrEqual(0);
  expect(mockOrder.indexOf('mic')).toBeLessThan(mockOrder.indexOf('context') === -1 ? Infinity : mockOrder.indexOf('context'));
});

test('mic errors reach the server log', async () => {
  await mount();
  await tapStage();
  act(() => mockMicError!('input format changed'));
  expect(mockClient.diag).toHaveBeenCalledWith(expect.stringContaining('input format changed'));
});

test('the watchdog restarts a silent mic once, then gives up with a message instead of thrashing', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startMic } = require('../../lib/live/mic') as { startMic: jest.Mock };
  await mount();
  await tapStage();
  startMic.mockClear();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 7500));
  });
  expect(startMic).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAll((n) => typeof n.props.text === 'string' && /isn't sending audio/.test(n.props.text)).length).toBeGreaterThan(0);
}, 15000);

test('a silent mic is restarted by the watchdog', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startMic } = require('../../lib/live/mic') as { startMic: jest.Mock };
  await mount();
  await tapStage();
  startMic.mockClear();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 3200));
  });
  expect(startMic).toHaveBeenCalled();
  expect(mockClient.diag).toHaveBeenCalledWith(expect.stringContaining('watchdog'));
});

test('route changes and mic state reach the server log', async () => {
  await mount();
  await tapStage();
  await flush();
  // The input's kind, never its name: a Bluetooth device is often named after its owner.
  expect(mockClient.diag).toHaveBeenCalledWith(expect.stringMatching(/mic started: recording=true input=MicrophoneBuiltIn/));
  expect(mockClient.diag).not.toHaveBeenCalledWith(expect.stringContaining('iPhone Microphone'));
  act(() => mockSystem.routeChange({ reason: 'ConfigurationChange' }));
  expect(mockClient.diag).toHaveBeenCalledWith('route change: ConfigurationChange');
});

describe('on the native voice-processing engine', () => {
  const b64 = (n: number) => Buffer.from(new Uint8Array(n)).toString('base64');

  test('starts with echo cancellation at 24 kHz and never loads react-native-audio-api', async () => {
    mockNative.mod = fakeNative();
    mockOrder.length = 0;
    await mount();
    await tapStage();
    expect(mockConnectOpts?.aec).toBe(true);
    expect(mockConnectOpts?.micRate).toBe(24000);
    expect(mockOrder).toEqual([]);
    expect(mockNative.mod.playTone).toHaveBeenCalledTimes(1);
    expect(mockClient.diag).toHaveBeenCalledWith(expect.stringMatching(/^native audio: voiceProcessing=true/));
    act(() => mockNative.mod!.fire('onFrame', { pcm: b64(3840), level: 0.1 }));
    expect(mockClient.sendAudio).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect((mockClient.sendAudio.mock.calls[0][0] as ArrayBuffer).byteLength).toBe(3840);
    expect(text('live-state')).toBe('Listening');
  });

  test('a reply plays through the engine and reports what was heard', async () => {
    mockNative.mod = fakeNative();
    await mount();
    await tapStage();
    await emit({ type: 'speak_start', turn_id: 2 });
    await emit({ type: 'audio', data: new ArrayBuffer(48 * 300) });
    await emit({ type: 'speak_end', turn_id: 2 });
    expect(mockNative.mod.enqueue).toHaveBeenCalledTimes(1);
    const tag = mockNative.mod.enqueue.mock.calls[0][1];
    act(() => mockNative.mod!.fire('onPlayed', { tag, ms: 300 }));
    expect(mockClient.playback).toHaveBeenCalledWith(2, 300);
    expect(mockClient.drained).toHaveBeenCalledWith(2);
  });

  test('a call holds the session; native diagnostics reach the server log', async () => {
    mockNative.mod = fakeNative();
    await mount();
    await tapStage();
    act(() =>
      mockNative.mod!.fire('onDiag', {
        message: 'engine configuration change (running=false)',
      }),
    );
    expect(mockClient.diag).toHaveBeenCalledWith('engine configuration change (running=false)');
    act(() => mockNative.mod!.fire('onInterruption', { type: 'began' }));
    expect(mockClient.hold).toHaveBeenCalled();
    act(() => mockNative.mod!.fire('onInterruption', { type: 'ended' }));
  });

  test('ending stops the native engine, not the library session', async () => {
    mockNative.mod = fakeNative();
    await mount();
    await tapStage();
    mockActivity.mockClear();
    await press('live-end');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(mockNative.mod.stop).toHaveBeenCalled();
    expect(mockActivity).not.toHaveBeenCalled();
  });

  test('a session that ends while the engine is starting leaves no mic running', async () => {
    mockNative.mod = fakeNative();
    let finishStart!: () => void;
    mockNative.mod.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = () =>
            resolve({ voiceProcessing: true, inputFormat: 'mono 24k', route: 'iPhone Microphone', sampleRate: 24000 });
        }),
    );
    await mount();
    const stage = renderer.root.findByProps({ testID: 'live-stage' });
    await act(async () => {
      stage.props.onPress();
    });
    // The server refuses before the engine is up (no key, say)…
    await emit({ type: 'ended', reason: 'unconfigured' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const stopsAtEnd = mockNative.mod.stop.mock.calls.length;
    // …and the engine finishes starting afterwards: it is stopped again.
    await act(async () => {
      finishStart();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockNative.mod.stop.mock.calls.length).toBe(stopsAtEnd + 1);
    expect(text('live-state')).toBe('Live');
  });

  test('no mic permission: Live does not start', async () => {
    mockNative.mod = fakeNative();
    mockNative.mod.requestPermission.mockResolvedValueOnce(false);
    await mount();
    await tapStage();
    expect(mockNative.mod.start).not.toHaveBeenCalled();
    expect(text('live-state')).toBe('Live');
  });
});

describe('when Live cannot run', () => {
  test('a server with no Deepgram key says so and stays usable', async () => {
    await mount();
    await tapStage();
    await emit({ type: 'error', message: 'Live voice needs DEEPGRAM_API_KEY on the server' });
    await emit({ type: 'ended', reason: 'unconfigured' });
    expect(text('live-state')).toBe('Live');
    expect(mockClient.stop).toHaveBeenCalled();
    const banner = renderer.root.findAll((n) => n.props.testID === 'live-unavailable' && n.props.accessibilityRole === 'alert');
    expect(banner.length).toBeGreaterThan(0);
    expect(flat(banner[0].props.children)).toContain('DEEPGRAM_API_KEY');
    // The next start clears it (the server may have been configured since).
    await tapStage();
    expect(renderer.root.findAll((n) => n.props.testID === 'live-unavailable').length).toBe(0);
    expect(text('live-state')).toBe('Listening');
  });

  test('each ended reason gets its own words', async () => {
    await mount();
    await tapStage();
    await emit({ type: 'ended', reason: 'unavailable' });
    const toast = () => renderer.root.findAll((n) => typeof n.props.text === 'string' && n.props.kind === 'err');
    expect(toast()[0].props.text).toMatch(/speech service/);
    await tapStage();
    await emit({ type: 'ended', reason: 'idle' });
    expect(toast()[0].props.text).toMatch(/quiet minutes/);
    expect(renderer.root.findAll((n) => n.props.testID === 'live-unavailable').length).toBe(0);
  });

  test('a refused session (1008) ends Live and asks for Face ID again', async () => {
    const original = useChatLock.getState().lock;
    const lock = jest.fn(async () => {});
    useChatLock.setState({ lock });
    try {
      await mount();
      await tapStage();
      await act(async () => mockConnectOpts!.onStatus('locked'));
      expect(lock).toHaveBeenCalledTimes(1);
      expect(mockClient.stop).toHaveBeenCalled();
      expect(text('live-state')).toBe('Live');
    } finally {
      useChatLock.setState({ lock: original });
    }
  });
});

describe('notices, refusals and holds', () => {
  test('a notice from the server is shown', async () => {
    await mount();
    await tapStage();
    await emit({ type: 'notice', message: "Xavier didn't get that (gateway unreachable). It is saved in the thread." });
    const toast = renderer.root.findAll((n) => n.props.kind === 'err' && typeof n.props.text === 'string');
    expect(toast[0].props.text).toMatch(/gateway unreachable/);
    expect(text('live-state')).toBe('Listening');
  });

  test('a refused Origin ends Live without locking chat', async () => {
    const original = useChatLock.getState().lock;
    const lock = jest.fn(async () => {});
    useChatLock.setState({ lock });
    try {
      await mount();
      await tapStage();
      await act(async () => mockConnectOpts!.onStatus('refused'));
      expect(lock).not.toHaveBeenCalled();
      expect(mockClient.stop).toHaveBeenCalled();
      expect(text('live-state')).toBe('Live');
      const toast = renderer.root.findAll((n) => n.props.kind === 'err' && typeof n.props.text === 'string');
      expect(toast[0].props.text).toMatch(/HUB_ORIGIN/);
    } finally {
      useChatLock.setState({ lock: original });
    }
  });

  test('a silent mic on hold is expected: no watchdog restart, no warning', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startMic } = require('../../lib/live/mic') as { startMic: jest.Mock };
    await mount();
    await tapStage();
    act(() => mockSystem.interruption({ type: 'began' }));
    startMic.mockClear();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3200));
    });
    expect(startMic).not.toHaveBeenCalled();
    expect(renderer.root.findAll((n) => typeof n.props.text === 'string' && /isn't sending audio/.test(n.props.text)).length).toBe(0);
    expect(text('live-state')).toBe('On hold');
  });

  test('ending during a hold leaves the page off, not on hold', async () => {
    await mount();
    await tapStage();
    act(() => mockSystem.interruption({ type: 'began' }));
    await press('live-end');
    expect(text('live-state')).toBe('Live');
  });

  test('End during the permission prompt still hands the audio session back', async () => {
    let allow!: () => void;
    mockConfigureGate = new Promise<void>((r) => {
      allow = r;
    });
    await mount();
    const stage = renderer.root.findByProps({ testID: 'live-stage' });
    await act(async () => {
      stage.props.onPress();
    });
    await press('live-end');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    mockActivity.mockClear();
    await act(async () => {
      allow();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockActivity).toHaveBeenCalledWith(false);
    expect(mockConnectOpts).toBeNull();
  });
});
