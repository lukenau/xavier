// A live "Ns" counter for anything that has no server-carried duration of its
// own — reasoning streams (ReasoningPart) and in-flight tool calls
// (ToolCallPart) before `duration_ms` lands. Wall-clock (Date.now()), not a
// tick counter, so a backgrounded app catching up on a burst of frames still
// reports real elapsed time.
//
// `since` anchors the count to something the SERVER said — the message's own
// created_at. Without it the count started at mount, so leaving a thread and
// coming back restarted it from zero, and a turn that never finalized counted
// up forever with no reference point (the user, 2026-09-22).
import { useEffect, useRef, useState } from 'react';

export function useElapsedSeconds(active: boolean, since?: string | null): number {
  const mountedAt = useRef(Date.now());
  const anchor = since ? Date.parse(since) : NaN;
  const startedAt = Number.isFinite(anchor) ? anchor : mountedAt.current;
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.round((Date.now() - startedAt) / 1000)));

  useEffect(() => {
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    if (!active) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);

  return seconds;
}

/** A finished duration, straight from the two timestamps the server stamped.
 * Preferred over the live counter wherever both ends are known. */
export function elapsedSecondsBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}
