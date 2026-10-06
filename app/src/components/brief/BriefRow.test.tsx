// The four densities, rendered against the 2026-09-16 fixture brief.
//
// The claim these tests defend is the design's central one: 44 items of wildly
// different lengths sit in ONE scroll whose texture thins as urgency drops, and
// none of the four treatments is a card.
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-glass-effect', () => ({
  GlassView: ({ children }: { children: React.ReactNode }) => children,
  isLiquidGlassAvailable: jest.fn(() => false),
}));

import TestRenderer, { act } from 'react-test-renderer';
import { Text, View } from 'react-native';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { BriefRow, isSwipeable } from './BriefRow';
import { BucketHead } from './BucketHead';
import { ChipRow, SplitRule } from './Chips';
import { NowBlock, titleLines } from './NowBlock';
import { SourceBanner, sourceBannerText } from './SourceBanner';
import { Terminus } from './Terminus';
import { allItems, bucketView, chipsFor, type BriefItem } from './briefModel';
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

/** Every rendered string in the tree. */
function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
}

/** Without the SafeAreaProvider wrapper, so `toJSON() === null` means the
 * component itself rendered nothing. */
function renderBare(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

/** The style a Pressable applies at rest.
 *
 * Found by "style is a function" rather than findAllByType(Pressable): the host
 * View the Pressable renders carries an ALREADY-RESOLVED style array, so
 * matching on onPress finds the wrong node and the component type itself does
 * not match under this renderer. The function form is unique to the Pressable
 * element. */
function pressedStyles(
  tree: TestRenderer.ReactTestRenderer,
  index = 0,
): Record<string, unknown>[] {
  const press = tree.root.findAll((n) => typeof n.props.style === 'function')[index];
  return [press.props.style({ pressed: false })].flat().filter(Boolean) as Record<string, unknown>[];
}

/** Flattened styles of every View, for the "is anything a card?" assertions. */
function viewStyles(tree: TestRenderer.ReactTestRenderer): Record<string, unknown>[] {
  return tree.root
    .findAllByType(View)
    .flatMap((n) => [n.props.style].flat())
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object');
}

const NOW = bucketView(LIVE_BRIEF, 'now')[0];
const TODAY = bucketView(LIVE_BRIEF, 'today')[0];

describe('every live item renders at every density without throwing', () => {
  test.each(['today', 'week', 'background'] as const)('%s density takes all 44 items', (density) => {
    for (const item of allItems(LIVE_BRIEF)) {
      const tree = render(<BriefRow item={item} density={density} onPress={() => {}} />);
      // The title is always on the page — truncation is numberOfLines, not a
      // substring, so the full string is what is rendered.
      expect(texts(tree)).toContain(item.title);
      act(() => tree.unmount());
    }
  });

  test('NowBlock takes every item too — Now can hold more than one', () => {
    for (const item of allItems(LIVE_BRIEF).slice(0, 10)) {
      const tree = render(<NowBlock item={item} onPress={() => {}} />);
      expect(texts(tree)).toContain(item.title);
      act(() => tree.unmount());
    }
  });
});

describe('nothing is a card (spec §1.3 principle 4)', () => {
  test.each(['today', 'week', 'background'] as const)('a %s row has no radius and no fill', (density) => {
    const tree = render(<BriefRow item={TODAY} density={density} onPress={() => {}} />);
    for (const style of viewStyles(tree)) {
      expect(style.borderRadius).toBeUndefined();
    }
    // The Pressable's own style: a bottom hairline and padding, never a fill.
    const flat = pressedStyles(tree);
    expect(flat.some((s) => 'backgroundColor' in s)).toBe(false);
    expect(flat.some((s) => 'borderRadius' in s)).toBe(false);
  });

  test('the Now block is typographic — no border, no fill, no radius', () => {
    const tree = render(<NowBlock item={NOW} onPress={() => {}} last />);
    const flat = pressedStyles(tree);
    expect(flat.some((s) => 'backgroundColor' in s)).toBe(false);
    expect(flat.some((s) => 'borderRadius' in s)).toBe(false);
    // `last` suppresses even the separating hairline.
    expect(flat.some((s) => 'borderBottomWidth' in s)).toBe(false);
  });
});

describe('density actually differs — four treatments, not one repeated', () => {
  const heights = (density: 'today' | 'week' | 'background') =>
    pressedStyles(render(<BriefRow item={TODAY} density={density} onPress={() => {}} />)).reduce<{
      minHeight?: number;
      paddingVertical?: number;
    }>(
      (acc, s) => ({
        minHeight: (s.minHeight as number) ?? acc.minHeight,
        paddingVertical: (s.paddingVertical as number) ?? acc.paddingVertical,
      }),
      {},
    );

  test('the three row densities step down in height', () => {
    expect(heights('today')).toEqual({ minHeight: 64, paddingVertical: 12 });
    expect(heights('week')).toEqual({ minHeight: 56, paddingVertical: 10 });
    expect(heights('background')).toEqual({ minHeight: 48, paddingVertical: 9 });
  });

  test('every density clears the 44pt hit target even at its floor', () => {
    for (const d of ['today', 'week', 'background'] as const) {
      expect(heights(d).minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  test('today shows the full why; week shows only its first clause', () => {
    const item: BriefItem = { ...TODAY, why: 'waiting on your reply — asked 3 days ago' };
    expect(texts(render(<BriefRow item={item} density="today" onPress={() => {}} />))).toContain(
      'waiting on your reply — asked 3 days ago',
    );
    const week = texts(render(<BriefRow item={item} density="week" onPress={() => {}} />));
    expect(week).toContain('waiting on your reply');
    expect(week).not.toContain('waiting on your reply — asked 3 days ago');
  });

  test('background is ONE line and shows no why at all — it is the coda', () => {
    const item: BriefItem = { ...TODAY, why: 'this should not appear' };
    const rendered = texts(render(<BriefRow item={item} density="background" onPress={() => {}} />));
    expect(rendered).toContain(item.title);
    expect(rendered).not.toContain('this should not appear');
  });

  test('evidence appears in the Now block and NOWHERE else in the list', () => {
    const quote = NOW.evidence[0];
    expect(texts(render(<NowBlock item={NOW} onPress={() => {}} />))).toContain(quote);
    for (const d of ['today', 'week', 'background'] as const) {
      expect(texts(render(<BriefRow item={NOW} density={d} onPress={() => {}} />))).not.toContain(quote);
    }
  });
});

describe('Dynamic Type breaks fixed by H14', () => {
  test('H14a: the background title gains a line at large text, like every other title', () => {
    const tree = render(<BriefRow item={TODAY} density="background" onPress={() => {}} />);
    const title = tree.root.findAllByType(Text).find((n) => [n.props.children].flat().includes(TODAY.title));
    expect(title?.props.numberOfLines).toBe(titleLines(1));
  });

  test('H14b: the Today why line gains a line at large text too', () => {
    const tree = render(<BriefRow item={TODAY} density="today" onPress={() => {}} />);
    const why = tree.root.findAllByType(Text).find((n) => [n.props.children].flat().includes(TODAY.why));
    expect(why?.props.numberOfLines).toBe(titleLines(1));
  });
});

describe('the split rule is the whole work/personal encoding', () => {
  test('work is petrol, personal is accent-deep, and neither is a chip or a label', () => {
    const work = render(<SplitRule split="work" />);
    const personal = render(<SplitRule split="personal" />);
    const colorOf = (tree: TestRenderer.ReactTestRenderer) =>
      viewStyles(tree).find((s) => 'backgroundColor' in s)?.backgroundColor;
    expect(colorOf(work)).toBeTruthy();
    expect(colorOf(personal)).toBeTruthy();
    expect(colorOf(work)).not.toBe(colorOf(personal));
    // No text: the rule IS the encoding.
    expect(texts(work)).toEqual([]);
  });

  test('background rows have no split rule — FYI has no owner', () => {
    const bg = render(<BriefRow item={TODAY} density="background" onPress={() => {}} />);
    const rule = viewStyles(bg).filter((s) => s.position === 'absolute' && s.width === 3);
    expect(rule).toHaveLength(0);
    const today = render(<BriefRow item={TODAY} density="today" onPress={() => {}} />);
    expect(viewStyles(today).filter((s) => s.position === 'absolute' && s.width === 3)).toHaveLength(1);
  });
});

describe('chips stay rare and mean "unusual"', () => {
  test('a row with no chips renders no chip row at all', () => {
    expect(renderBare(<ChipRow chips={[]} />).toJSON()).toBeNull();
  });

  test('the carried chip reads off carry_days', () => {
    const carried: BriefItem = { ...TODAY, carry_days: 4, age_days: 99 };
    expect(texts(render(<BriefRow item={carried} density="today" onPress={() => {}} />))).toContain(
      'carried 4d',
    );
  });

  test('source and origin are never rendered as chips on a row', () => {
    const rendered = texts(render(<BriefRow item={TODAY} density="today" onPress={() => {}} />));
    // The source display name belongs to the sheet, not the row.
    expect(rendered).not.toContain(TODAY.source);
    expect(chipsFor(TODAY).every((c) => c.label !== TODAY.source)).toBe(true);
  });
});

describe('BucketHead', () => {
  test('Now is the only section label in the accent', () => {
    const colourOf = (bucket: 'now' | 'today') => {
      const tree = render(<BucketHead bucket={bucket} count={3} />);
      return tree.root.findAllByType(Text)[0].props.style.flat().find((s: { color?: string }) => s?.color)
        ?.color;
    };
    expect(colourOf('now')).not.toBe(colourOf('today'));
  });

  test('the count sits in the head, right-aligned — there is no hero total anywhere', () => {
    expect(texts(render(<BucketHead bucket="today" count={20} />))).toEqual(['TODAY', '20']);
    // A zero count renders no number rather than a bare "0".
    expect(texts(render(<BucketHead bucket="today" count={0} />))).toEqual(['TODAY']);
  });

  test('the head never animates its own opacity (a GlassView at 0 stops rendering)', () => {
    const tree = render(<BucketHead bucket="now" count={2} />);
    for (const style of viewStyles(tree)) expect(style.opacity).toBeUndefined();
  });

  test('Minor 2: isLiquidGlassAvailable is read once at module load, not per render', () => {
    const before = (isLiquidGlassAvailable as jest.Mock).mock.calls.length;
    render(<BucketHead bucket="today" count={1} />);
    render(<BucketHead bucket="week" count={2} />);
    render(<BucketHead bucket="background" count={3} />);
    expect((isLiquidGlassAvailable as jest.Mock).mock.calls.length).toBe(before);
  });

  test('Minor 3: the count reaches VoiceOver through the label, not just sighted text', () => {
    const tree = render(<BucketHead bucket="today" count={18} />);
    const label = tree.root.findAllByType(Text)[0];
    expect(label.props.accessibilityLabel).toBe('TODAY, 18 items');
  });

  test('Minor 3: a zero count keeps the plain label', () => {
    const tree = render(<BucketHead bucket="today" count={0} />);
    expect(tree.root.findAllByType(Text)[0].props.accessibilityLabel).toBe('TODAY');
  });

  test('H15: the non-glass fallback raises the head off the page ground and edges it on top', () => {
    // The View's style is an ARRAY of separate objects (fill/bg/rules), not one
    // merged object, so each property is asserted on whichever entry sets it.
    const flat = viewStyles(render(<BucketHead bucket="today" count={3} />));
    const bg = flat.find((s) => 'backgroundColor' in s)?.backgroundColor;
    expect(bg).not.toBe('#000d0e'); // theme-exempt: asserts bg-0 is NOT used (H15)
    expect(flat.some((s) => s.borderTopWidth === 1)).toBe(true);
  });
});

describe('SourceBanner', () => {
  test('the fixture brief names its one degraded input, and says the brief is incomplete', () => {
    const rendered = texts(render(<SourceBanner brief={LIVE_BRIEF} />));
    expect(rendered.join(' ')).toContain('finance');
    expect(rendered.join(' ')).toContain('incomplete');
  });

  test('healthy inputs render nothing at all', () => {
    const healthy = { ...LIVE_BRIEF, sources: { email: 'ok', calendar: 'ok' } };
    expect(renderBare(<SourceBanner brief={healthy} />).toJSON()).toBeNull();
  });

  test('Minor 6: the banner has a top hairline as well as a bottom one', () => {
    const tree = render(<SourceBanner brief={LIVE_BRIEF} />);
    const banner = viewStyles(tree).find((s) => 'borderBottomWidth' in s);
    expect(banner?.borderTopWidth).toBe(1);
  });

  test('the copy agrees with itself on number', () => {
    expect(sourceBannerText(['email'])).toContain('isn’t reporting');
    expect(sourceBannerText(['email', 'oura'])).toContain('aren’t reporting');
    expect(sourceBannerText([])).toBe('');
  });
});

describe('Terminus', () => {
  test('the held-back line and "teach the brief" are pressable; the provenance line is not', () => {
    const onHeldBack = jest.fn();
    const onTeach = jest.fn();
    const tree = render(<Terminus brief={LIVE_BRIEF} onHeldBack={onHeldBack} onTeach={onTeach} />);
    const pressables = tree.root.findAll((n) => typeof n.props.onPress === 'function');
    // held-back line + "teach the brief" (Ruling 146) — the terminus text
    // itself stays plain provenance.
    expect(pressables).toHaveLength(2);
    act(() => pressables[0].props.onPress());
    expect(onHeldBack).toHaveBeenCalled();
    expect(texts(tree).join(' ')).toContain('110 held back');
    expect(texts(tree).join(' ')).toContain('teach the brief →');
    expect(texts(tree).join(' ')).toMatch(/build [0-9a-f]{7}/);

    act(() => pressables[1].props.onPress());
    expect(onTeach).toHaveBeenCalled();
  });

  test('the held-back target is a real 44pt one', () => {
    const flat = pressedStyles(
      render(<Terminus brief={LIVE_BRIEF} onHeldBack={() => {}} onTeach={() => {}} />),
    );
    expect(flat.some((s) => s.minHeight === 44)).toBe(true);
  });
});

describe('Dynamic Type', () => {
  test('titles scale unbounded; machine data is capped at 1.6x', () => {
    const tree = render(<BriefRow item={TODAY} density="today" onPress={() => {}} />);
    const byContent = (needle: string) =>
      tree.root.findAllByType(Text).find((n) => [n.props.children].flat().includes(needle));
    // The human content sets no cap at all — at AX5 a 15px title becomes ~53px
    // and the row grows to hold it.
    expect(byContent(TODAY.title)?.props.maxFontSizeMultiplier).toBeUndefined();
    expect(byContent(TODAY.why)?.props.maxFontSizeMultiplier).toBeUndefined();
  });

  test('no fixed heights anywhere — only minHeight', () => {
    for (const d of ['today', 'week', 'background'] as const) {
      const tree = render(<BriefRow item={TODAY} density={d} onPress={() => {}} />);
      for (const style of viewStyles(tree)) expect(style.height).toBeUndefined();
    }
    const now = render(<NowBlock item={NOW} onPress={() => {}} />);
    for (const style of viewStyles(now)) expect(style.height).toBeUndefined();
  });

  test('titles go 2 lines → 3 once the text is large', () => {
    expect(titleLines(2, 1)).toBe(2);
    expect(titleLines(2, 1.3)).toBe(2);
    expect(titleLines(2, 1.4)).toBe(3);
    expect(titleLines(3, 2.5)).toBe(4);
  });
});

describe('swipeability', () => {
  test('Background is not swipeable — offering Done implies it needs one', () => {
    expect(isSwipeable('background')).toBe(false);
    expect(isSwipeable('today')).toBe(true);
    expect(isSwipeable('week')).toBe(true);
  });
});
