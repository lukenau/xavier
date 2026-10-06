// Live's entry card, rendered for real: the words that reach the screen and
// the route it opens. Pixels are not checked here; text and props
// are.
import TestRenderer, { act } from 'react-test-renderer';
import { LiveEntryCard } from './LiveEntryCard';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// expo-symbols renders a native view; the card's text is what is under test.
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router } = require('expo-router') as { router: { push: jest.Mock } };

/** Rendered text NODES only — not props, so an accessibilityLabel carrying
 * the same word cannot stand in for a title that has actually changed. */
function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out;
}

beforeEach(() => router.push.mockClear());

test('the card is titled Live and says what it is for', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<LiveEntryCard />);
  });
  expect(texts(tree)).toEqual(['Live', 'hands-free voice · walk around, talk, listen', 'new session']);
});

test('tapping it opens the Live page', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<LiveEntryCard />);
  });
  // RN's Pressable is a forwardRef wrapper, so match on the handler rather
  // than the component identity.
  const pressable = tree.root.findAll((n) => typeof n.props.onPress === 'function')[0];
  act(() => {
    pressable.props.onPress();
  });
  expect(router.push).toHaveBeenCalledWith('/live');
});

test('the new-session control opens the Live page on a fresh thread', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<LiveEntryCard />);
  });
  const startNew = tree.root.findByProps({ accessibilityLabel: 'Start a new Live session' });
  act(() => {
    startNew.props.onPress();
  });
  expect(router.push).toHaveBeenCalledWith('/live?fresh=1');
});
