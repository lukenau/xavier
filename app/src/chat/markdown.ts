// Markdown for the transcript, parsed here rather than pulled from a package.
//
// Xavier writes markdown; the first cut rendered it raw, so the user saw literal
// asterisks (2026-09-22). Every markdown library — even the pure-JS ones — is a
// new dependency, and a new dependency changes the expo-updates fingerprint,
// which orphans the OTA and makes a TestFlight build the price of bold text.
// So: the subset the agent actually emits, in ~100 lines, shipped over the air.
//
// Deliberately NOT supported: tables, images, footnotes, nested lists, HTML.
// They do not appear in Xavier's replies, and each one is a parser branch that
// can mis-render the text around it. Anything unmatched stays literal.

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export type Block =
  | { type: 'p'; spans: Span[] }
  | { type: 'h'; level: 1 | 2 | 3; spans: Span[] }
  | { type: 'li'; ordered: boolean; marker: string; spans: Span[] }
  | { type: 'quote'; spans: Span[] }
  | { type: 'code'; text: string; lang: string | null }
  | { type: 'rule' };

const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(?:---+|\*\*\*+|___+)$/;

/** `**bold**`, `*italic*`/`_italic_`, `` `code` ``, `[text](href)`. Ordered so a
 * longer marker wins over its prefix, and code spans swallow their contents so
 * an asterisk inside backticks stays an asterisk. */
const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

/** The same rule `chat/widget.ts` applies to a widget's Link, applied to the
 *  markdown that every assistant message goes through. */
function asHttpsHref(raw: string): string | null {
  return /^https:\/\/[^\s]+$/i.test(raw) ? raw : null;
}

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let rest = text;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) {
      spans.push({ text: rest });
      break;
    }
    if (m.index > 0) spans.push({ text: rest.slice(0, m.index) });
    const token = m[0];
    if (token.startsWith('`')) {
      spans.push({ text: token.slice(1, -1), code: true });
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      // The href is written by the agent and is handed straight to
      // `Linking.openURL`, which on iOS gives ANY registered scheme to its app
      // — `shortcuts://run-shortcut?name=…` under a link labelled "Open the
      // report" would fire a Shortcut on one tap. Only https is tappable; a
      // link with any other scheme keeps its words and loses its tap.
      const href = asHttpsHref(token.slice(split + 2, -1));
      spans.push({ text: token.slice(1, split), ...(href ? { href } : {}) });
    } else if (token.startsWith('**') || token.startsWith('__')) {
      spans.push({ text: token.slice(2, -2), bold: true });
    } else {
      spans.push({ text: token.slice(1, -1), italic: true });
    }
    rest = rest.slice(m.index + token.length);
  }
  return spans.filter((s) => s.text.length > 0);
}

export function parseMarkdown(source: string): Block[] {
  // hub-api does not check that a text part carries a string, so an object or
  // a null reaches here and `.replace` throws — taking out the whole chat tab,
  // on a row that is already stored and will throw again on every reopen.
  if (typeof source !== 'string') return [];
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'p', spans: parseInline(paragraph.join(' ').trim()) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = FENCE.exec(line.trim());
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', text: body.join('\n'), lang: fence[1] || null });
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (RULE.test(line.trim())) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'h', level: heading[1].length as 1 | 2 | 3, spans: parseInline(heading[2]) });
      continue;
    }
    const numbered = NUMBERED.exec(line.trim());
    if (numbered) {
      flush();
      blocks.push({ type: 'li', ordered: true, marker: `${numbered[1]}.`, spans: parseInline(numbered[2]) });
      continue;
    }
    const bullet = BULLET.exec(line.trim());
    if (bullet) {
      flush();
      blocks.push({ type: 'li', ordered: false, marker: '•', spans: parseInline(bullet[1]) });
      continue;
    }
    const quote = QUOTE.exec(line.trim());
    if (quote) {
      flush();
      blocks.push({ type: 'quote', spans: parseInline(quote[1]) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
