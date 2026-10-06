import { create, act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { TextPart } from './TextPart';

function render(text: string) {
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<TextPart text={text} />);
  });
  return tree!;
}

describe('TextPart — a reader can select part of a message', () => {
  // React Native's iOS `<Text selectable>` copies the whole paragraph and
  // nothing less (RCTParagraphComponentView `copy:` takes range 0..length).
  // the user asked for partial selection twice (L44, L60).
  it('renders plain prose as a read-only text view, which selects ranges', () => {
    const tree = render('Checking the ledger now, then the calendar.');
    const views = tree.root.findAllByType(TextInput);
    expect(views).toHaveLength(1);
    expect(views[0].props.editable).toBe(false);
    expect(views[0].props.multiline).toBe(true);
    expect(views[0].props.scrollEnabled).toBe(false);
    act(() => tree.unmount());
  });

  it('gives headings, list items and quotes the same selection', () => {
    const tree = render('## Today\n\n- one thing\n- another\n\n> a quote');
    // Two views, not four: the heading and both list items share one run so a
    // selection crosses the blank line between them (TextPart.copy.test.tsx).
    // The quote keeps its own, because its left border cannot live inside a
    // text run.
    expect(tree.root.findAllByType(TextInput).length).toBe(2);
    act(() => tree.unmount());
  });

  it('keeps a paragraph with a link as tappable text', () => {
    const tree = render('See [the report](https://example.com/r) for details.');
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('makes a code block selectable too', () => {
    const tree = render('```\nls -la\n```');
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
    act(() => tree.unmount());
  });
});
