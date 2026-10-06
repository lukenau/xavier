// The `/` picker's catalog type + pure logic — VERDICT-V2 §4.6, modelled on
// Claude Code's own picker per the user's brief: one list of commands AND skills,
// filtered as you type, working mid-sentence not just at message start.
//
// `CommandCatalogEntry` is copied field-for-field from the live Pydantic model
// (server/chat/platform.py's `CommandCatalogEntry`) — this file owns
// the TS mirror since chat wire types have no PWA twin to stay parity-checked
// against (chat/types.ts's own header comment), and command-catalog types are
// not `/send`/`/bootstrap` wire shapes, so they get their own file rather than
// growing chat/types.ts.
export type CommandCategory = 'builtin' | 'skill' | 'plugin' | 'alias';
export type BusyPolicy = 'reject' | 'dispatch' | 'interrupt_then_dispatch';

export interface CommandCatalogEntry {
  /** Canonical invocation, leading slash included — e.g. `/brainstorming`. */
  name: string;
  /** Also leading-slash, e.g. `/reset` as an alias of `/new`. */
  aliases: string[];
  category: CommandCategory;
  description: string;
  arg_hint: string | null;
  busy_policy: BusyPolicy;
}

/** GET /api/chat/commands (server/chat/routes.py). */
export interface ChatCommandsResponse {
  version: number;
  commands: CommandCatalogEntry[];
  source: 'live' | 'bootstrap';
}

function stripSlash(s: string): string {
  return s.startsWith('/') ? s.slice(1) : s;
}

// --- filtering ----------------------------------------------------------------
// Only `skill` gets ranked first: it is the category the user reaches for
// mid-sentence (his own example), and the DISPATCH CONTEXT this sheet is built
// against makes it the only category a mid-sentence token actually dispatches
// for (skill_expand.py). builtin/plugin/alias are leading-slash-only concerns
// (SKILLS-API.md §5 steps 1-2, §10 step 1) and rank equally below skills.
const CATEGORY_RANK: Record<CommandCategory, number> = {
  skill: 0,
  builtin: 1,
  plugin: 1,
  alias: 1,
};

/** Prefix match on name and aliases (slash-insensitive, case-insensitive),
 * skills and builtins together in one list — never split into sections — with
 * a stable sort that only ever moves `skill` rows ahead of everything else.
 * An empty query matches every entry (opening the sheet on a bare `/`). */
export function filterCommands(
  commands: CommandCatalogEntry[],
  query: string,
): CommandCatalogEntry[] {
  const q = stripSlash(query).toLowerCase();
  const matches = (name: string) => stripSlash(name).toLowerCase().startsWith(q);
  return commands
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => matches(entry.name) || entry.aliases.some(matches))
    .sort((a, b) => CATEGORY_RANK[a.entry.category] - CATEGORY_RANK[b.entry.category] || a.index - b.index)
    .map(({ entry }) => entry);
}

// --- token-at-cursor detection --------------------------------------------------
export interface SlashContext {
  /** Index of the `/` character in the full text. */
  start: number;
  /** Text between the `/` and the cursor — the live filter query. */
  query: string;
}

/** Finds the `/token` the cursor currently sits inside, ANYWHERE in the text
 * (mid-sentence included — the user's corrected spec, not message-start-only).
 * A slash only starts a token at a word boundary (start of string or
 * preceded by whitespace) so `path/to/file` never triggers the picker mid-
 * word, and any whitespace between the slash and the cursor closes it (the
 * token has already ended — the user moved on). */
export function detectSlashContext(text: string, cursor: number): SlashContext | null {
  if (cursor < 0 || cursor > text.length) return null;
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '/') {
      const prev = i > 0 ? text[i - 1] : undefined;
      if (prev !== undefined && !/\s/.test(prev)) return null; // mid-word slash, e.g. a path
      const between = text.slice(i + 1, cursor);
      if (/\s/.test(between)) return null; // token already ended before the cursor
      return { start: i, query: between };
    }
    if (/\s/.test(ch)) return null; // hit whitespace before finding a slash: no token here
  }
  return null;
}

