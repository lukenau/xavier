// Xavier's replies came through with literal asterisks (the user, 2026-09-22).
// These pin the subset the transcript renders, and the cases that must stay
// literal rather than being half-parsed.
import { parseInline, parseMarkdown } from './markdown';

const texts = (spans: ReturnType<typeof parseInline>) => spans.map((s) => s.text);

describe('inline', () => {
  it('reads bold, italic, code and links, and drops the markers', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c' },
    ]);
    expect(parseInline('_x_ and *y*')).toEqual([
      { text: 'x', italic: true },
      { text: ' and ' },
      { text: 'y', italic: true },
    ]);
    expect(parseInline('run `ls -la` now')).toEqual([
      { text: 'run ' },
      { text: 'ls -la', code: true },
      { text: ' now' },
    ]);
    expect(parseInline('see [the docs](https://x/y)')).toEqual([
      { text: 'see ' },
      { text: 'the docs', href: 'https://x/y' },
    ]);
  });

  it('leaves an asterisk inside a code span alone', () => {
    expect(parseInline('`a * b`')).toEqual([{ text: 'a * b', code: true }]);
  });

  it('leaves unmatched markers literal rather than eating the rest of the line', () => {
    expect(texts(parseInline('2 * 3 = 6'))).toEqual(['2 * 3 = 6']);
    expect(texts(parseInline('**unclosed bold'))).toEqual(['**unclosed bold']);
  });
});

describe('blocks', () => {
  it('splits paragraphs on blank lines and joins wrapped lines', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'p', spans: [{ text: 'one two' }] });
  });

  it('reads headings, bullets and numbered items', () => {
    const blocks = parseMarkdown('# Title\n- first\n- second\n1. one\n2) two');
    expect(blocks.map((b) => b.type)).toEqual(['h', 'li', 'li', 'li', 'li']);
    expect(blocks[0]).toMatchObject({ level: 1 });
    expect(blocks[1]).toMatchObject({ ordered: false, marker: '•' });
    expect(blocks[3]).toMatchObject({ ordered: true, marker: '1.' });
    expect(blocks[4]).toMatchObject({ ordered: true, marker: '2.' });
  });

  it('keeps a fenced block verbatim, markers and blank lines included', () => {
    const blocks = parseMarkdown('before\n```bash\nrm -rf *\n\nls\n```\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'code', 'p']);
    expect(blocks[1]).toEqual({ type: 'code', text: 'rm -rf *\n\nls', lang: 'bash' });
  });

  it('handles the real shape of an ops delivery', () => {
    const blocks = parseMarkdown('**Cleared:** Superhuman Mail token issue resolved — MCP should be back online now.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'p',
      spans: [{ text: 'Cleared:', bold: true }, { text: ' Superhuman Mail token issue resolved — MCP should be back online now.' }],
    });
  });

  it('is unfazed by an empty string', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
