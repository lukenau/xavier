import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Text, View } from 'react-native';
import { resolveToken, useTheme, type Scheme } from '../../../theme/useTheme';
import type { TokenName } from '../../../theme/tokens.gen';
import type {
  ButtonRowWidget as ButtonRowWidgetT,
  CardWidget as CardWidgetT,
  LinkWidget as LinkWidgetT,
  MetricWidget as MetricWidgetT,
  ProgressWidget as ProgressWidgetT,
} from '../../../chat/widget';
import { ButtonRowWidget, DISABLED_OPACITY } from './ButtonRowWidget';
import { CardWidget } from './CardWidget';
import { LinkWidget } from './LinkWidget';
import { MetricWidget } from './MetricWidget';
import { ProgressWidget } from './ProgressWidget';

/** money.test.tsx's idiom: the scheme jest renders under is whatever
 *  useColorScheme() reports here, so read it off a probe render rather than
 *  assuming one. */
let schemeUsed: Scheme | null = null;
function scheme(): Scheme {
  if (!schemeUsed) {
    const captured: Scheme[] = [];
    function Probe() {
      captured.push(useTheme().scheme);
      return null;
    }
    let probe!: TestRenderer.ReactTestRenderer;
    act(() => {
      probe = TestRenderer.create(<Probe />);
    });
    act(() => probe.unmount());
    schemeUsed = captured[0];
  }
  return schemeUsed;
}
const tone = (name: TokenName) => resolveToken(scheme(), name);

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
}

function pressables(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    { deep: false },
  );
}

beforeEach(() => {
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('the card renders its title, subtitle, body and every row', () => {
  const widget: CardWidgetT = {
    kind: 'card',
    title: 'Overnight run',
    subtitle: 'assistant-agent',
    body: 'Two gates opened, one closed flat.',
    rows: [
      { label: 'Filled', value: '3', tone: 'up' },
      { label: 'Slippage', value: '-0.4%', tone: 'down' },
    ],
    tone: 'neutral',
  };
  const rendered = texts(render(<CardWidget widget={widget} />));
  expect(rendered).toContain('Overnight run');
  expect(rendered).toContain('assistant-agent');
  expect(rendered).toContain('Two gates opened, one closed flat.');
  expect(rendered).toContain('Filled');
  expect(rendered).toContain('3');
  expect(rendered).toContain('Slippage');
  expect(rendered).toContain('-0.4%');
});

test('a card row shows its tone as a dot, and keeps the value readable', () => {
  // The tone used to colour the word itself, so a card read "Packages" / a red
  // "down" — the value and its tone saying the same thing twice, in the one
  // colour that is hardest to read (design review, 2026-09-22).
  const widget: CardWidgetT = {
    kind: 'card',
    title: 'Positions',
    subtitle: null,
    body: null,
    rows: [{ label: 'PnL', value: '+$18', tone: 'up' }],
    tone: 'neutral',
  };
  const tree = render(<CardWidget widget={widget} />);
  const value = tree.root.findAllByType(Text).find((n) => n.props.children === '+$18');
  expect(value?.props.style).toContainEqual({ color: tone('fg-1') });
  const dot = tree.root
    .findAllByType(View)
    .find((n) => [n.props.style].flat(Infinity).some((s) => s && s.backgroundColor === tone('status-up')));
  expect(dot).toBeDefined();
});

test('the metric renders value, unit, delta and caption', () => {
  const widget: MetricWidgetT = {
    kind: 'metric',
    label: 'Spend today',
    value: '14.20',
    unit: 'USD',
    delta: '-12%',
    deltaTone: 'down',
    caption: 'vs the 7-day average',
  };
  const tree = render(<MetricWidget widget={widget} />);
  const rendered = texts(tree);
  expect(rendered).toContain('Spend today');
  expect(rendered).toContain('14.20');
  expect(rendered).toContain('USD');
  expect(rendered).toContain('-12%');
  expect(rendered).toContain('vs the 7-day average');
  const delta = tree.root.findAllByType(Text).find((n) => n.props.children === '-12%');
  expect(delta?.props.style).toContainEqual({ color: tone('status-down') });
});

test('a metric with no unit, delta or caption renders the value alone', () => {
  const widget: MetricWidgetT = {
    kind: 'metric',
    label: 'Open threads',
    value: '4',
    unit: null,
    delta: null,
    deltaTone: 'neutral',
    caption: null,
  };
  expect(texts(render(<MetricWidget widget={widget} />))).toEqual(['Open threads', '4']);
});

test('the progress bar fills to value/total and prints the fraction', () => {
  const widget: ProgressWidgetT = {
    kind: 'progress',
    label: 'Backfill',
    value: 25,
    total: 100,
    caption: null,
    tone: 'accent',
  };
  const tree = render(<ProgressWidget widget={widget} />);
  expect(texts(tree)).toContain('Backfill');
  expect(texts(tree)).toContain('25 / 100');
  const fill = tree.root.findAll((n) => typeof n.props.style?.width === 'string', { deep: false })[0];
  expect(fill.props.style.width).toBe('25%');
  expect(fill.props.style.backgroundColor).toBe(tone('accent'));
});

test('the link shows its host and only opens on tap', () => {
  const widget: LinkWidgetT = {
    kind: 'link',
    url: 'https://www.anthropic.com/news/claude',
    title: 'Claude news',
    subtitle: 'anthropic.com',
  };
  const tree = render(<LinkWidget widget={widget} />);
  expect(texts(tree)).toContain('Claude news');
  expect(texts(tree)).toContain('anthropic.com');
  expect(Linking.openURL).not.toHaveBeenCalled();

  act(() => pressables(tree)[0].props.onPress());
  expect(Linking.openURL).toHaveBeenCalledWith('https://www.anthropic.com/news/claude');
});

test('a button row reports the id of the button that was tapped', () => {
  const widget: ButtonRowWidgetT = {
    kind: 'button_row',
    prompt: 'Ship it?',
    buttons: [
      { id: 'yes', label: 'Ship', tone: 'up' },
      { id: 'no', label: 'Hold', tone: 'down' },
    ],
  };
  const onPress = jest.fn();
  const tree = render(<ButtonRowWidget widget={widget} onPress={onPress} />);
  expect(texts(tree)).toContain('Ship it?');
  expect(texts(tree)).toContain('Ship');
  expect(texts(tree)).toContain('Hold');

  act(() => pressables(tree)[1].props.onPress());
  expect(onPress).toHaveBeenCalledWith('no');
});

test('a button row with no handler still renders its buttons, disabled', () => {
  const widget: ButtonRowWidgetT = {
    kind: 'button_row',
    prompt: null,
    buttons: [{ id: 'yes', label: 'Ship', tone: 'up' }],
  };
  const tree = render(<ButtonRowWidget widget={widget} />);
  expect(texts(tree)).toContain('Ship');
  const [button] = pressables(tree);
  expect(button.props.disabled).toBe(true);
  expect(button.props.accessibilityState).toEqual({ disabled: true });
  expect(button.props.style({ pressed: false })).toContainEqual({ opacity: DISABLED_OPACITY });
});
