// The two sheets. The sheet is the primary target for every row, so what it
// renders — and what it refuses to open — is the substance of §7 and §11.4.
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../briefs', () => ({ openBrief: jest.fn(), resolveBriefUri: jest.fn() }));

import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Text, TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { HeldBackSheet, groupDeferred } from './HeldBackSheet';
import { ItemSheet, followTarget } from './ItemSheet';
import { bucketView, linkTarget, type BriefItem } from './briefModel';
import { LIVE_BRIEF } from './liveBrief.fixture';
import type { UseBriefActions } from './useBriefActions';

const { router } = require('expo-router') as { router: { push: jest.Mock } };
const briefs = require('../briefs') as { openBrief: jest.Mock; resolveBriefUri: jest.Mock };

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function actionsStub(over: Partial<UseBriefActions> = {}): UseBriefActions {
  return {
    rowState: () => ({
      phase: 'idle', failure: null, undoLabel: '', action: null, explained: false,
    }),
    openRail: jest.fn(),
    closeRail: jest.fn(),
    armDone: jest.fn(),
    disarmAll: jest.fn(),
    onArmThreshold: jest.fn(),
    dismiss: jest.fn(),
    snooze: jest.fn(),
    undo: jest.fn(),
    markUseful: jest.fn(async () => true),
    explain: jest.fn(),
    noteItem: jest.fn(async () => true),
    rotorActions: () => [],
    onRotorAction: jest.fn(),
    ...over,
  };
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
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

function button(tree: TestRenderer.ReactTestRenderer, label: string) {
  const found = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

const ITEM = bucketView(LIVE_BRIEF, 'today')[0];

beforeEach(() => {
  jest.clearAllMocks();
  briefs.resolveBriefUri.mockReset();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

describe('ItemSheet body', () => {
  test('renders why, detail, every evidence quote and the meta line', () => {
    const item: BriefItem = {
      ...ITEM,
      why: 'because you said so',
      detail: 'the longer story',
      evidence: ['quote one', 'quote two'],
    };
    const rendered = texts(render(<ItemSheet item={item} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />));
    expect(rendered).toContain(item.title);
    expect(rendered).toContain('because you said so');
    expect(rendered).toContain('the longer story');
    expect(rendered).toContain('quote one');
    expect(rendered).toContain('quote two');
    // The eyebrow is the source, uppercased by DetailSheet's own style.
    expect(rendered).toContain(item.source);
  });

  test('a brief with no `detail` simply omits it — the client never invents one', () => {
    const { detail: _drop, ...rest } = ITEM;
    const rendered = texts(
      render(<ItemSheet item={rest as BriefItem} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />),
    );
    expect(rendered).toContain(rest.title);
    expect(rendered).not.toContain('undefined');
  });

  test('a degraded source shows as the sheet status, not as a chip', () => {
    const finance: BriefItem = { ...ITEM, origin: 'finance' };
    expect(texts(render(<ItemSheet item={finance} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />))).toContain(
      'finance is degraded',
    );
    expect(texts(render(<ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />))).not.toContain(
      `${ITEM.origin} is degraded`,
    );
  });

  test('closed renders no item content at all', () => {
    expect(texts(render(<ItemSheet item={null} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />))).toEqual([]);
  });
});

describe('the sheet action row', () => {
  test('Useful, Snooze and Done all reach the real action hook', async () => {
    const actions = actionsStub();
    const onClose = jest.fn();
    const tree = render(<ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={onClose} onOpenRelated={() => {}} actions={actions} />);

    await act(async () => button(tree, 'Useful').props.onPress());
    expect(actions.markUseful).toHaveBeenCalledWith(ITEM);

    act(() => button(tree, 'Snooze 3 days').props.onPress());
    expect(actions.snooze).toHaveBeenCalledWith(ITEM, '3d');
    act(() => button(tree, 'Done').props.onPress());
    expect(actions.dismiss).toHaveBeenCalledWith(ITEM);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('Useful says what it did — a silent tap is what "the buttons didn’t work" felt like', async () => {
    const tree = render(<ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />);
    await act(async () => button(tree, 'Useful').props.onPress());
    expect(texts(tree).join(' ')).toContain('Noted');
  });

  test('a failed Useful says so rather than claiming success', async () => {
    const actions = actionsStub({ markUseful: jest.fn(async () => false) });
    const tree = render(<ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actions} />);
    await act(async () => button(tree, 'Useful').props.onPress());
    expect(texts(tree).join(' ')).toContain('Couldn’t send that');
    expect(texts(tree).join(' ')).not.toContain('Noted');
  });

  test('every action target is at least 44pt', () => {
    const tree = render(<ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />);
    for (const label of ['Useful', 'Snooze 3 days', 'Done']) {
      // Pressable's style is the FUNCTION form here, so it has to be called
      // before it is anything to assert on.
      const style = button(tree, label).props.style;
      const flat = [typeof style === 'function' ? style({ pressed: false }) : style]
        .flat(Infinity)
        .filter(Boolean);
      expect(flat.some((s: Record<string, unknown>) => s?.minHeight === 44)).toBe(true);
    }
  });
});

describe('the note field — "tell the brief about this" (Ruling 146)', () => {
  test('submit calls noteItem, clears the field, and the sheet says it landed', async () => {
    const actions = actionsStub();
    const tree = render(
      <ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actions} />,
    );
    const field = tree.root.findByType(TextInput);
    act(() => field.props.onChangeText('my manager owns this, not me'));
    await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());
    expect(actions.noteItem).toHaveBeenCalledWith(ITEM, 'my manager owns this, not me');
    expect(tree.root.findByType(TextInput).props.value).toBe('');
    expect(texts(tree).join(' ')).toContain('Noted — tomorrow’s gather will read that.');
  });

  test('a failed note says so, distinctly from a successful one', async () => {
    const actions = actionsStub({ noteItem: jest.fn(async () => false) });
    const tree = render(
      <ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actions} />,
    );
    act(() => tree.root.findByType(TextInput).props.onChangeText('a note'));
    await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());
    expect(texts(tree).join(' ')).toContain('Couldn’t send that');
    expect(texts(tree).join(' ')).not.toContain('read that');
  });

  test('an empty or whitespace-only submit does nothing', async () => {
    const actions = actionsStub();
    const tree = render(
      <ItemSheet item={ITEM} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actions} />,
    );
    await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());
    expect(actions.noteItem).not.toHaveBeenCalled();

    act(() => tree.root.findByType(TextInput).props.onChangeText('   '));
    await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());
    expect(actions.noteItem).not.toHaveBeenCalled();
  });
});

