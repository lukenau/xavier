// The demo's chat server: the seeded threads, the writes a thread takes, and a
// canned reply to anything sent. Replies reach the app the way real ones do —
// as frames on a socket. `createSocket()` hands chat/socket.ts an in-memory
// stand-in for the WebSocket it would open, so a reply travels the real path:
// wsClient → the coalescing queue → the reducer → the transcript, streaming
// word by word, with the working indicator, the Stop button and a widget.
import type { ChatSocket } from '../chat/wsClient';
import type {
  ChatBootstrapResponse,
  ChatFrame,
  ChatMessage,
  ChatSendResponse,
  ChatThreadDetailResponse,
  MarkReadResponse,
  Part,
  Thread,
  ThreadPatchInput,
} from '../chat/types';

/** How long "Xavier" takes to start answering, and the pace of the stream. */
export const REPLY_DELAY_MS = 700;
export const STREAM_TICK_MS = 60;
/** chat/ws.py's idle heartbeat. Without one the client's stall check would
 * re-dial an idle demo socket every 25 seconds. */
export const HEARTBEAT_MS = 15_000;

const OPEN = 1;
const CLOSED = 3;

interface ThreadRecord {
  thread: Thread;
  messages: ChatMessage[];
  /** Frames emitted since the demo started, for a subscribe that resumes from
   * an earlier seq. The seeded history comes from the REST snapshot instead. */
  frames: (ChatFrame & { seq: number })[];
  timers: ReturnType<typeof setTimeout>[];
  streaming: string | null;
}

export interface DemoImage {
  mime: string;
  data_b64: string;
  width: number | null;
  height: number | null;
}

const MAX_AUTO_TITLE = 48;

/** chat/routes.py's `_auto_title`: the first line, if it is enough to name a
 * conversation after. */
function autoTitle(text: string): string | null {
  const first = (text.trim().split('\n')[0] ?? '').split(/\s+/).filter(Boolean).join(' ');
  if (first.length < 16 && first.split(' ').length < 3) return null;
  if (first.length <= MAX_AUTO_TITLE) return first;
  const cut = first.slice(0, MAX_AUTO_TITLE).replace(/\s+\S*$/, '');
  return `${cut || first.slice(0, MAX_AUTO_TITLE)}…`;
}

