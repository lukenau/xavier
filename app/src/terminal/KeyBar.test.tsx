import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { KeyBar } from './KeyBar';
import { KEYS, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, TMUX_KEYS } from './keys';

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

/** Rendered text nodes only — a chip is identified by what a thumb can read. */
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

function chip(tree: TestRenderer.ReactTestRenderer, label: string) {
  const hit = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => n.findAllByType(Text).some((inner) => `${inner.props.children}` === label));
  if (!hit) throw new Error(`no chip labelled ${label}`);
  return hit;
}

let tree: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

test('renders the ⌘ chip, every key chip, the tmux chips and the copy-mode toggle', () => {
  const onKey = jest.fn();
  tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);

  expect(texts(tree)).toEqual([
    '⌘',
    ...KEYS.map((k) => k.label),
    ...TMUX_KEYS.map((k) => k.label),
    'scroll',
  ]);
});

test('every chip sends its own byte sequence', () => {
  const onKey = jest.fn();
  tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);

  for (const key of [...KEYS, ...TMUX_KEYS]) {
    onKey.mockClear();
    act(() => chip(tree!, key.label).props.onPress());
    expect(onKey.mock.calls).toEqual([[key.seq]]);
  }
});

test('⌘ opens Runbooks and sends nothing to the pty', () => {
  const onKey = jest.fn();
  const onRunbooks = jest.fn();
  tree = render(<KeyBar onKey={onKey} onRunbooks={onRunbooks} />);

  act(() => chip(tree!, '⌘').props.onPress());

  expect(onRunbooks).toHaveBeenCalledTimes(1);
  expect(onKey).not.toHaveBeenCalled();
});

describe('the copy-mode toggle', () => {
  test('enters with C-b [ and leaves with q, flipping its own label', () => {
    const onKey = jest.fn();
    tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);

    act(() => chip(tree!, 'scroll').props.onPress());
    expect(onKey.mock.calls).toEqual([['\x02[']]);
    expect(texts(tree)).toContain('exit');
    expect(texts(tree)).not.toContain('scroll');

    act(() => chip(tree!, 'exit').props.onPress());
    expect(onKey.mock.calls).toEqual([['\x02['], ['q']]);
    expect(texts(tree)).toContain('scroll');
  });
});

describe('hold-to-repeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a quick tap on an arrow sends exactly once', () => {
    const onKey = jest.fn();
    tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);
    const up = chip(tree, '↑');

    act(() => up.props.onPressIn());
    act(() => jest.advanceTimersByTime(REPEAT_DELAY_MS - 1));
    act(() => up.props.onPressOut());
    act(() => up.props.onPress());

    expect(onKey.mock.calls).toEqual([['\x1b[A']]);
  });

  test('holding past 350ms fires every 70ms', () => {
    const onKey = jest.fn();
    tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);
    const left = chip(tree, '←');

    act(() => left.props.onPressIn());
    act(() => jest.advanceTimersByTime(REPEAT_DELAY_MS));
    expect(onKey).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(REPEAT_INTERVAL_MS * 3));
    expect(onKey.mock.calls).toEqual([['\x1b[D'], ['\x1b[D'], ['\x1b[D']]);
  });

  test('releasing stops the repeat and swallows the trailing press', () => {
    const onKey = jest.fn();
    tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);
    const down = chip(tree, '↓');

    act(() => down.props.onPressIn());
    act(() => jest.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS));
    act(() => down.props.onPressOut());
    act(() => down.props.onPress());
    act(() => jest.advanceTimersByTime(1000));

    // One from the repeat run; the trailing press is swallowed, and nothing
    // fires after release.
    expect(onKey.mock.calls).toEqual([['\x1b[B']]);
  });

  test('the press AFTER a swallowed one sends again', () => {
    const onKey = jest.fn();
    tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);
    const right = chip(tree, '→');

    act(() => right.props.onPressIn());
    act(() => jest.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS));
    act(() => right.props.onPressOut());
    act(() => right.props.onPress());
    onKey.mockClear();

    act(() => right.props.onPressIn());
    act(() => right.props.onPressOut());
    act(() => right.props.onPress());

    expect(onKey.mock.calls).toEqual([['\x1b[C']]);
  });

  test('a repeat run cannot outlive the screen', () => {
    const onKey = jest.fn();
    tree = render(<KeyBar onKey={onKey} onRunbooks={jest.fn()} />);
    act(() => chip(tree!, '↑').props.onPressIn());

    act(() => tree!.unmount());
    tree = null;
    act(() => jest.advanceTimersByTime(5000));

    expect(onKey).not.toHaveBeenCalled();
  });

  test('non-repeating chips have no hold handlers at all', () => {
    tree = render(<KeyBar onKey={jest.fn()} onRunbooks={jest.fn()} />);
    expect(chip(tree, 'esc').props.onPressIn).toBeUndefined();
    expect(chip(tree, '⊞').props.onPressIn).toBeUndefined();
  });
});
