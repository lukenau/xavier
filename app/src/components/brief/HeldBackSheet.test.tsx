// H16: closed builds nothing at all — not "built and thrown away".
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { HeldBackSheet } from './HeldBackSheet';
import { LIVE_BRIEF } from './liveBrief.fixture';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  });
  return tree;
}

test('closed renders nothing at all', () => {
  const tree = render(<HeldBackSheet brief={LIVE_BRIEF} visible={false} onClose={() => {}} />);
  // The SafeAreaProvider wrapper itself always renders something; HeldBackSheet
  // returning null means IT contributed nothing under it.
  expect(tree.root.findAllByType(HeldBackSheet)[0].children).toEqual([]);
});

test('open renders the held-back groups', () => {
  const tree = render(<HeldBackSheet brief={LIVE_BRIEF} visible onClose={() => {}} />);
  expect(tree.toJSON()).not.toBeNull();
  const texts = tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string');
  expect(texts.join(' ')).toContain('held back');
});
