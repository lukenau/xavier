// The /api/live wire protocol (server/live_session.py). Binary frames are TTS
// audio (24 kHz mono s16le) and belong to the turn named by the last
// `speak_start`; everything else is JSON.

export type LiveState = 'listening' | 'thinking' | 'speaking' | 'reconnecting';

export interface LiveTts {
  voice: string;
  speed: number;
  expressivity: number;
  enabled: boolean;
}

export type LiveServerFrame =
  | { type: 'ready'; session: string }
  | { type: 'state'; value: LiveState }
  | { type: 'heard'; text: string; final: boolean }
  | { type: 'turn'; message_id: string; seq: number }
  | { type: 'speak_start'; turn_id: number }
  | { type: 'speak_end'; turn_id: number }
  | { type: 'caption'; turn_id: number; text: string }
  | { type: 'cancel'; turn_id: number }
  | { type: 'duck' }
  | { type: 'unduck' }
  | { type: 'ended'; reason: string }
  | { type: 'notice'; message: string }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'audio'; data: ArrayBuffer };

const STATES: readonly string[] = ['listening', 'thinking', 'speaking', 'reconnecting'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** One server frame, or null for anything malformed or unknown. */
export function parseLiveFrame(raw: string | ArrayBuffer): LiveServerFrame | null {
  if (raw instanceof ArrayBuffer) return { type: 'audio', data: raw };
  let f: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    f = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (f.type) {
    case 'ready':
      return isStr(f.session) ? { type: 'ready', session: f.session } : null;
    case 'state':
      return isStr(f.value) && STATES.includes(f.value) ? { type: 'state', value: f.value as LiveState } : null;
    case 'heard':
      return isStr(f.text) && typeof f.final === 'boolean' ? { type: 'heard', text: f.text, final: f.final } : null;
    case 'turn':
      return isStr(f.message_id) && isNum(f.seq) ? { type: 'turn', message_id: f.message_id, seq: f.seq } : null;
    case 'speak_start':
    case 'speak_end':
    case 'cancel':
      return isNum(f.turn_id) ? { type: f.type, turn_id: f.turn_id } : null;
    case 'caption':
      return isNum(f.turn_id) && isStr(f.text) ? { type: 'caption', turn_id: f.turn_id, text: f.text } : null;
    case 'duck':
    case 'unduck':
    case 'pong':
      return { type: f.type };
    case 'ended':
      return { type: 'ended', reason: isStr(f.reason) ? f.reason : '' };
    case 'notice':
      return isStr(f.message) ? { type: 'notice', message: f.message } : null;
    case 'error':
      return isStr(f.message) ? { type: 'error', message: f.message } : null;
    default:
      return null;
  }
}

export function helloFrame(threadId: string, aec: boolean, tts: LiveTts, resumeSeq?: number, micRate?: number): string {
  return JSON.stringify({
    type: 'hello',
    thread_id: threadId,
    aec,
    tts,
    ...(micRate === undefined ? {} : { mic_rate: micRate }),
    ...(resumeSeq === undefined ? {} : { resume_seq: resumeSeq }),
  });
}
