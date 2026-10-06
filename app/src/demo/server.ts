// The demo's stand-in for hub-api. api.ts hands every request here instead of
// to fetch() while the demo is on, and gets back a response shaped like the one
// fetch() would have produced, so the rest of api.ts — error parsing, the
// challenge → sign → apply sequence — runs unchanged.
//
// Reads come from fixtures.json, recorded from the repo's fictional demo seed
// (app/scripts/demo-fixtures.py) and moved to the present as they are loaded
// (time.ts). Writes land in memory: a dismissed brief item stays dismissed, an
// answered decision moves to answered, an opened automation is read — until the
// demo is left, which throws the whole world away. Features that only make
// sense against a real machine (the terminal, the shells, pairing, connecting
// an account) answer with an honest 503 instead of pretending.
import type { Brief, BriefRule } from '../lib/briefTypes';
import { BRIEF_BUCKETS } from '../lib/briefTypes';
import type { CalendarResponse, WireEvent } from '../lib/calendarTypes';
import type {
  AdvisorState,
  ConfigFullReport,
  CronReport,
  DecisionsReport,
  PairingReport,
  TopicsConfig,
  TopicsReport,
  WriteRequest,
} from '../lib/types';
import type { ChatThreadDetailResponse } from '../chat/types';
import type { AutomationJob, AutomationsResponse, JobDetailResponse, RunOpenResponse, TimelineResponse } from '../automations/types';
import type { ChatSocket } from '../chat/wsClient';
import { DemoChat } from './chat';
import { DEMO_REPO } from './mode';
import { localDay, makeShifter, type FixtureMeta, type Shifter } from './time';

interface RouteFixture {
  status: number;
  body: unknown;
}

interface Fixtures {
  meta: FixtureMeta & { source: string };
  routes: Record<string, RouteFixture>;
  pages: Record<string, string>;
}

// Required rather than imported: a JSON import would make tsc infer a type for
// every one of its thousands of values.
const FIXTURES = require('./fixtures.json') as Fixtures;

/** The subset of fetch()'s Response that api.ts reads. */
export interface DemoResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export const SERVER_ONLY_DETAIL = `Runs on your own server, not in the demo. See ${DEMO_REPO}.`;

/** How long a calendar "Sync now" stays pending before it lands. */
export const CALENDAR_SYNC_MS = 2500;

const SNOOZE_DAYS: Record<string, number> = { '1d': 1, '3d': 3, '1w': 7 };
/** Writes that act on a real machine: a host shell, a pairing code. */
const SERVER_ONLY_ACTIONS = new Set(['tmux.spawn', 'tmux.kill', 'devicekey.enroll_code']);
const SECTION_ORDER: Record<string, number> = { needs_you: 0, new: 1, earlier: 2, quiet: 3 };
const DAY_MS = 86_400_000;

class HttpError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(typeof body === 'string' ? body : 'demo error');
  }
}

const notFound = (what = 'Not in the demo.') => new HttpError(404, { detail: what });
const serverOnly = () => new HttpError(503, { detail: { code: 'demo_server_only', detail: SERVER_ONLY_DETAIL } });

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** `path?b=2&a=1` with each value decoded and re-encoded one way, so a fixture
 * recorded with `/` left bare matches a request that encodes it as %2F. */
function canonical(path: string): string {
  const [pathname, query] = path.split('?');
  if (!query) return pathname;
  const pairs = query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const [k, v = ''] = pair.split('=');
      return `${encodeURIComponent(decodeURIComponent(k))}=${encodeURIComponent(decodeURIComponent(v))}`;
    });
  return `${pathname}?${pairs.join('&')}`;
}

