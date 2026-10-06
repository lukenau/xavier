// Every row's interaction state, and the three writes behind it.
//
// The state machine (spec §8.1), per row:
//
//   idle ──swipe──▶ open ──tap Done──▶ armed ──tap Done──▶ undo ──6s──▶ gone
//     ▲              │                  │                    │
//     │              └──tap Snooze──────┼───────────────────▶│
//     └──close / scroll / 3s timeout────┘                    └──tap Undo──▶ idle
//                                                            └──403/503──▶ idle + reason
//
// A full swipe ARMS Done, it never commits (Ruling 61, superseding
// task-11-brief's "full-swipe commits"). Snooze is single-tap because it
// expires; Done is two-tap because it does not.
//
// Commit is optimistic: the row's slot becomes an UndoRow at once and the
// request reconciles behind it. A failure puts the row back with a reason —
// 403 and 503 say different things, and neither is "something went wrong".
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { ApiError, api } from '../../lib/api';
import {
  canWrite,
  failureKind,
  untilLabel,
  writeFailureCopy,
  type Brief,
  type BriefAction,
  type BriefItem,
  type BriefReason,
  type SnoozeSpan,
} from './briefModel';

export type RowPhase = 'idle' | 'open' | 'armed' | 'undo';

export interface RowState {
  phase: RowPhase;
  /** One line under the title after a failed action. */
  failure: string | null;
  /** 'Done · Pick up Rx' / 'Snoozed to tomorrow (Thu)'. */
  undoLabel: string;
  /** Which write put the row in `undo` — UndoRow's reason chips (Ruling 146)
   * only make sense after a Done; a snooze is "not now", not "not mine". */
  action: 'dismiss' | 'snooze' | null;
  /** Set once `explain()` lands — UndoRow shows "Noted" and drops the chips. */
  explained: boolean;
}

const IDLE: RowState = {
  phase: 'idle', failure: null, undoLabel: '', action: null, explained: false,
};

/** How long an armed Done stays armed before disarming itself. */
export const ARM_TIMEOUT_MS = 3000;
/** How long the undo line holds the row's slot. */
export const UNDO_WINDOW_MS = 6000;

/** Rotor entries. Without these the swipe actions are unreachable with
 * VoiceOver on — the gesture has no accessible equivalent (spec §10). */
export const ROTOR_ACTIONS = [
  { name: 'done', label: 'Mark done' },
  { name: 'snooze', label: 'Snooze' },
  { name: 'useful', label: 'Mark useful' },
] as const;

/** Rotor entries for a row sitting in its post-Done undo slot (Ruling 146):
 * the same three "why" chips UndoRow offers on screen, so VoiceOver can
 * reach them without a swipe. */
export const REASON_ROTOR_ACTIONS = [
  { name: 'reason:not-mine', label: 'Not mine' },
  { name: 'reason:done', label: 'Already done' },
  { name: 'reason:noise', label: 'Not important' },
] as const;

/** One line for the undo slot. Title is trimmed because the slot is one row. */
function doneLabel(item: BriefItem): string {
  return `Done · ${item.title}`;
}

function snoozedLabel(span: SnoozeSpan, until?: string): string {
  return `Snoozed to ${untilLabel(until, span)}`;
}

export interface UseBriefActions {
  rowState: (itemId: string) => RowState;
  openRail: (itemId: string) => void;
  closeRail: (itemId: string) => void;
  armDone: (itemId: string) => void;
  disarmAll: () => void;
  /** The arm haptic, fired once per threshold crossing by the gesture. */
  onArmThreshold: () => void;
  dismiss: (item: BriefItem) => void;
  snooze: (item: BriefItem, span: SnoozeSpan) => void;
  undo: (item: BriefItem) => void;
  markUseful: (item: BriefItem) => Promise<boolean>;
  /** The undo-slot "why" chip (Ruling 146): tells triage what a Done meant,
   * in the pipeline's own words. Optimistic — the chips become "Noted" at
   * once and revert if the post fails. */
  explain: (item: BriefItem, code: BriefReason) => void;
  /** "Tell the brief about this" (Ruling 146) — a one-line note on a past
   * item. Not optimistic, same posture as markUseful: the sheet shows the
   * result only after the write settles. */
  noteItem: (item: BriefItem, note: string) => Promise<boolean>;
  rotorActions: (item: BriefItem) => { name: string; label: string }[];
  onRotorAction: (item: BriefItem, action: string, onOpen: () => void) => void;
}

