// Streaming arrives in chunks — the plugin batches ~48 characters per post so a
// reply costs 15 requests instead of 300 — and a chunk landing whole is the
// Discord-looking stutter the user asked about. This reveals whatever has arrived
// at a steady rate, so the text types itself out between chunks and the seams
// stop showing. It never invents characters: it only ever catches up to text
// that is already here, and the moment streaming ends it shows everything.
import { useEffect, useRef, useState } from 'react';

/** How often to reveal, and how many frames to spread a pending chunk over.
 * 24ms × 8 frames ≈ a fifth of a second to absorb a chunk — slower than the
 * chunks arrive at, so it reads as continuous typing rather than a queue. */
const TICK_MS = 24;
const FRAMES_PER_CHUNK = 8;

/** The most unrevealed text the reveal will ever sit behind. The plugin now
 * merges the chunks already queued behind each other into one post, so a busy
 * turn can deliver several hundred characters in a single frame; typing that
 * out proportionally would leave the reveal visibly replaying text that had
 * already arrived. Past this, it jumps. */
const MAX_BACKLOG = 220;

/** How far the reveal advances in one frame. Exported because it is the whole
 * behaviour worth testing — the hook around it is a `setInterval`. */
export function nextShownLength(shown: number, total: number): number {
  if (shown >= total) return total;
  const from = Math.max(shown, total - MAX_BACKLOG);
  return Math.min(total, from + Math.max(1, Math.ceil((total - from) / FRAMES_PER_CHUNK)));
}

export function useSmoothedText(rawText: string, enabled: boolean): string {
  // A part's `text` is agent-written and hub-api does not check its type, so a
  // missing or non-string value reaches here and `.length` throws — taking out
  // the whole chat tab, on a stored row that throws again on every reopen.
  const text = typeof rawText === 'string' ? rawText : '';
  const [shownLength, setShownLength] = useState(enabled ? 0 : text.length);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      setShownLength((shown) => nextShownLength(shown, target.current.length));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Not streaming (or never was): the whole thing, immediately. Also covers the
  // finalize, where the text is replaced wholesale and must not re-type itself.
  if (!enabled) return text;
  return text.slice(0, Math.min(shownLength, text.length));
}