function queryParams(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (path.split('?')[1] ?? '').split('&').filter(Boolean)) {
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

function challenge() {
  return {
    challenge: `demo${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    rp_id: 'demo',
    user_verification: 'required',
    allowed_credentials: [],
    timeout_ms: 120_000,
  };
}

function writeResult(extra: Record<string, unknown> = {}) {
  return { status: 'applied', code: 0, stdout: '', stderr: '', applied_at: new Date().toISOString(), ...extra };
}

/** A config value typed into the app arrives as a string; store it as the
 * leaf's own type, as the server's config writer would. */
function coerce(value: string, type: string): unknown {
  if (type === 'bool') return value === 'true';
  if ((type === 'int' || type === 'float') && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (type === 'list' || type === 'dict') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

class DemoWorld {
  readonly shift: Shifter;
  private readonly routes = new Map<string, RouteFixture>();
  private readonly pages = new Map<string, string>();
  readonly chat: DemoChat;

  private readonly dismissed = new Set<string>();
  private readonly snoozed = new Map<string, number>();
  private readonly useful = new Set<string>();
  private rules: BriefRule[];
  private readonly answers = new Map<string, { option_key: string | null; note: string | null; ts: string }>();
  private topics: TopicsConfig | null = null;
  private readonly config = new Map<string, string>();
  private preset: string | null = null;
  private readonly cronState = new Map<string, 'active' | 'paused' | 'removed'>();
  private readonly approvedCodes = new Set<string>();
  private readonly revokedUsers = new Set<string>();
  private readonly readJobs = new Set<string>();
  private readonly openedRuns = new Set<string>();
  private readonly prefs = new Map<string, { notify?: string; snoozed_until?: string | null }>();
  private syncRequestedAt: number | null = null;
  private syncedAt: string | null = null;
  private ruleCount = 0;

  constructor(now: Date) {
    this.shift = makeShifter(FIXTURES.meta, now);
    for (const [key, fixture] of Object.entries(FIXTURES.routes)) {
      const [method, path] = key.split(' ');
      this.routes.set(`${method} ${canonical(path)}`, fixture);
    }
    for (const [path, html] of Object.entries(FIXTURES.pages)) this.pages.set(path, html);
    this.rules = this.fixture<{ rules: BriefRule[] }>('GET /briefing/rules.json').rules;

    const boot = this.fixture<{ threads: { id: string }[] }>('GET /chat/bootstrap');
    const details = [...this.routes.keys()]
      .filter((k) => /^GET \/chat\/threads\/[^/?#]+$/.test(k))
      .map((k) => this.fixture<ChatThreadDetailResponse>(k));
    this.chat = new DemoChat(details, boot.threads.map((t) => t.id));
  }

  /** A recorded answer, moved to the present. Throws the recorded error. */
  private fixture<T>(key: string): T {
    const hit = this.routes.get(key);
    if (!hit) throw notFound();
    if (hit.status >= 400) throw new HttpError(hit.status, hit.body);
    return this.shift.value(hit.body) as T;
  }

  private lookup(method: string, path: string): unknown {
    const key = `${method} ${canonical(path)}`;
    if (this.routes.has(key)) return this.fixture(key);
    return this.fixture(this.shift.unshiftText(key));
  }

  page(path: string): string | null {
    const html = this.pages.get(path) ?? this.pages.get(this.shift.unshiftText(path));
    return html === undefined ? null : this.shift.text(html);
  }

  handle(method: string, path: string, body: Record<string, unknown>): unknown {
    const pathname = path.split('?')[0];
    const q = queryParams(path);
    let m: RegExpMatchArray | null;

    if (method === 'GET') {
      if (pathname.startsWith('/tmux/')) throw serverOnly();
      if (pathname === '/cron/logs') return this.cronLogs(Number(q.limit) || 30);
      if (pathname === '/cron') return this.cron();
      if (pathname === '/pairing') return this.pairing();
      if (pathname === '/brief') return this.brief();
      if (pathname === '/briefing/rules.json') return { rules: this.rules };
      if (pathname === '/decisions') return this.decisions();
      if (pathname === '/config/topics') return this.topicsReport();
      if (pathname === '/config/full') return this.configFull();
      if (pathname === '/advisor') return this.advisor();
      if (pathname === '/calendar') return this.calendar(q.from, q.to);
      if (pathname === '/chat/bootstrap') return this.chat.bootstrap();
      if ((m = pathname.match(/^\/chat\/threads\/([^/]+)$/))) return this.threadDetail(decodeURIComponent(m[1]));
      if (pathname.startsWith('/chat/threads/') && pathname.includes('/subagent/')) throw notFound('no such subagent');
      if (pathname === '/chat/automations') return this.automations();
      if (pathname === '/automations/badge') return { needs_you: this.automations().counts.needs_you };
      if ((m = pathname.match(/^\/chat\/automations\/jobs\/([^/]+)$/))) return this.job(decodeURIComponent(m[1]));
      if (pathname === '/chat/automations/timeline') return this.timeline(path);
      return this.lookup('GET', path);
    }

    // --- writes ----------------------------------------------------------------
    // Refused at the challenge, before Face ID is asked for something that
    // cannot happen here.
    if (/^\/(connectors\/[^/]+|terminal|push)\/challenge$/.test(pathname)) throw serverOnly();
    if (pathname === '/action/challenge' && SERVER_ONLY_ACTIONS.has((body.request as WriteRequest | undefined)?.action ?? '')) {
      throw serverOnly();
    }
    if (pathname.endsWith('/challenge')) return challenge();
    if (pathname === '/action/apply') return this.apply(body.request as WriteRequest);
    if ((m = pathname.match(/^\/decisions\/([^/]+)\/answer$/))) return this.answer(decodeURIComponent(m[1]), body);
    if (pathname === '/config/topics') {
      this.topics = body.config as TopicsConfig;
      return { status: 'saved', pending_sync: true };
    }
    if (pathname === '/briefing/rules.json') return this.editRules(body);
    if (pathname === '/briefing/dismiss.json') return this.dismiss(body);
    if (pathname === '/briefing/useful.json') {
      const id = String(body.item_id);
      const already = this.useful.has(id);
      this.useful.add(id);
      return { ok: true, item_id: id, signal: 'useful', ...(already ? { already: true } : {}) };
    }
    if (pathname === '/briefing/note.json') return { ok: true, item_id: String(body.item_id), signal: 'note' };
    if (pathname === '/calendar/sync') return this.requestSync();
    if (pathname === '/chat/session' || pathname === '/chat/logout' || pathname === '/terminal/logout') return { ok: true };
    if (pathname === '/chat/presence') return { in_app: true };
    if (pathname === '/chat/approval/apply') {
      const decisions = (body.decisions as { run_id: string; request_id: string; choice: string }[]) ?? [];
      return { status: 'ok', decisions: decisions.map((d) => ({ ...d, status: 'answered' })) };
    }
    if (pathname === '/chat/threads') return { thread: this.chat.createThread((body.title as string | null) ?? null) };
    if ((m = pathname.match(/^\/chat\/threads\/([^/]+)\/(read|patch|stop|send|media|checklist)$/))) {
      return this.chatWrite(decodeURIComponent(m[1]), m[2], body);
    }
    if ((m = pathname.match(/^\/chat\/clarify\/([^/]+)$/))) return { status: 'ok', clarify_id: decodeURIComponent(m[1]) };
    if (pathname === '/chat/automations/read-all') return this.readAll();
    if ((m = pathname.match(/^\/chat\/automations\/jobs\/([^/]+)\/(read|prefs)$/))) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'read') this.readJobs.add(id);
      else this.setPrefs(id, body);
      return { job: this.jobSummary(id) };
    }
    if ((m = pathname.match(/^\/chat\/automations\/runs\/([^/]+)\/open$/))) return this.openRun(decodeURIComponent(m[1]));
    if (/^\/(devicekey|passkey)\//.test(pathname) || /^\/connectors\/[^/]+\//.test(pathname)) throw serverOnly();
    throw notFound();
  }

  // --- ops ---------------------------------------------------------------------
  private cronLogs(limit: number) {
    const logs = this.fixture<{ runs: unknown[] }>('GET /cron/logs');
    const runs = logs.runs.slice(0, Math.max(1, Math.min(200, limit)));
    return { ...logs, runs, count: runs.length };
  }

  private cron(): CronReport {
    const report = this.fixture<CronReport>('GET /cron');
    report.jobs = report.jobs
      .filter((job) => this.cronState.get(job.id) !== 'removed')
      .map((job) => {
        const state = this.cronState.get(job.id);
        return state === 'active' || state === 'paused' ? { ...job, state, active: state === 'active' } : job;
      });
    report.count = report.jobs.length;
    return report;
  }

  private apply(request: WriteRequest | undefined) {
    switch (request?.action) {
      case 'config.set': {
        if (!request.key) throw new HttpError(400, { detail: 'key required' });
        this.config.set(request.key, request.value ?? '');
        return writeResult({ keys_written: [request.key] });
      }
      case 'advisor.preset':
        this.preset = request.preset ?? null;
        return writeResult({ preset: request.preset, restarted: true, restart_code: 0 });
      case 'cron.pause':
      case 'cron.resume':
      case 'cron.remove':
        if (request.job_id) {
          this.cronState.set(
            request.job_id,
            request.action === 'cron.pause' ? 'paused' : request.action === 'cron.resume' ? 'active' : 'removed',
          );
        }
        return writeResult();
      case 'pairing.approve':
        if (request.code) this.approvedCodes.add(request.code);
        return writeResult();
      case 'pairing.revoke':
        if (request.user_id) this.revokedUsers.add(request.user_id);
        return writeResult();
      case 'gateway.restart':
        return writeResult({ restarted: true, restart_code: 0 });
      case 'tmux.spawn':
      case 'tmux.kill':
      case 'devicekey.enroll_code':
        throw serverOnly();
      default:
        return writeResult();
    }
  }

  /** An approved request leaves the pending list for the approved one, and a
   * revoked user leaves that. */
  private pairing(): PairingReport {
    const report = this.fixture<PairingReport>('GET /pairing');
    const approved = report.pending.filter((p) => this.approvedCodes.has(p.code));
    report.pending = report.pending.filter((p) => !this.approvedCodes.has(p.code));
    report.approved = [
      ...report.approved,
      ...approved.map(({ platform, user_id, user_name }) => ({ platform, user_id, user_name })),
    ].filter((a) => !this.revokedUsers.has(a.user_id));
    report.pending_count = report.pending.length;
    report.approved_count = report.approved.length;
    return report;
  }

  private configFull(): ConfigFullReport {
    const report = this.fixture<ConfigFullReport>('GET /config/full');
    for (const section of report.sections) {
      for (const leaf of section.leaves) {
        const value = this.config.get(leaf.key);
        if (value !== undefined) Object.assign(leaf, { value: coerce(value, leaf.type), set: true });
      }
    }
    return report;
  }

  private advisor(): AdvisorState {
    const state = this.fixture<AdvisorState>('GET /advisor');
    return this.preset ? { ...state, preset: this.preset as AdvisorState['preset'] } : state;
  }

  private topicsReport(): TopicsReport {
    const report = this.fixture<TopicsReport>('GET /config/topics');
    if (!this.topics) return report;
    return { ...report, config: { ...report.config, ...this.topics, pending_sync: true }, pending_sync: true };
  }

  // --- brief ---------------------------------------------------------------------
  private brief(): Brief {
    const brief = this.fixture<Brief>('GET /brief');
    const now = Date.now();
    let hidden = 0;
    for (const bucket of BRIEF_BUCKETS) {
      const items = brief.buckets[bucket] ?? [];
      const kept = items.filter((item) => !this.dismissed.has(item.item_id) && !((this.snoozed.get(item.item_id) ?? 0) > now));
      hidden += items.length - kept.length;
      brief.buckets[bucket] = kept;
    }
    brief.hidden_count = (brief.hidden_count ?? 0) + hidden;
    return brief;
  }

  private dismiss(body: Record<string, unknown>) {
    const id = String(body.item_id);
    const action = String(body.action);
    if (action === 'undo') {
      this.dismissed.delete(id);
      this.snoozed.delete(id);
    } else if (action === 'dismiss') {
      this.dismissed.add(id);
      this.snoozed.delete(id);
    } else if (action.startsWith('snooze')) {
      const days = SNOOZE_DAYS[action.split(':')[1] ?? '1d'];
      if (!days) throw new HttpError(400, { detail: 'bad snooze span' });
      const until = Date.now() + days * DAY_MS;
      this.snoozed.set(id, until);
      this.dismissed.delete(id);
      return { ok: true, item_id: id, action, until: new Date(until).toISOString() };
    } else if (!action.startsWith('reason:')) {
      throw new HttpError(400, { detail: 'bad action' });
    }
    return { ok: true, item_id: id, action };
  }

  private editRules(body: Record<string, unknown>) {
    if (typeof body.remove === 'string') {
      this.rules = this.rules.filter((rule) => rule.id !== body.remove);
    } else {
      const text = String(body.text ?? '').trim();
      if (!text) throw new HttpError(400, { detail: 'rule text required' });
      this.ruleCount += 1;
      this.rules = [...this.rules, { id: `demo-rule-${this.ruleCount}`, text, ts: new Date().toISOString() }];
    }
    return { rules: this.rules };
  }

  // --- decisions -------------------------------------------------------------------
  private decisions(): DecisionsReport {
    const report = this.fixture<DecisionsReport>('GET /decisions');
    for (const [id, answer] of this.answers) {
      const at = report.open.findIndex((d) => d.id === id);
      if (at === -1) continue;
      const [card] = report.open.splice(at, 1);
      report.answered.unshift({ ...card, status: answer.option_key === 'dismiss' ? 'dismissed' : 'answered', answer });
    }
    return report;
  }

  private answer(id: string, body: Record<string, unknown>) {
    const open = this.fixture<DecisionsReport>('GET /decisions').open.some((d) => d.id === id);
    if (!open || this.answers.has(id)) throw new HttpError(409, { detail: 'already answered' });
    const ts = new Date().toISOString();
    this.answers.set(id, {
      option_key: (body.option_key as string | null) ?? null,
      note: (body.note as string | null) ?? null,
      ts,
    });
    return { status: 'answered', answered_at: ts };
  }

  // --- calendar ----------------------------------------------------------------------
  /** Events keep their wall-clock time on their moved day, and the synced weeks
   * are re-anchored on this week, so the screen reads as freshly synced. */
  private calendar(from?: string, to?: string): CalendarResponse {
    const raw = FIXTURES.routes['GET /calendar'].body as CalendarResponse;
    const events: WireEvent[] = raw.events.map((event) =>
      event.all_day
        ? { ...event, start_date: event.start_date && this.shift.text(event.start_date), end_date: event.end_date && this.shift.text(event.end_date) }
        : { ...event, start: event.start && this.shift.floatingWallClock(event.start), end: event.end && this.shift.floatingWallClock(event.end) },
    );
    const inRange = events.filter((event) => {
      const first = event.all_day ? event.start_date : event.start && localDay(new Date(event.start));
      const last = event.all_day
        ? event.end_date && localDay(new Date(Date.parse(`${event.end_date}T00:00:00`) - 1))
        : event.end && localDay(new Date(Date.parse(event.end) - 1));
      return !!first && !!last && (!to || first <= to) && (!from || last >= from);
    });

    const anchorMonday = this.mondayOf(new Date(`${FIXTURES.meta.anchor_date}T12:00:00`));
    const thisMonday = this.mondayOf(new Date());
    const weeks = raw.weeks.map((week) => {
      const offset = Math.round((Date.parse(`${week.monday}T12:00:00`) - anchorMonday.getTime()) / DAY_MS);
      const monday = new Date(thisMonday);
      monday.setDate(monday.getDate() + offset);
      return {
        monday: localDay(monday),
        work: week.work && this.shift.text(week.work),
        personal: week.personal && this.shift.text(week.personal),
      };
    });
    const last = weeks.length ? new Date(`${weeks[weeks.length - 1].monday}T12:00:00`) : null;
    if (last) last.setDate(last.getDate() + 6);

    const pending = this.syncRequestedAt !== null && Date.now() - this.syncRequestedAt < CALENDAR_SYNC_MS;
    if (this.syncRequestedAt !== null && !pending) {
      this.syncedAt = new Date(this.syncRequestedAt + CALENDAR_SYNC_MS).toISOString();
      this.syncRequestedAt = null;
    }
    return {
      events: inRange,
      synced_at: this.syncedAt ?? (raw.synced_at && this.shift.text(raw.synced_at)),
      window: weeks.length && last ? { from: weeks[0].monday, to: localDay(last) } : null,
      stale_slices: 0,
      weeks,
      sync_requested_at: pending ? new Date(this.syncRequestedAt as number).toISOString() : null,
    };
  }

  private mondayOf(date: Date): Date {
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return monday;
  }

  private requestSync() {
    const already = this.syncRequestedAt !== null && Date.now() - this.syncRequestedAt < CALENDAR_SYNC_MS;
    if (!already) this.syncRequestedAt = Date.now();
    return { requested_at: new Date(this.syncRequestedAt as number).toISOString(), already };
  }

  // --- chat ----------------------------------------------------------------------------
  private threadDetail(threadId: string): ChatThreadDetailResponse {
    const detail = this.chat.detail(threadId);
    if (!detail) throw notFound('no such thread');
    return detail;
  }

  private chatWrite(threadId: string, action: string, body: Record<string, unknown>) {
    if (!this.chat.has(threadId)) throw notFound('no such thread');
    switch (action) {
      case 'read':
        return this.chat.markRead(threadId, Number(body.seq) || 0);
      case 'patch':
        return { thread: this.chat.patch(threadId, body) };
      case 'stop':
        this.chat.stop(threadId);
        return { status: 'ok', thread_id: threadId };
      case 'media': {
        const data = String(body.data_b64 ?? '');
        const media_id = this.chat.storeMedia({
          mime: String(body.mime ?? 'image/jpeg'),
          data_b64: data,
          width: (body.width as number | null) ?? null,
          height: (body.height as number | null) ?? null,
        });
        return { status: 'ok', media_id, size_bytes: Math.floor((data.length * 3) / 4) };
      }
      case 'checklist': {
        const ticked = this.chat.tickChecklist(threadId, body as never);
        if (!ticked) throw notFound('no such checklist item');
        return ticked;
      }
      default: {
        const sent = this.chat.send(
          threadId,
          String(body.text ?? ''),
          String(body.client_msg_id ?? ''),
          (body.media_ids as string[] | undefined) ?? [],
        );
        if (!sent) throw notFound('no such thread');
        return sent;
      }
    }
  }

  // --- automations ------------------------------------------------------------------------
  /** One job's summary as it stands: the read version once it has been marked
   * or opened, with any notify or snooze change on top. */
  private jobSummary(id: string): AutomationJob {
    const source = this.readJobs.has(id) ? 'GET /chat/automations#read' : 'GET /chat/automations';
    const job = this.fixture<AutomationsResponse>(source).jobs.find((j) => j.id === id);
    if (!job) throw notFound('no such automation');
    const prefs = this.prefs.get(id);
    if (!prefs) return job;
    const out = { ...job, ...prefs } as AutomationJob;
    const snoozed = !!out.snoozed_until && Date.parse(out.snoozed_until) > Date.now();
    if (out.notify === 'muted' || snoozed) {
      out.needs_you = false;
      out.unread = 0;
      if (out.section === 'needs_you' || out.section === 'new') out.section = out.notify === 'muted' ? 'quiet' : 'earlier';
    }
    return out;
  }

  private automations(): AutomationsResponse {
    const base = this.fixture<AutomationsResponse>('GET /chat/automations');
    const latest = (job: AutomationJob) => (job.latest ?? job.last_run)?.run_time ?? '';
    const jobs = base.jobs
      .map((job) => this.jobSummary(job.id))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .sort((a, b) => (latest(a) < latest(b) ? 1 : latest(a) > latest(b) ? -1 : 0))
      .sort((a, b) => (SECTION_ORDER[a.section] ?? 9) - (SECTION_ORDER[b.section] ?? 9));
    return {
      ...base,
      jobs,
      counts: {
        needs_you: jobs.filter((j) => j.needs_you).length,
        unread: jobs.reduce((sum, j) => sum + j.unread, 0),
        jobs: jobs.length,
      },
    };
  }

  private isRead(runId: string, jobId: string): boolean {
    return this.readJobs.has(jobId) || this.openedRuns.has(runId);
  }

  private job(id: string): JobDetailResponse {
    const key = this.readJobs.has(id) ? `GET /chat/automations/jobs/${id}#read` : `GET /chat/automations/jobs/${id}`;
    const detail = this.fixture<JobDetailResponse>(key);
    for (const item of detail.items) if (item.kind === 'run' && this.isRead(item.run.run_id, id)) item.run.read = true;
    return { ...detail, job: this.jobSummary(id) };
  }

  private timeline(path: string): TimelineResponse {
    const before = queryParams(path).before;
    const key = before ? `GET /chat/automations/timeline?before=${this.shift.unshiftText(before)}` : 'GET /chat/automations/timeline';
    const page = this.fixture<TimelineResponse>(key);
    for (const day of page.days) for (const run of day.runs) if (this.isRead(run.run_id, run.job_id)) run.read = true;
    return page;
  }

  private readAll() {
    let cleared = 0;
    for (const job of this.automations().jobs) {
      if (job.needs_you) continue;
      this.readJobs.add(job.id);
      cleared += 1;
    }
    return { cleared, counts: this.automations().counts };
  }

  private setPrefs(id: string, body: Record<string, unknown>) {
    this.jobSummary(id);
    const next = { ...this.prefs.get(id) };
    if (typeof body.notify === 'string') next.notify = body.notify;
    if (body.clear_snooze) next.snoozed_until = null;
    else if (typeof body.snooze_hours === 'number') next.snoozed_until = new Date(Date.now() + body.snooze_hours * 3_600_000).toISOString();
    this.prefs.set(id, next);
  }

  private openRun(runId: string): RunOpenResponse {
    const opened = this.lookup('POST', `/chat/automations/runs/${runId}/open`) as RunOpenResponse;
    const jobId = opened.run.job_id;
    this.openedRuns.add(runId);
    // Opening reads the job through this run; through its newest run is all of it.
    if (this.jobSummary(jobId).latest?.run_id === runId) this.readJobs.add(jobId);
    return { ...opened, run: { ...opened.run, read: true }, job: this.jobSummary(jobId) };
  }
}

let world: DemoWorld | null = null;

function getWorld(): DemoWorld {
  if (!world) world = new DemoWorld(new Date());
  return world;
}

/** api.ts's transport while the demo is on: one request in, one fetch()-like
 * response out. A fault in a handler becomes a 500 the screen can show, never
 * an exception thrown through the UI. */
export async function demoFetch(path: string, init?: { method?: string; body?: unknown }): Promise<DemoResponse> {
  const method = (init?.method ?? 'GET').toUpperCase();
  let status = 200;
  let payload: unknown;
  try {
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    payload = clone(getWorld().handle(method, path, body));
  } catch (err) {
    status = err instanceof HttpError ? err.status : 500;
    payload = err instanceof HttpError ? err.body : { detail: err instanceof Error ? err.message : 'demo error' };
  }
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/** A recorded /my-pages page, for the page viewer — null if the demo has none. */
export function demoPage(url: string): string | null {
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0];
  return getWorld().page(path.endsWith('/') ? path : `${path}/`);
}

const FIXTURE_THREADS = new Set(
  Object.keys(FIXTURES.routes)
    .map((key) => /^GET \/chat\/threads\/([^/?#]+)$/.exec(key)?.[1])
    .filter((id): id is string => !!id),
);

/** A thread that only exists in the demo — seeded, or started in it — whose
 * cached tail (chat/cache.ts) must not outlive it. */
export function isDemoThreadId(id: string): boolean {
  return id.startsWith('thr_demo_') || FIXTURE_THREADS.has(id);
}

/** The in-memory socket chat/socket.ts dials instead of a WebSocket. */
export function createDemoSocket(): ChatSocket {
  return getWorld().chat.createSocket();
}

/** Drops every write, timer and socket the demo made. The next request builds a
 * fresh world, re-anchored on the current time. */
export function resetDemoWorld(): void {
  world?.chat.close();
  world = null;
}
