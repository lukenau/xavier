// Output pacing between the socket and the WebView.
//
// ttyd hands over bytes as fast as the pty produces them; `injectJavaScript`
// is one `evaluateJavaScript:` round trip per call. Coalescing a frame's worth
// of chunks into ONE `__w()` call is the difference between a burst of a
// hundred bridge hops and one — research §3.3, and the reason base64 of a
// 100 KB ttyd window (133 KB of JS string) is a single call rather than many.
//
// It also owns the ack ledger, which is the one way to break flow control from
// outside the transport (task-22-report.md §10.2): `ack()` must be called
// exactly once per chunk the client flagged `needsAck`, and never for an
// unflagged one. A batch therefore carries the COUNT of flagged chunks it
// contains, the page reports it back once the write has rendered, and the
// count is replayed one `onAck()` per flagged chunk.
import { bytesToBase64, concatBytes } from './base64';
import { jsWrite } from './xtermHtml';

/** One frame at 60 Hz. The queue drains on the next tick either way; this is
 * about how many chunks share a bridge hop, not about latency. */
export const FRAME_MS = 16;

export interface WriteBatcherOptions {
  inject: (js: string) => void;
  /** One call per chunk the transport flagged `needsAck`. */
  onAck: () => void;
  schedule?: (fn: () => void) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class WriteBatcher {
  private queue: Uint8Array[] = [];
  /** True while the page cannot execute anything — during a reload after the
   * content process died. Injecting then is a write into a page with no
   * `window.__w`: the bytes vanish and their acks never come back. */
  private suspended = false;
  /** Flagged chunks sitting in `queue`, not yet injected. */
  private queuedAcks = 0;
  /** Flagged chunks injected into a page that has not reported back yet. */
  private owedAcks = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: WriteBatcherOptions;
  private readonly schedule: NonNullable<WriteBatcherOptions['schedule']>;
  private readonly cancel: NonNullable<WriteBatcherOptions['cancel']>;

  constructor(opts: WriteBatcherOptions) {
    this.opts = opts;
    this.schedule = opts.schedule ?? ((fn) => setTimeout(fn, FRAME_MS));
    this.cancel = opts.cancel ?? ((handle) => clearTimeout(handle));
  }

  push(bytes: Uint8Array, needsAck: boolean): void {
    if (this.suspended) {
      // Dropped, not queued: a reload repaints from tmux anyway, and a long
      // reload would otherwise buffer the whole burst. The ack is paid NOW —
      // eleven stranded flagged chunks wedge ttyd's window past FLOW_HIGH and
      // the pty stays paused for the rest of the session.
      if (needsAck) this.opts.onAck();
      return;
    }
    this.queue.push(bytes);
    if (needsAck) this.queuedAcks += 1;
    if (this.timer !== null) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.flush();
    });
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const payload = concatBytes(this.queue);
    const acks = this.queuedAcks;
    this.queue = [];
    this.queuedAcks = 0;
    this.owedAcks += acks;
    this.opts.inject(jsWrite(bytesToBase64(payload), acks));
  }

  /** The page reported a rendered batch. `n` is the count that batch carried. */
  pageAcked(n: number): void {
    const acks = Math.min(n, this.owedAcks);
    this.owedAcks -= acks;
    for (let i = 0; i < acks; i += 1) this.opts.onAck();
  }

  /** The page is reloading: settle what is outstanding and drop (still acking)
   * everything that arrives until `resume()`. */
  suspend(): number {
    this.suspended = true;
    return this.settle();
  }

  /** The reloaded page reported `ready` — it can execute again. */
  resume(): void {
    this.suspended = false;
  }

  /**
   * The page is gone (WebKit killed the content process) or the screen is
   * unmounting: nothing will ever render these bytes, so the queue is dropped
   * — tmux repaints on the next resize — but every ack the socket is owed is
   * settled here. Losing them would strand ttyd's window above FLOW_HIGH and
   * leave the pty paused for the rest of the session.
   */
  settle(): number {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    const acks = this.owedAcks + this.queuedAcks;
    this.queue = [];
    this.queuedAcks = 0;
    this.owedAcks = 0;
    for (let i = 0; i < acks; i += 1) this.opts.onAck();
    return acks;
  }
}
