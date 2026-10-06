// What kind of thing a tool call actually did, from its name alone.
//
// Every finished tool used to show the same grey TOOL badge, so a transcript
// of twelve calls read as twelve identical rows and you had to open each one
// to find the shell command among the file reads (audit gap A15). The glyph
// carries the kind at a glance; the label is what a badge with room shows.
//
// Name-matching is the only signal available: the gateway sends `tool_name`
// and nothing else that distinguishes a read from a write. Ordering below is
// significant — `write_file` must not match the `file` read rule first.

export type ToolKind = 'command' | 'read' | 'write' | 'fetch' | 'memory' | 'delegate' | 'message' | 'other';

export interface ToolKindView {
  kind: ToolKind;
  /** One character, monospace-safe, no emoji — emoji break the row's baseline. */
  glyph: string;
  label: string;
}

const VIEWS: Record<ToolKind, ToolKindView> = {
  command: { kind: 'command', glyph: '$', label: 'shell' },
  read: { kind: 'read', glyph: 'R', label: 'read' },
  write: { kind: 'write', glyph: 'W', label: 'write' },
  fetch: { kind: 'fetch', glyph: '↓', label: 'fetch' },
  memory: { kind: 'memory', glyph: '◇', label: 'memory' },
  delegate: { kind: 'delegate', glyph: '⑂', label: 'agent' },
  message: { kind: 'message', glyph: '→', label: 'send' },
  other: { kind: 'other', glyph: '◆', label: 'tool' },
};

const RULES: [ToolKind, RegExp][] = [
  ['delegate', /delegate|subagent|spawn_agent|dispatch_task/],
  ['write', /write|create|edit|append|save|upload|put_|insert|update_file|mkdir|patch/],
  ['command', /bash|shell|exec|run_command|terminal|command|script|python|process/],
  ['fetch', /browser|fetch|http|url|web|crawl|scrape|download|exa|search_web|google|serp/],
  ['memory', /memor|supermemory|recall|remember|embed|vector|knowledge/],
  ['message', /send_|message|notify|email|telegram|discord|slack|sms|imessage|post_/],
  ['read', /read|search|grep|glob|list|find|cat|ls|view|get_|query|fetch_row|inspect/],
];

export function toolKindOf(toolName: unknown): ToolKindView {
  // `tool_name` arrives unchecked from the gateway; a number or an object threw
  // on `.toLowerCase` and took out the transcript.
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  if (!name) return VIEWS.other;
  for (const [kind, pattern] of RULES) {
    if (pattern.test(name)) return VIEWS[kind];
  }
  return VIEWS.other;
}
