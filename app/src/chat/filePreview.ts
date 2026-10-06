// What the Hub can show of a file, decided from its name and its MIME type.
//
// The file's own MIME type is NOT what decides this, because the Hub does not
// serve one: hub-api hands every non-image file to the client as an opaque
// `application/octet-stream` attachment (deliberately — an uploaded .html
// served inline from the Hub's own origin would run as the Hub), and the app
// receives it as bytes with only the name to go on. So the name leads.
//
// Four viewers, in order of how little they can go wrong:
//   'markdown' — markdown, laid out by the same parser and renderer the
//             transcript uses (`chat/markdown.ts` + `TextPart`), so a .md file
//             opens as the document it is rather than as its own source.
//   'text'  — decode the bytes and draw them as text. Used for everything
//             word-like, including HTML and SVG source: showing the source is
//             both simpler and safer than rendering it.
//   'image' — a picture, drawn by <Image>.
//   'frame' — PDF and SVG, which iOS renders natively from a local file.
// Anything else says 'none' rather than promising a blank frame.
export type PreviewKind = 'image' | 'markdown' | 'text' | 'frame' | 'none';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff']);
const FRAME_EXTENSIONS = new Set(['pdf', 'svg']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
// Markdown is decided above this set, so it is not repeated here.
const TEXT_EXTENSIONS = new Set([
  'txt', 'csv', 'tsv', 'json', 'log', 'xml', 'yml', 'yaml',
  'html', 'htm', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'sh',
  'sql', 'css', 'ini', 'toml', 'cfg', 'conf', 'diff', 'patch', 'plist',
]);

/** The lower-case extension, or '' when the name has none worth trusting.
 *  Eight is the ceiling because `.markdown` is a real one and is eight long;
 *  a longer tail is a backup suffix (`.png.backup`) rather than a type. */
export function previewExtensionOf(name: string | undefined): string {
  const dot = (name ?? '').lastIndexOf('.');
  if (dot <= 0 || dot === (name ?? '').length - 1) return '';
  const ext = (name ?? '').slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export function previewKindOf(name?: string, mime?: string): PreviewKind {
  // A type can arrive with parameters (`text/markdown; charset=utf-8`); the
  // bare type is what the comparisons below are written against.
  const type = (mime ?? '').trim().toLowerCase().split(';')[0].trim();
  const ext = previewExtensionOf(name);
  if (type === 'application/pdf' || type === 'image/svg+xml' || FRAME_EXTENSIONS.has(ext)) return 'frame';
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (type === 'text/markdown' || MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type.endsWith('+json') ||
    type.endsWith('+xml') ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    return 'text';
  }
  return 'none';
}
