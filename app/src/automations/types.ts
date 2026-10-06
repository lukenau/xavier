// Wire shapes for /api/chat/automations/* (server/chat/automations.py).
//
// A RUN is one firing of a scheduled job, keyed "<job_id>:<run file stem>".
// The job id is where the gateway wrote the run's file, so which job a run
// belongs to is never inferred on this side either.
import type { Part, Thread } from '../chat/types';

export type AutomationCategory = 'ops' | 'money' | 'personal' | 'background';
export type AutomationSection = 'needs_you' | 'new' | 'earlier' | 'quiet';
export type RunStatus = 'ok' | 'silent' | 'failed';
export type RunSeverity = 'info' | 'warn' | 'alert' | 'failed';
export type NotifyMode = 'push' | 'quiet' | 'muted';

export interface RunSummary {
  run_id: string;
  job_id: string;
  job_name: string;
  category: AutomationCategory | string;
  run_time: string;
  /** The run's calendar day in the Hub's own timezone, `YYYY-MM-DD`. */
  day: string;
  status: RunStatus | string;
  severity: RunSeverity | string;
  preview: string;
  /** The first lines a card shows, one per line. Optional: a hub-api from
   * before 2026-09-30 sends only `preview`. */
  preview_lines?: string[];
  /** Bulleted findings beyond the ones in `preview_lines`. */
  more_lines?: number;
  /** Equal for two runs that say the same thing, numbers aside. */
  fingerprint?: string;
  /** Bulleted lines in the output: what "4 issues" counts. */
  items: number;
  /** Says what the run before it said, numbers aside. */
  unchanged: boolean;
  new_lines: number;
  /** Runs in a row that have said this, and when the first of them ran. */
  streak: number;
  since: string;
  read: boolean;
  replies: number;
}

export interface AutomationJob {
  id: string;
  name: string;
  category: AutomationCategory | string;
  schedule: string | null;
  deliver: string | null;
  state: 'active' | 'paused' | 'completed' | 'removed' | string;
  mode: 'agent' | 'script' | string;
  next_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  notify: NotifyMode | string;
  snoozed_until: string | null;
  /** The chat this job was created from, when it was. */
  origin_thread: { id: string; title: string | null } | null;
  /** The newest run that had something to say. */
  latest: RunSummary | null;
  last_run: { run_time: string; status: RunStatus | string } | null;
  unread: number;
  needs_you: boolean;
  /** Its newest word is an alert, warning or failure, and no later run has
   * cleared it — whether or not he has seen it. */
  standing?: boolean;
  followups: number;
  section: AutomationSection | string;
  counts_30d: { runs: number; reported: number; silent: number; failed: number };
}

export interface AutomationsResponse {
  jobs: AutomationJob[];
  counts: { needs_you: number; unread: number; jobs: number };
  generated_at: string;
}

export interface QuietCount {
  job_id: string;
  name: string;
  count: number;
  silent: number;
}

export interface TimelineDay {
  day: string;
  runs: RunSummary[];
  quiet: QuietCount[];
}

export interface TimelineResponse {
  days: TimelineDay[];
  /** Pass back as `before` for the days under these; null at the beginning. */
  before: string | null;
}

export type JobItem =
  | { kind: 'run'; run: RunSummary }
  | { kind: 'span'; span: 'silent' | 'unchanged'; count: number; from: string; to: string };

export interface JobDetailResponse {
  job: AutomationJob;
  items: JobItem[];
}

export interface RunDetail extends RunSummary {
  output: string;
  truncated: boolean;
  parts: Part[];
}

export interface RunOpenResponse {
  run: RunDetail;
  job: AutomationJob;
  /** The thread under the run. Exists from the first time the run is opened. */
  thread: Thread;
}

export interface PrefsInput {
  notify?: NotifyMode;
  snooze_hours?: number;
  clear_snooze?: boolean;
}
