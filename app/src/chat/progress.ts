// The gateway's long-running heartbeats — "⏳ Working — 3 min — iteration 9/60,
// waiting for provider response (streaming)" — arrive as ordinary assistant
// text and pile up in the transcript as prose. They are status, not something
// Xavier said: one live row, not a stack of stale ones (the user, 2026-09-22).
//
// Matching is deliberately loose on the prose and strict on the numbers: the
// wording comes from the gateway's own notification strings and can change,
// but "iteration N/M" and a duration are the parts worth rendering.

export interface Progress {
  /** "3 min", "45s" — as the gateway phrased it. Null when it did not say. */
  elapsed: string | null;
  iteration: number | null;
  totalIterations: number | null;
  /** "waiting for provider response (streaming)" — the trailing clause. */
  detail: string | null;
}

const WORKING = /(?:^|\s)(?:⏳\s*)?(?:still\s+)?working\b/i;
const ITERATION = /iteration\s+(\d+)\s*\/\s*(\d+)/i;
const ELAPSED = /\b(\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours))\b/i;

/** `null` when this is ordinary prose — the common case, and the one that must
 * never be swallowed. */
export function parseProgress(text: string): Progress | null {
  const line = text.trim();
  if (line.length === 0 || line.length > 200) return null;
  if (!WORKING.test(line)) return null;

  const iteration = ITERATION.exec(line);
  const elapsed = ELAPSED.exec(line);
  const detail = line.includes(',') ? line.slice(line.indexOf(',') + 1).trim() : null;
  return {
    elapsed: elapsed ? elapsed[1].replace(/\s+/g, ' ') : null,
    iteration: iteration ? Number(iteration[1]) : null,
    totalIterations: iteration ? Number(iteration[2]) : null,
    detail: detail && detail.length > 0 ? detail : null,
  };
}
