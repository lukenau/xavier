// The one refresh control. Its rules are easy to get subtly wrong — and were,
// in the six page-local copies this replaced: the age label must come from the
// OLDEST query (never the freshest, or it overstates freshness), one query must
// be accepted unwrapped (one copy took only that shape), and the press must dim
// (that same copy dropped the PWA's `active:opacity-70` entirely).
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { ageLabel, RefreshControl } from './RefreshControl';
import { PRESSED_OPACITY } from './Card';

// The spinner is an Animated.loop: an un-unmounted tree keeps a timer, and the
// whole jest run, alive after the assertions pass.
const mounted: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((r) => r.unmount());
  });
});

const query = (over: Partial<{ isFetching: boolean; dataUpdatedAt: number }> = {}) => ({
  isFetching: false,
  dataUpdatedAt: Date.now(),
  refetch: jest.fn(),
  ...over,
});

function render(node: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(node);
  });
  mounted.push(renderer);
  return renderer;
}

const label = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType(Text).map((n) => String(n.props.children))[0];

describe('ageLabel', () => {
  const now = 1_757_000_000_000;
  test('nothing loaded yet reads as nothing at all, not "now"', () => {
    expect(ageLabel(0, now)).toBe('');
  });
  test('the four bands', () => {
    expect(ageLabel(now - 5_000, now)).toBe('now');
    expect(ageLabel(now - 45_000, now)).toBe('45s');
    expect(ageLabel(now - 20 * 60_000, now)).toBe('20m');
    expect(ageLabel(now - 5 * 3600_000, now)).toBe('5h');
  });
});

test('the label is the age of the OLDEST query, never the freshest', () => {
  const now = Date.now();
  const r = render(
    <RefreshControl
      queries={[query({ dataUpdatedAt: now - 1000 }), query({ dataUpdatedAt: now - 40 * 60_000 })]}
    />,
  );
  expect(label(r)).toBe('40m');
});

test('a tap refetches every query on the page', () => {
  const a = query();
  const b = query();
  const r = render(<RefreshControl queries={[a, b]} />);
  const button = r.root.findAll(
    (n) => typeof n.props?.onPress === 'function' && n.props.accessibilityLabel === 'Refresh',
  )[0];
  act(() => button.props.onPress());
  expect(a.refetch).toHaveBeenCalledTimes(1);
  expect(b.refetch).toHaveBeenCalledTimes(1);
});

test('a single query is accepted unwrapped, not only as an array', () => {
  const one = query({ dataUpdatedAt: Date.now() - 90 * 60_000 });
  const r = render(<RefreshControl queries={one} />);
  expect(label(r)).toBe('1h');
  const button = r.root.findAll(
    (n) => typeof n.props?.onPress === 'function' && n.props.accessibilityLabel === 'Refresh',
  )[0];
  act(() => button.props.onPress());
  expect(one.refetch).toHaveBeenCalledTimes(1);
});

test('the press dims, as every other control does (one old copy did not)', () => {
  const r = render(<RefreshControl queries={query()} />);
  const button = r.root.findAll(
    (n) => typeof n.props?.style === 'function' && n.props.accessibilityLabel === 'Refresh',
  )[0];
  const flat = (pressed: boolean) =>
    Object.assign({}, ...[button.props.style({ pressed })].flat(2).filter(Boolean));
  expect(flat(false).opacity).toBeUndefined();
  expect(flat(true).opacity).toBe(PRESSED_OPACITY);
});