function preview(parts: Part[]): string | null {
  const text = parts.find((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')?.text;
  return text ? text.split(/\s+/).join(' ').slice(0, 160) : null;
}

/** What the canned reply says, and the widget it draws. Chosen by a word or two
 * in the message, so the demo can show more than one kind of answer. */
export function cannedReply(text: string, images: number): Part[] {
  const lead = images > 0 ? 'Thanks for the picture. In the demo nothing looks at it, but on your own server I would. ' : '';
  const lower = text.toLowerCase();
  if (/weather|rain|forecast|umbrella|temperature/.test(lower)) {
    return [
      { type: 'text', text: `${lead}Here is the demo forecast. Every number is made up, and on your own server I would check a real one.` },
      {
        type: 'widget',
        kind: 'weather',
        props: {
          view: 'conditions',
          place: 'Demo City',
          temp: 61,
          feels_like: 58,
          summary: 'partly cloudy',
          days: [
            { label: 'today', low: 52, high: 64, condition: 'partly_cloudy', precip: 15 },
            { label: 'tomorrow', low: 55, high: 66, condition: 'rain', precip: 70 },
            { label: 'day 3', low: 50, high: 61, condition: 'cloudy', precip: 30 },
          ],
        },
      },
    ];
  }
  if (/spend|cost|money|budget|\$/.test(lower)) {
    return [
      { type: 'text', text: `${lead}From the demo ledger, which is fictional like everything here. The Cost page under Ops has the full breakdown.` },
      {
        type: 'widget',
        kind: 'metric',
        props: { label: 'spend this month', value: '1284.20', unit: 'USD', delta: '-12% vs last month', delta_tone: 'up', caption: 'demo ledger' },
      },
    ];
  }
  return [
    {
      type: 'text',
      text:
        `${lead}This is the demo, so you're reading a canned reply, not an agent. ` +
        'On your own server, Hermes answers here. It streams the reply as it writes, shows the tools it runs, and can draw widgets like this one.',
    },
    {
      type: 'widget',
      kind: 'card',
      props: {
        title: 'Demo mode',
        subtitle: 'nothing leaves this iPhone',
        rows: [
          { label: 'data', value: 'fictional', tone: 'accent' },
          { label: 'network', value: 'none', tone: 'up' },
          { label: 'agent', value: 'runs on your own server', tone: 'neutral' },
        ],
      },
    },
  ];
}

/** Text in stream-sized pieces: a couple of words at a time, spaces kept. */
function chunks(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
  return out;
}

export class DemoChat {
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly order: string[] = [];
  private readonly sockets = new Set<DemoSocket>();
  private readonly media = new Map<string, DemoImage>();
  private counter = 0;

  constructor(details: ChatThreadDetailResponse[], listed: string[]) {
    for (const detail of details) {
      this.threads.set(detail.thread.id, {
        thread: detail.thread,
        messages: detail.messages,
        frames: [],
        timers: [],
        streaming: null,
      });
    }
    this.order = listed;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_demo_${Date.now().toString(36)}${this.counter}`;
  }

  bootstrap(): ChatBootstrapResponse {
    const threads = [...this.threads.values()]
      .map((r) => r.thread)
      .filter((t) => this.order.includes(t.id) && !t.archived)
      .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.updated_at < b.updated_at ? 1 : -1));
    return { threads: threads.map((t) => ({ ...t })) };
  }

  detail(threadId: string): ChatThreadDetailResponse | null {
    const record = this.threads.get(threadId);
    if (!record) return null;
    return { thread: { ...record.thread }, messages: record.messages.map((m) => ({ ...m })), attention: [] };
  }

  has(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  createThread(title: string | null): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: this.nextId('thr'),
      kind: 'chat',
      title,
      status: 'idle',
      pinned: false,
      archived: false,
      last_seq: 0,
      created_at: now,
      updated_at: now,
      last_read_seq: 0,
      unread: 0,
      preview: null,
      preview_role: null,
      hermes_session_id: null,
      origin_thread_id: null,
      origin_message_id: null,
      origin_run_id: null,
      working: false,
    };
    this.threads.set(thread.id, { thread, messages: [], frames: [], timers: [], streaming: null });
    this.order.push(thread.id);
    return { ...thread };
  }

  markRead(threadId: string, seq: number): MarkReadResponse | null {
    const record = this.threads.get(threadId);
    if (!record) return null;
    const t = record.thread;
    t.last_read_seq = Math.max(t.last_read_seq, Math.min(seq, t.last_seq));
    t.unread = record.messages.filter((m) => m.seq > t.last_read_seq).length;
    return { thread_id: threadId, last_read_seq: t.last_read_seq, unread: t.unread };
  }

  patch(threadId: string, input: ThreadPatchInput): Thread | null {
    const record = this.threads.get(threadId);
    if (!record) return null;
    const changed: ThreadPatchInput = {};
    if (input.pinned !== undefined) changed.pinned = input.pinned;
    if (input.archived !== undefined) changed.archived = input.archived;
    if (input.title !== undefined) changed.title = input.title.trim() || record.thread.title || '';
    Object.assign(record.thread, changed);
    this.emit(record, { type: 'thread.patch', thread_id: threadId, seq: 0, ...changed });
    return { ...record.thread };
  }

  storeMedia(image: DemoImage): string {
    const id = `med_${(Date.now().toString(16) + this.counter.toString(16)).padStart(16, '0').slice(-16)}`;
    this.counter += 1;
    this.media.set(id, image);
    return id;
  }

  /** `/send`: the user's row now, the reply after REPLY_DELAY_MS. A retry with
   * the same client id is the same row, as the server's dedup index makes it. */
  send(threadId: string, text: string, clientMsgId: string, mediaIds: string[] = []): ChatSendResponse | null {
    const record = this.threads.get(threadId);
    if (!record) return null;
    const existing = record.messages.find((m) => m.client_msg_id === clientMsgId);
    if (existing) return { message: { ...existing }, deduped: true };

    const images: Part[] = mediaIds.flatMap((id) => {
      const image = this.media.get(id);
      return image
        ? [{ type: 'image' as const, media_id: id, url: `data:${image.mime};base64,${image.data_b64}`, mime: image.mime, width: image.width, height: image.height }]
        : [];
    });
    const parts: Part[] = text ? [{ type: 'text', text }, ...images] : images;
    const now = new Date().toISOString();
    const seq = record.thread.last_seq + 1;
    const message: ChatMessage = {
      id: this.nextId('msg'),
      thread_id: threadId,
      seq,
      version: seq,
      role: 'user',
      author_type: 'human',
      run_id: null,
      status: 'complete',
      client_msg_id: clientMsgId,
      cron_run_id: null,
      created_at: now,
      updated_at: now,
      parts,
      // "Handed to the agent": the transcript reads this as working at once.
      forward_status: 'forwarded',
      forward_reason: null,
    };
    record.messages.push(message);
    this.upsertFrame(record, message);
    const title = record.thread.title ? null : autoTitle(text);
    if (title) this.patch(threadId, { title });
    record.timers.push(setTimeout(() => this.reply(record, cannedReply(text, images.length)), REPLY_DELAY_MS));
    return { message: { ...message }, deduped: false };
  }

  /** Ends the reply in flight where it stands, as the gateway's /stop does. */
  stop(threadId: string): boolean {
    const record = this.threads.get(threadId);
    if (!record) return false;
    record.timers.forEach(clearTimeout);
    record.timers = [];
    const live = record.messages.find((m) => m.id === record.streaming);
    if (live) this.finish(record, live, live.parts);
    else this.setStatus(record, 'idle');
    return true;
  }

  tickChecklist(
    threadId: string,
    body: { message_id: string; part_index: number; item_index: number; state: string },
  ): { status: string; label: string; state: string } | null {
    const record = this.threads.get(threadId);
    const message = record?.messages.find((m) => m.id === body.message_id);
    const part = message?.parts[body.part_index] as { props?: { items?: { label: string; state: string }[] } } | undefined;
    const item = part?.props?.items?.[body.item_index];
    if (!record || !message || !part || !item) return null;
    item.state = body.state;
    this.bump(record, message);
    return { status: 'ok', label: item.label, state: body.state };
  }

  /** The in-memory socket chat/socket.ts dials instead of a WebSocket. */
  createSocket(): ChatSocket {
    return new DemoSocket(this);
  }

  /** Every timer and socket this demo started — called when the demo ends. */
  close(): void {
    for (const record of this.threads.values()) {
      record.timers.forEach(clearTimeout);
      record.timers = [];
    }
    for (const socket of [...this.sockets]) socket.close();
  }

  // --- socket side ----------------------------------------------------------
  attach(socket: DemoSocket): void {
    this.sockets.add(socket);
  }

  detach(socket: DemoSocket): void {
    this.sockets.delete(socket);
  }

  /** A subscribe: replay what this socket missed, then say it is caught up. */
  subscribe(socket: DemoSocket, threadId: string, afterSeq: number): void {
    const record = this.threads.get(threadId);
    if (!record) return;
    for (const frame of record.frames) if (frame.seq > afterSeq) socket.push(frame);
    socket.push({ type: 'synced', thread_id: threadId, seq: record.thread.last_seq });
  }

  // --- the reply ------------------------------------------------------------
  private reply(record: ThreadRecord, parts: Part[]): void {
    const text = parts[0]?.type === 'text' ? parts[0].text : '';
    this.setStatus(record, 'running');
    const now = new Date().toISOString();
    const seq = record.thread.last_seq + 1;
    const message: ChatMessage = {
      id: this.nextId('msg'),
      thread_id: record.thread.id,
      seq,
      version: seq,
      role: 'assistant',
      author_type: 'agent',
      run_id: this.nextId('run'),
      status: 'streaming',
      client_msg_id: null,
      cron_run_id: null,
      created_at: now,
      updated_at: now,
      parts: [{ type: 'text', text: '' }],
    };
    record.streaming = message.id;
    record.messages.push(message);
    this.upsertFrame(record, message);

    const pieces = chunks(text);
    pieces.forEach((delta, i) => {
      record.timers.push(
        setTimeout(() => {
          const live = record.messages.find((m) => m.id === message.id);
          const part = live?.parts[0];
          if (!live || live.status !== 'streaming' || part?.type !== 'text') return;
          const offset = part.text.length;
          part.text += delta;
          live.updated_at = new Date().toISOString();
          live.version = this.emit(record, {
            type: 'part.delta',
            thread_id: record.thread.id,
            seq: 0,
            message_id: live.id,
            idx: 0,
            delta,
            offset,
            length: part.text.length,
          });
        }, (i + 1) * STREAM_TICK_MS),
      );
    });
    record.timers.push(
      setTimeout(() => {
        const live = record.messages.find((m) => m.id === message.id);
        if (live && live.status === 'streaming') this.finish(record, live, parts);
      }, (pieces.length + 1) * STREAM_TICK_MS),
    );
  }

  private finish(record: ThreadRecord, message: ChatMessage, parts: Part[]): void {
    message.parts = parts;
    message.status = 'complete';
    record.streaming = null;
    this.bump(record, message);
    this.setStatus(record, 'idle');
  }

  private setStatus(record: ThreadRecord, status: string): void {
    record.thread.status = status;
    record.thread.working = status === 'running';
    this.emit(record, { type: 'thread.patch', thread_id: record.thread.id, seq: 0, status });
  }

  /** A changed row, re-sent whole at a new version (a checklist tick, the end
   * of a stream) — what the server's event log does for an update. */
  private bump(record: ThreadRecord, message: ChatMessage): void {
    message.updated_at = new Date().toISOString();
    this.upsertFrame(record, message, true);
  }

  private upsertFrame(record: ThreadRecord, message: ChatMessage, update = false): void {
    const seq = this.emit(record, {
      type: 'message.upsert',
      thread_id: record.thread.id,
      seq: 0,
      message_id: message.id,
      role: message.role,
      author_type: message.author_type,
      status: message.status,
      run_id: message.run_id,
      parts: message.parts,
      message_seq: message.seq,
      client_msg_id: message.client_msg_id,
      created_at: message.created_at,
      updated_at: message.updated_at,
    });
    message.version = update ? seq : message.version;
    const t = record.thread;
    t.updated_at = message.updated_at;
    t.preview = preview(message.parts) ?? t.preview;
    t.preview_role = message.role;
    t.unread = record.messages.filter((m) => m.seq > t.last_read_seq).length;
  }

  /** Stamps the frame with the thread's next seq, logs it, and sends it to
   * every socket subscribed to the thread. Returns the seq. */
  private emit(record: ThreadRecord, frame: ChatFrame & { seq: number }): number {
    const seq = record.thread.last_seq + 1;
    record.thread.last_seq = seq;
    // A copy, so the log keeps what was said at this seq even as the row it
    // describes goes on changing (a stream growing, a checklist ticked).
    const stamped = JSON.parse(JSON.stringify({ ...frame, seq })) as ChatFrame & { seq: number };
    if (stamped.type === 'message.upsert') stamped.version = seq;
    record.frames.push(stamped);
    for (const socket of this.sockets) if (socket.follows(record.thread.id)) socket.push(stamped);
    return seq;
  }
}

class DemoSocket implements ChatSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  private readonly subscribed = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly chat: DemoChat) {
    // Opens on the next tick, as a real socket does, so the client has wired
    // its handlers first.
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = OPEN;
      this.chat.attach(this);
      this.heartbeat = setInterval(() => this.push({ type: 'heartbeat' }), HEARTBEAT_MS);
      this.onopen?.();
    }, 0);
  }

  follows(threadId: string): boolean {
    return this.subscribed.has(threadId);
  }

  send(data: string): void {
    let msg: { type?: string; thread_id?: string; after_seq?: number };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type !== 'subscribe' || typeof msg.thread_id !== 'string') return;
    this.subscribed.add(msg.thread_id);
    this.chat.subscribe(this, msg.thread_id, msg.after_seq ?? 0);
  }

  push(frame: ChatFrame): void {
    if (this.readyState === OPEN) this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(): void {
    this.readyState = CLOSED;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.chat.detach(this);
  }
}
