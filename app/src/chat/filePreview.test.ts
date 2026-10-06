// Which viewer a file gets, and when the Hub should say it cannot show one.
//
// The name leads, not the MIME type: hub-api hands every non-image file to the
// app as an opaque `application/octet-stream` attachment, so by the time this
// runs the real type is usually gone.
import { previewExtensionOf, previewKindOf } from './filePreview';

it('lays out a markdown file as a document, by name or by type', () => {
  const md = { name: 'hub-stack-coldstart.md', mime: 'text/markdown' };
  expect(previewKindOf(md.name, md.mime)).toBe('markdown');
  expect(previewKindOf('NOTES.MD')).toBe('markdown');
  expect(previewKindOf('release-notes.markdown')).toBe('markdown');
  // No name at all, but the type survives — and a type can carry parameters.
  expect(previewKindOf(undefined, 'text/markdown; charset=utf-8')).toBe('markdown');
  expect(previewKindOf(undefined, 'text/markdown')).toBe('markdown');
});

it('draws every other word-like file as its source, by name or by type', () => {
  expect(previewKindOf('notes.txt', 'text/plain')).toBe('text');
  expect(previewKindOf('export.csv')).toBe('text');
  expect(previewKindOf('rows', 'application/json')).toBe('text');
  expect(previewKindOf('index.html', 'text/html')).toBe('text');
  expect(previewKindOf('script.py')).toBe('text');
});

it('renders the two things iOS draws natively from a local file', () => {
  expect(previewKindOf('report.pdf', 'application/pdf')).toBe('frame');
  expect(previewKindOf('flow-trust.svg', 'image/svg+xml')).toBe('frame');
  expect(previewKindOf('diagram.svg')).toBe('frame');
});

it('shows a picture for a raster image, by type or by name', () => {
  expect(previewKindOf('IMG_1234.HEIC', 'image/heic')).toBe('image');
  expect(previewKindOf('shot.png')).toBe('image');
  expect(previewKindOf(undefined, 'image/jpeg')).toBe('image');
});

it('says none, rather than promising a blank frame, for what it cannot draw', () => {
  expect(previewKindOf('bundle.zip', 'application/zip')).toBe('none');
  expect(previewKindOf('book.xlsx')).toBe('none');
  expect(previewKindOf('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('none');
  expect(previewKindOf('blob', 'application/octet-stream')).toBe('none');
  // A bare name and no type at all is nothing to go on — the Hub keeps the
  // real type only for images, so this is the honest answer.
  expect(previewKindOf('payload')).toBe('none');
  expect(previewKindOf(undefined, undefined)).toBe('none');
});

it('does not read a picture out of a name that only looks like one', () => {
  // The extension has to be a real one, and short.
  expect(previewKindOf('holiday.png.backup', 'application/zip')).toBe('none');
  expect(previewKindOf('archive.pngx')).toBe('none');
  expect(previewKindOf('.png')).toBe('none');
  expect(previewKindOf('png')).toBe('none');
});

it('reads the extension case-insensitively', () => {
  expect(previewExtensionOf('REPORT.PDF')).toBe('pdf');
  expect(previewKindOf('REPORT.PDF')).toBe('frame');
  expect(previewExtensionOf('no-extension')).toBe('');
});
