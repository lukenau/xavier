// A picture in the transcript: drawn to fit without cropping, and tappable to
// open it full size. The viewer is recorded rather than rendered — it draws a
// full-screen Modal, which is not what this test is about.
const mockViewerUris: Array<string | null> = [];
jest.mock('./ImageViewer', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    ImageViewer: (props: { uri: string | null }) => {
      mockViewerUris.push(props.uri);
      return props.uri ? React.createElement(Text, { accessibilityLabel: 'image-viewer' }, 'full') : null;
    },
  };
});

import TestRenderer, { act } from 'react-test-renderer';
import { Image as RNImage, StyleSheet, Text } from 'react-native';
import { ImagePart, imageBox } from './ImagePart';

function render(part: Parameters<typeof ImagePart>[0]['part']): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ImagePart part={part} />);
  });
  return tree;
}
const button = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll((n) => n.props.accessibilityLabel === 'Image in the conversation')[0];
const texts = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string');

beforeEach(() => {
  mockViewerUris.length = 0;
});

it('keeps the picture proportions inside the box, so nothing is squashed', () => {
  expect(imageBox(1000, 500)).toEqual({ width: 320, height: 160 }); // wide: limited by width
  expect(imageBox(500, 1000)).toEqual({ width: 210, height: 420 }); // tall: limited by height
  expect(imageBox(undefined, undefined)).toEqual({ width: 320, height: 240 }); // nothing to go on
});

it('draws the picture uncropped', () => {
  const tree = render({ type: 'image', media_id: 'med_1', width: 1000, height: 500 });
  const drawn = tree.root.findAllByType(RNImage)[0];
  expect(drawn.props.resizeMode).toBe('contain');
  const flat = StyleSheet.flatten(drawn.props.style) as { width?: number; height?: number };
  expect([flat.width, flat.height]).toEqual([320, 160]);
});

it('opens the full-size view when it is tapped', async () => {
  const tree = render({ type: 'image', media_id: 'med_1' });
  expect(mockViewerUris.every((uri) => !uri)).toBe(true);
  await act(async () => button(tree).props.onPress());
  expect(mockViewerUris.some((uri) => Boolean(uri))).toBe(true);
});

it('says so when there is no image to draw', () => {
  const tree = render({ type: 'image' });
  expect(texts(tree)).toContain('Image unavailable');
  expect(button(tree)).toBeUndefined();
});
