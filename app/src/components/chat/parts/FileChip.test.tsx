// A file in the transcript. Tapping it opens the preview sheet; a file the
// agent could not upload says so rather than pretending to be tappable.
//
// The sheet itself is replaced with a recorder: it fetches bytes and draws a
// WebView, neither of which belongs in this test. What is checked here is what
// the chip hands it — a real part when the chip is tappable, and nothing when
// there are no bytes behind the file, which is the case that matters.
const mockSheetCalls: Array<{ part: unknown }> = [];
jest.mock('./FilePreviewSheet', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    FilePreviewSheet: (props: { part: unknown }) => {
      mockSheetCalls.push(props);
      return props.part ? React.createElement(Text, { accessibilityLabel: 'file-preview-sheet' }, 'preview') : null;
    },
  };
});

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { extensionOf, FileChip } from './FileChip';

function render(part: Parameters<typeof FileChip>[0]['part']): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<FileChip part={part} />);
  });
  return tree;
}
const button = (tree: TestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAll((n) => n.props.accessibilityLabel === label)[0];
const texts = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string');

beforeEach(() => {
  mockSheetCalls.length = 0;
});

it('shows the name, the type and the size', () => {
  const tree = render({ type: 'file', name: 'report.pdf', mime: 'application/pdf', media_id: 'med_1', size_bytes: 2_500_000 });
  expect(texts(tree)).toEqual(expect.arrayContaining(['PDF', 'report.pdf', '2.5 MB']));
});

it('opens the preview when it is tapped, rather than the share sheet', async () => {
  const part = { type: 'file' as const, name: 'report.pdf', mime: 'application/pdf', media_id: 'med_1' };
  const tree = render(part);
  expect(mockSheetCalls.every((call) => !call.part)).toBe(true);
  await act(async () => button(tree, 'Open report.pdf').props.onPress());
  expect(mockSheetCalls.some((call) => call.part === part)).toBe(true);
});

it('is not tappable, and says why, when there are no bytes in the Hub', async () => {
  const tree = render({ type: 'file', name: 'big.zip', mime: 'application/zip' });
  expect(button(tree, 'big.zip').props.disabled).toBe(true);
  expect(texts(tree)).toContain('not stored in the Hub');
  await act(async () => button(tree, 'big.zip').props.onPress());
  expect(mockSheetCalls.every((call) => !call.part)).toBe(true);
});

it('names a file by its extension, or says FILE', () => {
  expect(extensionOf('a.pdf')).toBe('PDF');
  expect(extensionOf('archive.tar.gz')).toBe('GZ');
  expect(extensionOf('Makefile')).toBe('FILE');
  expect(extensionOf('.hidden')).toBe('FILE');
  expect(extensionOf('weird.longextension')).toBe('FILE');
});
