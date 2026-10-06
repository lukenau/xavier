// Turning a tool call's args/result into something readable.
//
// The plugin sends both as STRINGS (hub_wire.bounded JSON-encodes and truncates
// them), and the first renderer ran JSON.stringify over those strings again —
// so a terminal call read `"{\"command\": \"date -u\"}"`, escapes and all, in
// one unlabelled blob. "fix how the tool call details are parsed for viewing"
// (the user, 2026-09-22).
//
// Rules, in order: a string that parses as JSON is treated as the object it
// encodes; a known shape gets a named section; anything else is shown exactly
// as it arrived. Nothing is ever re-encoded, and nothing is invented — an
// unrecognised payload is still shown, just under a generic label.

export interface ToolSection {
  label: string;
  text: string;
}

/** Unwrap as far as the encoding goes, not one level.
 *
 * Real payloads arrive double- and triple-encoded: a JSON string holding a JSON
 * string holding an object — `"{\"error\": \"{\\\"error\\\": …}\"}"` was on
 * screen as raw backslashes (the user, 2026-09-22). Each pass either decodes or
 * stops; the depth cap is only a guard against a pathological payload, since a
 * successful parse always shortens the string. Nested JSON *inside* an object's
 * values gets the same treatment, which is where the doubly-wrapped errors live. */
const MAX_DECODE_DEPTH = 6;