export function useBriefActions({
  brief,
  onSettled,
}: {
  brief: Brief | undefined;
  onSettled: () => void;
}): UseBriefActions {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // The brief's own date, not today's: the token is an HMAC over
  // `${date}:${item_id}` minted by the generator, so a served-from-yesterday
  // brief must be dismissed AS yesterday or every write 403s.
  const date = brief?.date ?? '';

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  useEffect(
    () => () => {
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
      timers.current = {};
    },
    [],
  );

  const setRow = useCallback((id: string, next: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? IDLE), ...next } }));
  }, []);

  const rowState = useCallback((id: string) => rows[id] ?? IDLE, [rows]);

  const disarmAll = useCallback(() => {
    setRows((prev) => {
      let changed = false;
      const next: Record<string, RowState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (state.phase === 'armed' || state.phase === 'open') {
          changed = true;
          clearTimer(id);
          next[id] = { ...state, phase: 'idle' };
        } else {
          next[id] = state;
        }
      }
      return changed ? next : prev;
    });
  }, [clearTimer]);

  const openRail = useCallback(
    (id: string) => {
      // Interacting with one row closes every other: two open rails is a state
      // nobody asked for and makes the 3s disarm ambiguous.
      disarmAll();
      setRow(id, { phase: 'open', failure: null });
    },
    [disarmAll, setRow],
  );

  const closeRail = useCallback(
    (id: string) => {
      clearTimer(id);
      setRow(id, { phase: 'idle' });
    },
    [clearTimer, setRow],
  );

  const armDone = useCallback(
    (id: string) => {
      clearTimer(id);
      setRow(id, { phase: 'armed' });
      void Haptics.selectionAsync();
      timers.current[id] = setTimeout(() => {
        delete timers.current[id];
        setRow(id, { phase: 'open' });
      }, ARM_TIMEOUT_MS);
    },
    [clearTimer, setRow],
  );

  const onArmThreshold = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  /** The shared optimistic body: take the slot, then reconcile. */
  const commit = useCallback(
    (
      item: BriefItem,
      action: BriefAction,
      label: string,
      rowAction: 'dismiss' | 'snooze',
      onOk?: (until?: string) => void,
    ) => {
      const id = item.item_id;
      clearTimer(id);
      if (!canWrite(item)) {
        // A brief minted before the generator emitted tokens. Posting would be
        // a guaranteed 403, so the row stays and says why.
        setRow(id, { phase: 'idle', failure: writeFailureCopy('untokened') });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setRow(id, {
        phase: 'undo', failure: null, undoLabel: label, action: rowAction, explained: false,
      });
      api
        .dismissBriefItem(id, action, item.token as string, date)
        .then((result) => {
          onOk?.(result.until);
          // The row's slot is released only after the undo window — until then
          // it is still on screen, holding its place.
          timers.current[id] = setTimeout(() => {
            delete timers.current[id];
            setRows((prev) => {
              const { [id]: _gone, ...rest } = prev;
              return rest;
            });
            onSettled();
          }, UNDO_WINDOW_MS);
        })
        .catch((err: unknown) => {
          const status = err instanceof ApiError ? err.status : undefined;
          setRow(id, { phase: 'idle', failure: writeFailureCopy(failureKind(status)) });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        });
    },
    [clearTimer, date, onSettled, setRow],
  );

  const dismiss = useCallback(
    (item: BriefItem) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      commit(item, 'dismiss', doneLabel(item), 'dismiss');
    },
    [commit],
  );

  const snooze = useCallback(
    (item: BriefItem, span: SnoozeSpan) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      commit(item, `snooze:${span}` as BriefAction, snoozedLabel(span), 'snooze', (until) => {
        // The server knows the real return date; the local computation was only
        // the optimistic stand-in.
        setRow(item.item_id, { undoLabel: snoozedLabel(span, until) });
      });
    },
    [commit, setRow],
  );

  const explain = useCallback(
    (item: BriefItem, code: BriefReason) => {
      const id = item.item_id;
      if (!canWrite(item)) return;
      void Haptics.selectionAsync();
      // Optimistic, same posture as commit(): the chips become "Noted" at
      // once, and a failure simply reverts — this is a secondary signal on a
      // row that has already committed, never a blocking write.
      setRow(id, { explained: true });
      api
        .dismissBriefItem(id, `reason:${code}`, item.token as string, date)
        .catch(() => setRow(id, { explained: false }));
    },
    [date, setRow],
  );

  const undo = useCallback(
    (item: BriefItem) => {
      const id = item.item_id;
      clearTimer(id);
      void Haptics.selectionAsync();
      setRow(id, { phase: 'idle', failure: null, undoLabel: '', action: null, explained: false });
      if (!canWrite(item)) return;
      api
        .dismissBriefItem(id, 'undo', item.token as string, date)
        .then(() => onSettled())
        .catch((err: unknown) => {
          const status = err instanceof ApiError ? err.status : undefined;
          setRow(id, { failure: writeFailureCopy(failureKind(status)) });
        });
    },
    [clearTimer, date, onSettled, setRow],
  );

  const markUseful = useCallback(
    async (item: BriefItem): Promise<boolean> => {
      if (!canWrite(item)) {
        setRow(item.item_id, { failure: writeFailureCopy('untokened') });
        return false;
      }
      try {
        await api.markBriefItemUseful(item.item_id, item.token as string, date);
        return true;
      } catch (err: unknown) {
        const status = err instanceof ApiError ? err.status : undefined;
        setRow(item.item_id, { failure: writeFailureCopy(failureKind(status)) });
        return false;
      }
    },
    [date, setRow],
  );

  const noteItem = useCallback(
    async (item: BriefItem, note: string): Promise<boolean> => {
      if (!canWrite(item)) {
        setRow(item.item_id, { failure: writeFailureCopy('untokened') });
        return false;
      }
      try {
        await api.noteBriefItem(item.item_id, item.token as string, date, note);
        return true;
      } catch (err: unknown) {
        const status = err instanceof ApiError ? err.status : undefined;
        setRow(item.item_id, { failure: writeFailureCopy(failureKind(status)) });
        return false;
      }
    },
    [date, setRow],
  );

  const rotorActions = useCallback(
    (item: BriefItem) => {
      const state = rowState(item.item_id);
      // A row sitting in its post-Done undo slot offers the "why" chips
      // instead (Ruling 146) — Done/Snooze/Useful make no sense on a row
      // that has already committed.
      if (state.phase === 'undo' && state.action === 'dismiss' && !state.explained) {
        return REASON_ROTOR_ACTIONS.map((a) => ({ ...a }));
      }
      return ROTOR_ACTIONS.map((a) => ({ ...a }));
    },
    [rowState],
  );

  const onRotorAction = useCallback(
    (item: BriefItem, action: string, onOpen: () => void) => {
      // CARVE-OUT TO RULING 61 (spec §10, flagged for the user in §12.4): the rotor
      // `done` COMMITS DIRECTLY, with no arm step. Two-tap exists to guard a
      // mis-tap while scrolling one-handed; a rotor action is already
      // deliberate, and a second rotor pass would be hostile.
      if (action === 'done') dismiss(item);
      else if (action === 'snooze') snooze(item, '1d');
      else if (action === 'useful') void markUseful(item);
      else if (action.startsWith('reason:')) {
        explain(item, action.slice('reason:'.length) as BriefReason);
      } else onOpen();
    },
    [dismiss, explain, markUseful, snooze],
  );

  return {
    rowState,
    openRail,
    closeRail,
    armDone,
    disarmAll,
    onArmThreshold,
    dismiss,
    snooze,
    undo,
    markUseful,
    explain,
    noteItem,
    rotorActions,
    onRotorAction,
  };
}
