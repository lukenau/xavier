// Grouping the transcript into what a reader actually wants to see.
//
// The plugin delivers one MESSAGE per tool call (hooks.py forwards each
// post_tool_call as it fires), so a turn with six tools arrived as six rows,
// each collapsing to its own "Worked for 8s, 1 tool" fold, with a "Thought for
// 0s" above most of them. the user's screenshot of it: seven stacked folds and no
// answer in sight. The prototype's shape is ONE fold per turn — "Worked for
// 41s · 6 tools · 2 files" — so that is what this produces.
//
// The rule the design states and this enforces: errors and anything waiting on
// you NEVER collapse. A failed tool call or an approval request stays its own
// item, in place, however many quiet calls surround it.
import { parseProgress, type Progress } from './progress';
import type { ChatMessage, Part, ToolCallPart } from './types';

/** One delegated agent: its lifecycle row (start, updated in place by the
 * stop) and the goal it was given — which its own row does not carry. */
export interface AgentEntry {
  part: ToolCallPart;
  message: ChatMessage;
  goal: string | null;
}

export type TranscriptItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'activity'; key: string; parts: Part[]; toolCount: number; durationMs: number }
  | { kind: 'progress'; key: string; progress: Progress }
  | {
      kind: 'agents';
      key: string;
      agents: AgentEntry[];
      startedAt: string;
      endedAt: string;
      running: number;
      failed: number;
    };

function isQuietToolCall(part: Part): part is ToolCallPart {
  if (part.type !== 'tool_call') return false;
  if (part.state === 'approval_requested') return false;
  // A delegated task is never quiet — it gets its own card (gap A14).
  if (part.subagent) return false;
  return part.status !== 'error' && part.status !== 'running';
}

function isSubagentPart(part: Part): part is ToolCallPart {
  return part.type === 'tool_call' && !!part.subagent;
}

/** The parent's own `delegate_task` call: the dispatch record. Its result
 * names the goals the children were given, in dispatch order; the children's
 * own rows carry only a role and a session id (the gateway's subagent hooks
 * deliver nothing else — every one of the user's four agents on 2026-09-29 was
 * "leaf" with no goal, "WORKING 87s" and nothing to tell them apart). */
function isDelegationPart(part: Part): part is ToolCallPart {
  return (
    part.type === 'tool_call' &&
    !part.subagent &&
    part.state !== 'approval_requested' &&
    part.status !== 'error' &&
    /delegate/i.test(part.tool_name ?? '')
  );
}

function isAgentsMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || message.status === 'streaming' || message.status === 'error') return false;
  if (!message.parts.some(isSubagentPart)) return false;
  return message.parts.every((p) => isSubagentPart(p) || isDelegationPart(p) || p.type === 'reasoning');
}

function isDelegationOnly(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || message.status === 'streaming' || message.status === 'error') return false;
  if (!message.parts.some(isDelegationPart)) return false;
  return message.parts.every((p) => isDelegationPart(p) || p.type === 'reasoning');
}

/** The goals a dispatch record names, in the order the children were started. */
export function goalsOf(result: unknown): string[] {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const goals = (value as Record<string, unknown>).goals;
  return Array.isArray(goals) ? goals.filter((g): g is string => typeof g === 'string' && g.trim().length > 0) : [];
}

