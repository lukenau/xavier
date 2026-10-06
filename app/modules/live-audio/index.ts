// Live's full-duplex audio engine (ios/LiveAudioModule.swift): Apple voice
// processing on one AVAudioEngine. PCM crosses as base64 16-bit, 24 kHz mono.
import { requireOptionalNativeModule } from 'expo';

export type LiveAudioEvents = {
  onFrame(e: { pcm: string; level: number }): void;
  onPlayed(e: { tag: number; ms: number }): void;
  onDiag(e: { message: string }): void;
  onInterruption(e: { type: 'began' | 'ended' }): void;
};

export interface LiveAudioStart {
  voiceProcessing: boolean;
  inputFormat: string;
  route: string;
  sampleRate: number;
  /** iOS's active Mic Mode; absent from a build whose module predates it. */
  micMode?: string;
}

export interface LiveAudioNative {
  addListener<K extends keyof LiveAudioEvents>(name: K, listener: LiveAudioEvents[K]): { remove(): void };
  requestPermission(): Promise<boolean>;
  start(): Promise<LiveAudioStart>;
  stop(): Promise<void>;
  enqueue(pcmBase64: string, tag: number): void;
  playTone(pcmBase64: string): void;
  clear(): void;
  setDucked(ducked: boolean): void;
  /** Opens iOS's Mic Mode picker (Voice Isolation); absent from a build whose
   * module predates it. */
  showMicModes?: () => void;
}

/** null on a build without the module (and on web, and under jest). */
export const LiveAudio = requireOptionalNativeModule<LiveAudioNative>('LiveAudio');
