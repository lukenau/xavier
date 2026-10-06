// The trailing swipe rail.
//
// This file was rewritten when SwipeRail.tsx was reverted to its pre-design-
// review shape (2026-09-22). The review's H6/H7/H10/H11 changes each looked
// right in isolation and together broke the row on a real phone: rails showing
// on rows that were only scrolled past, a left swipe opening the detail sheet
// over the actions it had just revealed, a right swipe on an open row leaving
// the screen. Three attempts to fix them from the outside made it worse, so the
// working version is the one that ships and the tests assert what it does.
//
// What is asserted here is therefore deliberately thin: this renderer has no
// native gesture recognizer, so the only honest subjects are the gesture's
// configuration and the rail's presence. Whether a real touch stream produces
// the right result is not knowable here — it needs the device.
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { SwipeRow } from './SwipeRail';
import { bucketView } from './briefModel';
import type { UseBriefActions } from './useBriefActions';
import { LIVE_BRIEF } from './liveBrief.fixture';

const ITEM = bucketView(LIVE_BRIEF, 'today')[0];

function makeActions(overrides: Partial<UseBriefActions> = {}): UseBriefActions {
  return {
    rowState: () => ({ phase: 'idle', failure: null, undoLabel: '', action: null, explained: false }),
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
    ...overrides,
  };
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

describe('the gesture activates in both directions', () => {
  test('a drag either way past 12pt opens or closes the row', () => {
    // One-way activation was H11's idea, to protect the edge-swipe-back. It
    // also removed the only way to close an open row by gesture, which is how
    // the user found it: swiping an open row right left the screen entirely.
    const tree = render(
      <SwipeRow item={ITEM} actions={makeActions()} enabled>
        <Text>row</Text>
      </SwipeRow>,
    );
    const gesture = tree.root.findByType(GestureDetector).props.gesture;
    expect(gesture.config.activeOffsetXStart).toBe(-12);
    expect(gesture.config.activeOffsetXEnd).toBe(12);
  });

  test('a mostly-vertical drag belongs to the scroll view', () => {
    const tree = render(
      <SwipeRow item={ITEM} actions={makeActions()} enabled>
        <Text>row</Text>
      </SwipeRow>,
    );
    const gesture = tree.root.findByType(GestureDetector).props.gesture;
    expect(gesture.config.failOffsetYStart).toBe(-8);
    expect(gesture.config.failOffsetYEnd).toBe(8);
  });
});

describe('the rail is present but hidden behind an opaque face', () => {
  test('the actions exist at rest, under a face that paints over them', () => {
    // H7 made the rail mount only once a drag began, and H9 removed the face's
    // fill in the same batch. Either alone was survivable; together, a row the
    // finger merely scrolled past kept a visible rail. The face's own opaque
    // ground is what hides it, and it is the reason the rail can be mounted.
    const tree = render(
      <SwipeRow item={ITEM} actions={makeActions()} enabled>
        <Text>row</Text>
      </SwipeRow>,
    );
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Snooze').length).toBeGreaterThan(0);
    const faces = tree.root
      .findAll((n) => Array.isArray(n.props.style))
      .flatMap((n) => (n.props.style as unknown[]).flat().filter(Boolean) as Record<string, unknown>[])
      .filter((s) => 'backgroundColor' in s && 'transform' in s === false);
    expect(faces.length).toBeGreaterThan(0);
  });

  test('a disabled row (Background) carries no rail at all', () => {
    const tree = render(
      <SwipeRow item={ITEM} actions={makeActions()} enabled={false}>
        <Text>row</Text>
      </SwipeRow>,
    );
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Snooze')).toHaveLength(0);
  });
});

describe('the rail commits through its own buttons', () => {
  test('Snooze on an open row calls snooze, not the row press', () => {
    const actions = makeActions({
      rowState: () => ({ phase: 'open', failure: null, undoLabel: '', action: null, explained: false }),
    });
    const tree = render(
      <SwipeRow item={ITEM} actions={actions} enabled>
        <Text>row</Text>
      </SwipeRow>,
    );
    const snooze = tree.root.find(
      (n) => n.props.accessibilityLabel === 'Snooze' && typeof n.props.onPress === 'function',
    );
    act(() => snooze.props.onPress());
    expect(actions.snooze).toHaveBeenCalledWith(ITEM, '1d');
  });
});