/** What a child's own row says it was asked, when it says anything. */
export function goalOf(args: unknown): string | null {
  if (typeof args === 'string') {
    try {
      return goalOf(JSON.parse(args));
    } catch {
      return args.trim() || null;
    }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const o = args as Record<string, unknown>;
    for (const key of ['goal', 'task', 'prompt', 'instruction', 'description']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The gateway's "still working" heartbeat, if that is all this message is.
 * They supersede each other, so only the last one is worth a row. */
function progressOf(message: ChatMessage): Progress | null {
  if (message.role !== 'assistant' || message.parts.length !== 1) return null;
  const part = message.parts[0];
  return part.type === 'text' ? parseProgress(part.text) : null;
}

/** A message that is only quiet tool calls and reasoning — nothing a reader
 * needs to see in full, and the unit this collapses. A message carrying text,
 * an image, a widget, an error or an approval is never swallowed. */
function isActivityOnly(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.status === 'streaming' || message.status === 'error') return false;
  if (message.parts.length === 0) return false;
  return message.parts.every((p) => isQuietToolCall(p) || p.type === 'reasoning');
}

/** The prose of a message that is prose and nothing else, or null. A message
 * carrying a tool call, an image, a widget or an approval is never prose, so
 * it can never be hidden by the dedup below. */
function proseOf(message: ChatMessage): string | null {
  if (message.role !== 'assistant' || message.parts.length === 0) return null;
  if (!message.parts.every((p) => p.type === 'text')) return null;
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return text.trim() ? text : null;
}

/** One reply, shown once.
 *
 * The gateway can stream a finished reply a second time: on 2026-10-01 run
 * aa2597a8 closed `msg_73e27296` at 01:26:10 and then opened `msg_ea506f1a`
 * two seconds later carrying the same 1721 characters, so the user saw the same
 * answer twice ("messages are double sending"). hub-api's own dedup is gated
 * on a *complete* delivery and a second stream walks past it; that is the real
 * fix and it is server-side. This keeps the duplicate off his screen now.
 *
 * The test is deliberately narrow: same run AND byte-identical prose. Matching
 * on run_id alone is the 2026-09 bug where a short note overwrote a long
 * reply, so text equality is what decides, and a repeat in a DIFFERENT run is
 * left alone — an agent that legitimately says the same thing twice across two
 * turns still says it twice. */
function dropRepeatedProse(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const text = message.run_id ? proseOf(message) : null;
    if (text === null) return true;
    const key = `${message.run_id}\u0000${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function groupTranscript(input: ChatMessage[]): TranscriptItem[] {
  const messages = dropRepeatedProse(input);
  const items: TranscriptItem[] = [];
  let run: ChatMessage[] = [];
  // A delegation, as one block: the children's rows and the dispatch record
  // next to them. Four anonymous "WORKING" bubbles, one message each, that
  // scrolled away under the work that followed was the wrong treatment (the user,
  // 2026-09-29: "they end up getting hidden up in previous messages").
  let agentRun: ChatMessage[] = [];
  // A dispatch record ahead of its children waits to see whether they follow.
  let pendingDelegation: ChatMessage[] = [];

  const flushAgents = () => {
    if (agentRun.length === 0) return;
    const group = agentRun;
    agentRun = [];
    const children = group.flatMap((m) => m.parts.filter(isSubagentPart).map((part) => ({ part, message: m })));
    const goals = group.flatMap((m) => m.parts.filter(isDelegationPart)).flatMap((p) => goalsOf(p.result));
    const agents: AgentEntry[] = children.map(({ part, message }, i) => ({
      part,
      message,
      goal: goals[i] ?? goalOf(part.args),
    }));
    const stamps = group.map((m) => Date.parse(m.created_at)).filter(Number.isFinite);
    const ends = group.map((m) => Date.parse(m.updated_at || m.created_at)).filter(Number.isFinite);
    items.push({
      kind: 'agents',
      key: `agents:${children[0].message.id}`,
      agents,
      startedAt: stamps.length > 0 ? new Date(Math.min(...stamps)).toISOString() : group[0].created_at,
      endedAt: ends.length > 0 ? new Date(Math.max(...ends)).toISOString() : group[0].created_at,
      running: agents.filter((a) => a.part.status === 'running').length,
      failed: agents.filter((a) => a.part.status === 'error').length,
    });
  };

  const flush = () => {
    if (run.length === 0) return;
    // One quiet call on its own is still clearer as a fold than as a bare row,
    // but it keeps the message's own identity so a later frame can update it.
    const parts = run.flatMap((m) => m.parts);
    const tools = parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
    // Wall time across the run, not the sum of the tools' own run times. The sum
    // left out every second the model spent deciding between calls, so a
    // three-minute stretch read "Worked for 1s" and the missing time looked like
    // work the Hub had dropped (the user, 2026-09-22 — it had not: every call was
    // there, to the second). `duration_ms` is checked for being a real number
    // because a string there concatenated instead of adding ("500" + "900").
    const toolMs = tools.reduce(
      (total, p) => total + (typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms) ? p.duration_ms : 0),
      0,
    );
    const start = Math.min(...run.map((m) => Date.parse(m.created_at)).filter(Number.isFinite));
    const end = Math.max(...run.map((m) => Date.parse(m.updated_at || m.created_at)).filter(Number.isFinite));
    const wallMs = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
    const durationMs = Math.max(wallMs, toolMs);
    items.push({ kind: 'activity', key: `activity:${run[0].id}`, parts, toolCount: tools.length, durationMs });
    run = [];
  };

  for (const message of messages) {
    if (isAgentsMessage(message)) {
      if (agentRun.length === 0) {
        flush();
        agentRun = pendingDelegation;
        pendingDelegation = [];
      }
      agentRun.push(message);
      continue;
    }
    if (isDelegationOnly(message)) {
      if (agentRun.length > 0) agentRun.push(message);
      else pendingDelegation.push(message);
      continue;
    }
    flushAgents();
    // A dispatch record with no children beside it is quiet work like any other.
    run.push(...pendingDelegation);
    pendingDelegation = [];
    if (isActivityOnly(message)) {
      run.push(message);
      continue;
    }
    const progress = progressOf(message);
    if (progress) {
      flush();
      // Each heartbeat replaces the last: they are one status, restated.
      const previous = items[items.length - 1];
      if (previous?.kind === 'progress') items.pop();
      // One stable key: only the newest heartbeat is ever shown, and a key that
      // changed with each one remounted the card and restarted the dot's pulse
      // from its dim phase — the dot "going grey" as the widget updated.
      items.push({ kind: 'progress', key: 'progress', progress });
      continue;
    }
    flush();
    items.push({ kind: 'message', key: message.id, message });
  }
  flushAgents();
  run.push(...pendingDelegation);
  flush();
  // A heartbeat is live status, not history. Anything that arrives after one
  // has superseded it, so only a heartbeat still at the end of the transcript
  // is describing now. Keeping the others left an empty "Working" card sitting
  // in the thread after the turn was over, with the real messages stacked
  // under it (the user, 2026-10-01: it "blocks every later message until I close
  // and reopen the chat").
  return items.filter((item, i) => item.kind !== 'progress' || i === items.length - 1);
}
