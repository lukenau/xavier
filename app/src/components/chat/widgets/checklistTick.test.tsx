// Ticking a checklist item. the user, 2026-09-22: "make check list widgets
// interactive too and have them update the underlying data on change".
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import type { ChecklistWidget as ChecklistWidgetT } from '../../../chat/widget';
import { ChecklistWidget } from './ChecklistWidget';

const mockTick = jest.fn();
jest.mock('../../../lib/api', () => ({ api: { chatTickChecklist: (...a: unknown[]) => mockTick(...a) } }));

function widget(): ChecklistWidgetT {
  return {
    kind: 'checklist',
    title: 'Trip',
    items: [
      { id: 'i0', label: 'Book car', state: 'done', note: null },
      { id: 'i1', label: 'RMNP permit', state: 'todo', note: null },
    ],
  };
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

const row = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === `checklist-item-${id}`)[0];

const marker = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === `checklist-marker-${id}`)[0].findByType(Text).props.children;

const progress = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props.testID === 'checklist-progress')[0].findByType(Text).props.children;

function anchored() {
  return <ChecklistWidget widget={widget()} threadId="thr_1" messageId="msg_1" partIndex={0} />;
}

beforeEach(() => {
  mockTick.mockReset();
  mockTick.mockResolvedValue({ status: 'ok', label: 'RMNP permit', state: 'done' });
});

it('ticks an item and tells the server where it is', async () => {
  const tree = render(anchored());
  await act(async () => {
    row(tree, 'i1').props.onPress();
  });
  expect(mockTick).toHaveBeenCalledWith('thr_1', {
    message_id: 'msg_1',
    part_index: 0,
    item_index: 1,
    state: 'done',
  });
});

it('moves the row and the count straight away, without waiting for the round trip', async () => {
  const tree = render(anchored());
  expect(progress(tree)).toContain('1 of 2 done');
  await act(async () => {
    row(tree, 'i1').props.onPress();
  });
  expect(marker(tree, 'i1')).toBe('✓');
  expect(progress(tree)).toContain('2 of 2 done');
});

it('takes a done item back', async () => {
  const tree = render(anchored());
  await act(async () => {
    row(tree, 'i0').props.onPress();
  });
  expect(mockTick.mock.calls[0][1].state).toBe('todo');
  expect(marker(tree, 'i0')).toBe('○');
});

it('puts the row back when the tick does not land', async () => {
  mockTick.mockRejectedValue(new Error('offline'));
  const tree = render(anchored());
  await act(async () => {
    row(tree, 'i1').props.onPress();
  });
  expect(marker(tree, 'i1')).toBe('○');
  expect(progress(tree)).toContain('1 of 2 done');
});

it('is not tappable where there is nothing to tick against', () => {
  // A checklist rendered outside a thread (a preview, a test) has no anchor.
  const tree = render(<ChecklistWidget widget={widget()} />);
  expect(row(tree, 'i1').props.accessibilityState).toBeUndefined();
  expect(row(tree, 'i1').props.disabled).toBe(true);
});

it('reads as a checkbox to VoiceOver', () => {
  const tree = render(anchored());
  expect(row(tree, 'i0').props.accessibilityRole).toBe('checkbox');
  expect(row(tree, 'i0').props.accessibilityState).toEqual({ checked: true });
  expect(row(tree, 'i1').props.accessibilityState).toEqual({ checked: false });
});
