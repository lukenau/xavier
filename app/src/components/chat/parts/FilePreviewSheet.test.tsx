// The text a preview draws, which is the part that was blank on device: the
// Hub serves a file as an opaque attachment, so the only thing to show is the
// bytes the app already downloaded, decoded here.
//
// And what it draws them AS: a markdown file opens as the document it is, laid
// out by the same parser and renderer a reply goes through — printing its
// source instead was the complaint (the user, 2026-10-02).
jest.mock('../../../chat/files', () => ({ fetchFilePart: jest.fn(), shareFile: jest.fn() }));

import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { FilePreviewSheet, previewTextOf } from './FilePreviewSheet';
import type { FilePart } from '../../../chat/types';

const files = require('../../../chat/files') as { fetchFilePart: jest.Mock };

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

/** ASCII bytes, which is all these fixtures need. */
const bytesOf = (text: string) => Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));

const filePart = (name: string, mime?: string): FilePart => ({ type: 'file', name, mime, media_id: 'media-1' });

async function openSheet(part: FilePart, text: string): Promise<TestRenderer.ReactTestRenderer> {
  files.fetchFilePart.mockResolvedValue({
    uri: `file:///x/${part.name}`,
    dir: 'file:///x',
    name: part.name,
    bytes: bytesOf(text),
  });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <FilePreviewSheet onClose={() => {}} part={part} />
      </SafeAreaProvider>,
    );
  });
  return tree;
}

const file = (bytes?: Uint8Array) => ({ uri: 'file:///x/a.md', dir: 'file:///x', name: 'a.md', bytes });

it('decodes the downloaded bytes into text', () => {
  expect(previewTextOf(file(new Uint8Array([104, 105, 10])))).toBe('hi\n');
});

it('decodes multi-byte text, not just ASCII', () => {
  // "café" in UTF-8
  expect(previewTextOf(file(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9])))).toBe('café');
});

it('has nothing to draw when the bytes were not kept, or there is no file', () => {
  expect(previewTextOf(file(undefined))).toBeNull();
  expect(previewTextOf(null)).toBeNull();
});

it('draws an empty file as empty text, not as a failure', () => {
  expect(previewTextOf(file(new Uint8Array([])))).toBe('');
});

it('lays a markdown file out as a document rather than printing its source', async () => {
  const tree = await openSheet(
    filePart('coldstart.md', 'text/markdown'),
    '# Cold start\n\nIt takes **twelve seconds** and `--warm` skips it.\n\n- one\n- two\n',
  );
  const drawn = JSON.stringify(tree.toJSON());
  // The words are there, and the markers that shaped them are not.
  expect(drawn).toContain('Cold start');
  expect(drawn).toContain('twelve seconds');
  expect(drawn).not.toContain('# Cold start');
  expect(drawn).not.toContain('**twelve seconds**');
  expect(drawn).not.toContain('`--warm`');
  act(() => tree.unmount());
});

it('still prints a file that is not markdown as its source', async () => {
  const tree = await openSheet(filePart('notes.txt', 'text/plain'), '**not bold** — just text\n');
  const drawn = JSON.stringify(tree.toJSON());
  expect(drawn).toContain('**not bold**');
  act(() => tree.unmount());
});