describe('"Open in source" is absent when nothing resolves (spec §7)', () => {
  const open = (item: BriefItem) =>
    render(<ItemSheet item={item} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />);

  test('an item with no link and an origin that launches nothing has no action row entry', () => {
    const orphan: BriefItem = { ...ITEM, origin: 'packages', url: '', jump_url: '' };
    expect(linkTarget(orphan)).toBeNull();
    const rendered = texts(open(orphan));
    expect(rendered).toContain('Done');
    expect(rendered.some((s) => s.startsWith('Open'))).toBe(false);
  });

  test('an email item degrades to the app-launch action', () => {
    const mail: BriefItem = { ...ITEM, origin: 'email', url: '', jump_url: '' };
    expect(texts(open(mail))).toContain('Open Mail');
  });
});

describe('followTarget', () => {
  test('a hub route pushes, it does not open a browser', () => {
    expect(followTarget({ kind: 'route', href: '/oura', label: 'Open Oura' })).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/oura');
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  test('an external link opens externally', () => {
    followTarget({ kind: 'external', url: 'https://github.com/a/b/pull/1', label: 'Open on GitHub' });
    expect(Linking.openURL).toHaveBeenCalledWith('https://github.com/a/b/pull/1');
  });

  test('a my-pages path goes through resolveBriefUri, and a refused one reports failure', () => {
    briefs.resolveBriefUri.mockReturnValue('https://hub.example/my-pages/x/');
    expect(followTarget({ kind: 'page', path: '/my-pages/x/', label: 'Open page' })).toBe(true);
    expect(briefs.openBrief).toHaveBeenCalledWith('https://hub.example/my-pages/x/', 'Brief page');

    // The reader's own policy is the gate; a refusal must be visible, not a
    // silent no-op — the exact bug BriefCard had.
    briefs.resolveBriefUri.mockReturnValue(null);
    expect(followTarget({ kind: 'page', path: '/my-pages/evil/', label: 'Open page' })).toBe(false);
    expect(briefs.openBrief).toHaveBeenCalledTimes(1);
  });
});

describe('related items', () => {
  test('a resolvable related id is a row that opens that item; a dangling one is not rendered', () => {
    const [a, b] = bucketView(LIVE_BRIEF, 'today');
    const withRelated: BriefItem = { ...a, related: [b.item_id, 'ffffffffffff'] };
    const onOpenRelated = jest.fn();
    const tree = render(
      <ItemSheet item={withRelated} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={onOpenRelated} actions={actionsStub()} />,
    );
    expect(texts(tree)).toContain(b.title);
    act(() => button(tree, b.title).props.onPress());
    expect(onOpenRelated).toHaveBeenCalledWith(b);
    // Nothing was rendered for the id that resolves to no shown item.
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'ffffffffffff')).toHaveLength(0);
  });

  test('no related ids, no RELATED section', () => {
    const alone: BriefItem = { ...ITEM, related: [] };
    expect(texts(render(<ItemSheet item={alone} brief={LIVE_BRIEF} onClose={() => {}} onOpenRelated={() => {}} actions={actionsStub()} />))).not.toContain(
      'RELATED',
    );
  });
});

