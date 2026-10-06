// The expanded detail is this port's stand-in for the PWA's bottom sheet, so
// it has to carry the sheet's own chrome: the Browserbase eyebrow, and a
// Close that is not "tap the row again".
import TestRenderer, { act } from 'react-test-renderer';
import { BrowserCard } from './BrowserCard';
import type { BrowserSessions } from '../../lib/types';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

// `mock`-prefixed so jest's out-of-scope guard allows the factory to close
// over it (the documented escape hatch).
let mockPayload: BrowserSessions | null = null;
jest.mock('../../lib/query', () => ({
  QUERY_TUNING: { 'browser-sessions': {} },
  usePoll: () => ({ data: mockPayload }),
}));

const running = (): BrowserSessions => ({
  running: [
    {
      id: 'live-1',
      started_at: new Date().toISOString(),
      region: null,
      live_url: 'https://connect.browserbase.com/devtools/x',
      current_url: 'https://www.nytimes.com/section/world',
      pages: ['https://www.nytimes.com/section/world'],
    },
  ],
  recent: [],
  updated_at: '',
});

// The live-session dot is an Animated timing loop. A tree left mounted keeps
// it running past the test file, which prints an "import after teardown" error
// and force-exits the jest worker on every full run.
const mounted: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((t) => t.unmount());
  });
});

function render(): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<BrowserCard />);
  });
  mounted.push(tree);
  return tree;
}

const pressables = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll((n) => typeof n.props.onPress === 'function');

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


test('no session, no card', () => {
  mockPayload = null;
  expect(render().toJSON()).toBeNull();
});

test('the expanded detail carries the vendor eyebrow and a Close', () => {
  mockPayload = running();
  const tree = render();
  expect(texts(tree)).not.toContain('Browserbase');

  act(() => {
    pressables(tree)[0].props.onPress();
  });
  const open = texts(tree);
  expect(open).toContain('Browserbase');
  expect(open).toContain('Live browser');
  expect(open).toContain('Close');

  // …and Close closes it, rather than a second tap on the row being the only
  // way back (the PWA had Close, a backdrop, Escape and a drag).
  const close = tree.root.findAll((n) => n.props.accessibilityLabel === 'Close')[0];
  act(() => {
    close.props.onPress();
  });
  expect(texts(tree)).not.toContain('Browserbase');
});
