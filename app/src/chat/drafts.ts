// iMessage draft approvals — the composed-to-`to`/`text` message the Mac's
// iMessage MCP holds as a draft (server/app.py's `draft_imessage`), waiting on
// the user's send/discard.
//
// A draft travels the EXISTING chat approval pipeline (chat/approval.py): an
// `attention` row keyed on a (run_id, request_id) that names a stored approval,
// whose linked message carries the `tool_call` part the agent used. What makes
// it a DRAFT rather than a generic tool approval is the tool that part names —
// the iMessage MCP's own `draft_imessage` — and the arguments it was called
// with (`to`, `text`, and the Mac-minted `draft_id`).
//
// This module is the ONE place that knows how to recognise one and how to read
// its recipient/body out of the part, so the thread card (DraftApprovalCard),
// the attention inbox, the Ops needs-you rows and the store selector all agree
// on what "a draft" is instead of four independent string checks drifting
// apart. Everything here is pure — no React, no store, no I/O.
import type { DraftApprovalDetails, Part, ToolCallPart } from './types';

/** The `attention.kind` the server tags a draft-approval row with. A generic
 * tool approval keeps `kind: 'approval'`; only an iMessage draft gets this. */
export const DRAFT_ATTENTION_KIND = 'imessage_draft';

/** The iMessage MCP tool whose call IS the draft. `draft_imessage` is the live
 * name (server/app.py's own tools/list probe); the alias keeps a server that
 * names the tool after the attention kind working without a second edit. */
const DRAFT_TOOL_NAMES: ReadonlySet<string> = new Set(['draft_imessage', 'imessage_draft']);

export function isDraftAttentionKind(kind: string | null | undefined): boolean {
  return kind === DRAFT_ATTENTION_KIND;
}

/** Whether a `tool_call` part is the iMessage draft (as opposed to any other
 * tool the agent parked on an approval). Checks `tool_name` only — a draft part
 * that has already been answered (`state: 'answered'`) still names its tool. */
export function isDraftToolCall(part: Part): part is ToolCallPart {
  return (
    part.type === 'tool_call' &&
    typeof part.tool_name === 'string' &&
    DRAFT_TOOL_NAMES.has(part.tool_name)
  );
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Pull the recipient / body / Mac draft id out of a draft tool call's `args`.
 * Every field is optional on the wire and the server's tool schema is the
 * authority (`to`, `text`); anything absent is left null and the caller falls
 * back to the attention row's own `summary`. Total: a non-object `args` reads
 * as all-null rather than throwing. */
export function draftDetailsFromArgs(args: unknown): DraftApprovalDetails {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return {
    to: str(a.to) ?? str(a.contact) ?? str(a.recipient) ?? null,
    text: str(a.text) ?? str(a.body) ?? str(a.message) ?? null,
    draft_id: num(a.draft_id) ?? num(a.id) ?? null,
  };
}

/** The draft details a linked tool_call carries, or null when the part is not
 * a draft tool call at all. Lets a caller tell "a draft with no readable args"
 * (all-null details) apart from "not a draft". */
export function draftDetailsFromPart(part: Part | undefined): DraftApprovalDetails | null {
  return part && isDraftToolCall(part) ? draftDetailsFromArgs(part.args) : null;
}

/** Rows the attention inbox should render with the draft treatment — the
 * server's own `kind` is the only signal an `AttentionInboxItem` carries. */
export function draftRows<T extends { kind: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => isDraftAttentionKind(row.kind));
}