// --- insertion -------------------------------------------------------------------
export type CommandPlacement = 'inline' | 'message-start';

export interface CommandInsertion {
  text: string;
  /** Caret index into `text`, right after the inserted token's trailing space. */
  cursor: number;
  placement: CommandPlacement;
}

/** Inserts `entry` for the `/token` spanning `[slashStart, cursor)` in `text`.
 *
 * `skill` commands insert IN PLACE and keep everything already typed, before
 * and after the token — the user's mid-sentence flow ("look at the backup
 * retention thing and /" -> "...and /brainstorming ", caret after it, ready
 * for the instruction that follows).
 *
 * Every other category (builtin/plugin/alias) is a leading-slash-only concern
 * server-side (DISPATCH CONTEXT: the gateway only ever expands a LEADING
 * slash; skill_expand.py is the one mid-sentence exception, and it is scoped
 * to skills only per SKILLS-API.md §10). Picking one mid-sentence relocates it
 * to message start instead of inserting a token the server would just read as
 * prose — the caller shows a one-line hint when `placement` comes back
 * `'message-start'` and the token wasn't already at position 0. */
export function insertCommandToken(
  text: string,
  slashStart: number,
  cursor: number,
  entry: CommandCatalogEntry,
): CommandInsertion {
  const before = text.slice(0, slashStart);
  const after = text.slice(cursor);
  const token = entry.name;

  if (entry.category === 'skill') {
    // Exactly one whitespace char always separates the token from whatever
    // follows — reuse it if the user already typed one (mid-token cursor,
    // more prose still ahead) rather than doubling it up.
    const hasLeadingSpace = /^\s/.test(after);
    const inserted = hasLeadingSpace ? `${before}${token}${after}` : `${before}${token} ${after}`;
    return { text: inserted, cursor: before.length + token.length + 1, placement: 'inline' };
  }

  const remainder = (before + after).replace(/^\s+/, '');
  const inserted = remainder.length > 0 ? `${token} ${remainder}` : `${token} `;
  return { text: inserted, cursor: token.length + 1, placement: 'message-start' };
}

// --- unknown-command gate ---------------------------------------------------------
/** The leading `/token` of a message, or `null` if the message doesn't start
 * with one (leading whitespace tolerated — a composer's TextInput can carry
 * it transiently). Mirrors the gateway's own "the token right after `/`, up
 * to the next whitespace" shape. */
export function leadingCommandToken(text: string): string | null {
  const match = /^\s*(\/\S+)/.exec(text);
  return match ? match[1] : null;
}

function isKnownToken(token: string, commands: CommandCatalogEntry[]): boolean {
  const norm = token.toLowerCase();
  return commands.some(
    (c) => c.name.toLowerCase() === norm || c.aliases.some((a) => a.toLowerCase() === norm),
  );
}

/** The belt-and-suspenders check VERDICT-V2 §4.6.3 calls for: a message that
 * OPENS with a `/token` not in the catalog must never be sent — there is no
 * server-side guard, so an unrecognized slash-string would reach the model as
 * plain prose. Returns the offending token, or `null` when the send is safe
 * (no leading command at all, or it matches — a mid-sentence unknown token is
 * fine, that's just prose and this check never looks past position 0).
 *
 * Fails OPEN while the catalog hasn't loaded yet (`commands.length === 0`):
 * this is a client-side UX affordance, not a security boundary (the module
 * docstring for chat/routes.py is explicit that a send is never the gated
 * write), so blocking every leading-slash message during the catalog's own
 * cookie-gated fetch would be a worse default than the rare unknown-token
 * slipping through in that brief window. */
export function findUnknownLeadingCommand(
  text: string,
  commands: CommandCatalogEntry[],
): string | null {
  if (commands.length === 0) return null;
  const token = leadingCommandToken(text);
  if (!token) return null;
  return isKnownToken(token, commands) ? null : token;
}
