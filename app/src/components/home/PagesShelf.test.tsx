// The shelf's two destinations and its one failure path. `manage →` had been
// pointing at the wrong route, and a card whose slug will not resolve used to
// do nothing at all — both are behaviours no pure-logic test can see.
import TestRenderer, { act } from 'react-test-renderer';
import { PagesShelf } from './PagesShelf';
import type { MyPage } from '../../lib/types';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../briefs', () => ({ openBrief: jest.fn(), resolveBriefUri: jest.fn() }));

const { router } = require('expo-router') as { router: { push: jest.Mock } };
const briefs = require('../briefs') as { openBrief: jest.Mock; resolveBriefUri: jest.Mock };

const page = (over: Partial<MyPage> = {}): MyPage => ({
  slug: 'briefing-2026-09-10',
  title: 'Daily briefing',
  mtime: null,
  kind: 'brief',
  ...over,
});

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

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

/** Pressables in render order; RN's is a forwardRef wrapper, so match the handler. */
const pressables = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll((n) => typeof n.props.onPress === 'function');

beforeEach(() => {
  router.push.mockClear();
  briefs.openBrief.mockClear();
  briefs.resolveBriefUri.mockReset();
});

test('an empty library hides the shelf entirely', () => {
  expect(render(<PagesShelf pages={[]} />).toJSON()).toBeNull();
  expect(render(<PagesShelf pages={undefined} />).toJSON()).toBeNull();
});

test('`manage →` opens the Pages config page, not the Config root', () => {
  const tree = render(<PagesShelf pages={[page()]} />);
  act(() => {
    pressables(tree)[0].props.onPress();
  });
  expect(router.push).toHaveBeenCalledWith('/config/pages');
});

test('a card opens the reader with its resolved URL', () => {
  briefs.resolveBriefUri.mockReturnValue('https://hub.example/my-pages/briefing-2026-09-10/');
  const tree = render(<PagesShelf pages={[page()]} />);
  act(() => {
    pressables(tree)[1].props.onPress();
  });
  expect(briefs.resolveBriefUri).toHaveBeenCalledWith('/my-pages/briefing-2026-09-10/');
  expect(briefs.openBrief).toHaveBeenCalledWith(
    'https://hub.example/my-pages/briefing-2026-09-10/',
    'Daily briefing',
  );
});

test('a slug that will not resolve says so rather than doing nothing', () => {
  briefs.resolveBriefUri.mockReturnValue(null);
  const tree = render(<PagesShelf pages={[page({ title: 'Odd page' })]} />);
  act(() => {
    pressables(tree)[1].props.onPress();
  });
  expect(briefs.openBrief).not.toHaveBeenCalled();
  expect(texts(tree).join('')).toContain('“Odd page” — that page isn’t on the hub');
});