describe('HeldBackSheet', () => {
  test('groups the fixture brief’s 110 deferrals by code, biggest first', () => {
    const groups = groupDeferred(LIVE_BRIEF.deferred);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(110);
    for (let i = 1; i < groups.length; i += 1) {
      expect(groups[i - 1].items.length).toBeGreaterThanOrEqual(groups[i].items.length);
    }
    // Codes get human labels; an unmapped one keeps its own name rather than
    // disappearing.
    expect(groups.map((g) => g.label)).toContain('Nothing to do');
    expect(groupDeferred([{ item_id: 'x', title: 't', reason: 'r', code: 'ZZZ', origin: 'o' }])[0].label).toBe('ZZZ');
  });

  test('renders the summary and every held-back title', () => {
    const rendered = texts(render(<HeldBackSheet brief={LIVE_BRIEF} visible onClose={() => {}} />));
    expect(rendered.join(' ')).toContain('110 held back');
    for (const d of LIVE_BRIEF.deferred.slice(0, 20)) expect(rendered).toContain(d.title);
  });

  test('a DONE deferral shows its closure line — what closed it — over the raw reason', () => {
    const brief = {
      ...LIVE_BRIEF,
      deferred: [
        { item_id: 'a1', title: 'Renew the lease', reason: 'raw reason', code: 'DONE', origin: 'email', closure: 'signed and returned Tuesday' },
      ],
    };
    const rendered = texts(render(<HeldBackSheet brief={brief} visible onClose={() => {}} />));
    expect(rendered.join(' ')).toContain('signed and returned Tuesday');
    expect(rendered.join(' ')).not.toContain('raw reason');
  });

  test('it is read-only: nothing in it can be dismissed or un-deferred', () => {
    const tree = render(<HeldBackSheet brief={LIVE_BRIEF} visible onClose={() => {}} />);
    const pressables = tree.root.findAll((n) => typeof n.props.onPress === 'function');
    // Only DetailSheet's own Close button.
    expect(pressables.filter((p) => p.props.accessibilityLabel !== undefined)).toHaveLength(0);
    expect(texts(tree)).toContain('Close');
  });

  test('nothing held back still renders without throwing', () => {
    const clear = { ...LIVE_BRIEF, deferred: [], held_back: { total: 0, by_code: {} } };
    expect(texts(render(<HeldBackSheet brief={clear} visible onClose={() => {}} />))).toContain(
      'Nothing held back',
    );
  });
});