function decode(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DECODE_DEPTH) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const looksEncoded =
      trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
    if (!looksEncoded) return value;
    try {
      return decode(JSON.parse(trimmed), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = decode(item, depth + 1);
    return out;
  }
  return value;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // `JSON.stringify` RangeErrors on a deeply nested payload — and so does
    // `String(value)` on that same structure, out of a catch nothing else
    // guards. A tool result is agent-relayed, so this has to be total.
    try {
      return String(value);
    } catch {
      return '[unrenderable]';
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The one-line preview on the collapsed row: the command, the path, the query —
 * whatever the tool's own primary argument is — never the JSON wrapper. */
export function toolSummary(args: unknown): string {
  const decoded = decode(args);
  if (isRecord(decoded)) {
    for (const key of ['command', 'path', 'file_path', 'query', 'url', 'prompt', 'goal']) {
      const found = decoded[key];
      if (typeof found === 'string' && found.trim().length > 0) return found.trim();
    }
    const first = Object.values(decoded).find((v) => typeof v === 'string' && v.trim().length > 0);
    if (typeof first === 'string') return first.trim();
  }
  return asText(decoded).trim();
}

export function argSections(args: unknown): ToolSection[] {
  if (args === null || args === undefined || args === '') return [];
  const decoded = decode(args);
  if (!isRecord(decoded)) return dedupe([{ label: 'Arguments', text: asText(decoded) }]);

  const sections: ToolSection[] = [];
  const rest: Record<string, unknown> = { ...decoded };
  if (typeof rest.command === 'string') {
    sections.push({ label: 'Command', text: rest.command });
    delete rest.command;
  }
  if (typeof rest.code === 'string') {
    sections.push({ label: 'Code', text: rest.code });
    delete rest.code;
  }
  if (Object.keys(rest).length > 0) {
    sections.push({ label: 'Arguments', text: asText(rest) });
  }
  return dedupe(sections);
}

/** Anything already said once is not said again. Payload shapes overlap — a
 * result that carries both `output` and a `result` copy of it, an error object
 * whose message is repeated in its detail — and the card was showing the same
 * text twice, once raw and once tidied (the user, 2026-09-22). */
function dedupe(sections: ToolSection[]): ToolSection[] {
  const kept: ToolSection[] = [];
  for (const section of sections) {
    const text = section.text.trim();
    if (text.length === 0) continue;
    const bare = core(text);
    const twin = kept.findIndex((k) => {
      const seen = core(k.text);
      return seen.includes(bare) || bare.startsWith(seen);
    });
    if (twin === -1) kept.push(section);
    // The fuller telling of the same thing wins, whichever arrived first.
    else if (core(kept[twin].text).length < bare.length) kept[twin] = section;
  }
  return kept;
}

/** The gateway echoes an error twice: once raw, once tagged and cut short —
 * `chart needs buckets` then `tool_error chart needs buckets`, or a schema
 * error followed by `tool_scope_block <the same thing> … [truncated 156
 * chars]`. Same sentence, so strip the tag and the cut before comparing
 * (the user, 2026-09-22). */
const STATUS_TAG = /^(tool_error|tool_scope_block|tool_result|error)[:\s]\s*/i;
const TRUNCATION = /…?\s*\[truncated \d+ chars\]\s*$/;

function core(text: string): string {
  return text.trim().replace(STATUS_TAG, '').replace(TRUNCATION, '').trim();
}

export function resultSections(result: unknown): ToolSection[] {
  if (result === null || result === undefined || result === '') return [];
  const decoded = decode(result);
  if (!isRecord(decoded)) return dedupe([{ label: 'Result', text: asText(decoded) }]);

  const sections: ToolSection[] = [];
  const rest: Record<string, unknown> = { ...decoded };
  // Tools disagree about the key: terminal says `output`, an MCP call says
  // `result`. Both are the thing the reader wants first.
  if (rest.result !== undefined && rest.output === undefined) {
    // Already decoded by now, so this is as often an array or object as a
    // string — either way it is the payload, formatted rather than re-encoded.
    rest.output = typeof rest.result === 'string' ? rest.result : asText(rest.result);
    delete rest.result;
  }
  if (typeof rest.output === 'string') {
    // An empty output is worth saying out loud: "it ran and printed nothing" is
    // a different fact from "there is no output section".
    sections.push({ label: 'Output', text: rest.output.length > 0 ? rest.output : '(no output)' });
    delete rest.output;
  }
  // An error is often itself an encoded object — `{"error": {"error": "…",
  // "hint": "…"}}`. Take the message for the Error line and let the rest fall
  // through to Detail, rather than printing the wrapper.
  const err = decode(rest.error);
  delete rest.error;
  if (typeof err === 'string' && err.length > 0) {
    sections.push({ label: 'Error', text: err });
  } else if (isRecord(err)) {
    const message = err.error ?? err.message ?? err.detail;
    const inner: Record<string, unknown> = { ...err };
    delete inner.error;
    delete inner.message;
    delete inner.detail;
    if (typeof message === 'string' && message.length > 0) sections.push({ label: 'Error', text: message });
    for (const [key, value] of Object.entries(inner)) if (!(key in rest)) rest[key] = value;
  }
  if (typeof rest.exit_code === 'number') {
    sections.push({ label: 'Exit', text: String(rest.exit_code) });
    delete rest.exit_code;
  }
  // Run metadata the agent needs and a reader does not: how many bytes were
  // captured, whether stdout was truncated, how long it took. Dropped only when
  // something substantive is already on screen.
  const NOISE = ['status', 'duration_seconds', 'tool_calls_made', 'stdout_truncated',
    'stdout_bytes_captured', 'stdout_bytes_total', 'stdout_bytes_omitted'];
  if (sections.length > 0) for (const key of NOISE) delete rest[key];
  if (Object.keys(rest).length > 0) {
    sections.push({ label: sections.length > 0 ? 'Detail' : 'Result', text: asText(rest) });
  }
  return dedupe(sections);
}

/** The part carries its own `error` beside the one inside `result`, and the
 * gateway writes them differently: `{"error": "<the whole thing>"}` in the
 * result, `tool_scope_block <the same thing>… [truncated 156 chars]` on the
 * part. The card printed both (the user, 2026-09-22). Null when the sections
 * already say it. */
export function errorSection(error: unknown, shown: ToolSection[]): ToolSection | null {
  if (typeof error !== 'string' || error.trim().length === 0) return null;
  const bare = core(error);
  const said = shown.some((s) => {
    const seen = core(s.text);
    return seen.includes(bare) || bare.startsWith(seen);
  });
  return said ? null : { label: 'Error', text: error };
}
