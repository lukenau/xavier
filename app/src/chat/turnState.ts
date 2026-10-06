// Is the box doing anything? Read off the transcript, not off a server field.
//
// `thread.status` exists on the wire but nothing sets it, so the Stop button
// never appeared and there was no way to tell "not reacting" from "working
// quietly" (the user, 2026-09-22). These three states are all derivable from what
// has already arrived:
//
//   working     — either something is streaming, OR hub-api has handed the
//                 message to the gateway (`forward_status: 'forwarded'`). The
//                 second case is the point: the box is already thinking, and
//                 waiting for the first token to say so left a grey dot up for
//                 seconds while work was happening (the user, 2026-09-22).
//   waiting     — sent, but not yet acknowledged: the POST is still in flight,
//                 or the row predates forward_status.
//   undelivered — hub-api could NOT hand it on. This is the case a
//                 transcript-only guess gets wrong: it would spin forever on a
//                 message the agent never saw. The server knows; this asks.
//   idle        — the last word was the agent's.
import type { ChatMessage } from './types';

export type TurnState = 'idle' | 'waiting' | 'working' | 'undelivered';

/** A turn that ends without a final reply — interrupted, steered away from, or
 * one the gateway died in — leaves its streamed rows `streaming` for good, and
 * the ring spun until the user sent something else ("the working animation doesn't
 * seem to be clearing at the end of message send from agent", 2026-09-22). A
 * live turn touches one of its rows far more often than this; a run whose
 * newest row has not moved in three minutes is over, whatever the row says. */
export const STALE_RUN_MS = 3 * 60 * 1000;

function movedRecently(messages: ChatMessage[], now: number): boolean {
  return messages.some((m) => now - Date.parse(m.updated_at) < STALE_RUN_MS);
}

export function turnStateOf(
  messages: ChatMessage[],
  now: number = Date.now(),
  /** `thread.status`, which hub-api now sets for the whole turn (store.py
   * `begin_run`/`end_run`). A row belongs to one LLM stream and a turn has one
   * per tool round, so between rounds nothing is streaming — 48 seconds of it
   * on one of the user's turns — and reading the rows alone said idle mid-turn
   * ("working animation seems to disappear when it goes from tool back to
   * thinking", 2026-09-30). The rows still have the last word on staleness: a
   * gateway that dies leaves the flag set, and `movedRecently` retires it. */
  threadStatus?: string | null,
): TurnState {
  if (messages.length === 0) return threadStatus === 'running' ? 'working' : 'idle';
  const last = messages[messages.length - 1];
  if (threadStatus === 'running' && movedRecently(messages, now)) return 'working';
  // Only the newest run's streaming counts. A turn the gateway died in leaves
  // its row `streaming` for good, and scanning every row pinned the ring, Stop
  // and CommandSheet's gate to "working" days later (2026-09-22). Rows are
  // ascending by seq and a `/send` row has no run_id (chat/routes.py), so the
  // tail's run_id IS the newest run, and null means nothing has started since
  // the user's send. Grouped by run, not "tail row only": store.py keeps a run's
  // streaming prose row at its own seq while that run's tool cards land above it.
  const newestRun = messages.filter((m) => (last.run_id === null ? m === last : m.run_id === last.run_id));
  if (newestRun.some((m) => m.status === 'streaming') && movedRecently(newestRun, now)) return 'working';
  if (last.role !== 'user') return 'idle';
  if (last.forward_status === 'pending') return 'undelivered';
  if (last.forward_status === 'forwarded') return 'working';
  return 'waiting';
}
