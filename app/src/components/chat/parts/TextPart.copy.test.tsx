// Copying across a blank line. A selection only ever runs inside one native
// text view, so a paragraph and the list under it in separate views meant a
// drag stopped at every break — "i can't copy across multiple lines when there
// is a blank line right now. that is a bug" (the user, 2026-09-30).
import { create, act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { TextPart } from './TextPart';

function render(text: string) {
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<TextPart text={text} />);
  });
  return tree!;
}

/** Everything a single text view holds, in order — what a drag over it selects
 * and what lands on the clipboard. */
function runText(view: ReturnType<typeof create>, index = 0): string {
  const input = view.root.findAllByType(TextInput)[index];
  const strings: string[] = [];
  const walk = (node: { children?: unknown[] } | string) => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child as never);
  };
  walk(input as never);
  return strings.join('');
}

it('holds a paragraph and the list under it in ONE view, blank line included', () => {
  const tree = render('Two things worth deciding:\n\n- the 11 AM clash\n- the afternoon');
  expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
  const copied = runText(tree);
  expect(copied).toContain('Two things worth deciding:');
  expect(copied).toContain('the 11 AM clash');
  expect(copied).toContain('the afternoon');
  // The blank line between the paragraph and the list is really there, so it
  // comes along in the copy rather than being a gap between two views.
  expect(copied).toContain('deciding:\n\n');
  // List items are one line apart, not two.
  expect(copied).toContain('clash\n');
  expect(copied).not.toContain('clash\n\n');
  act(() => tree.unmount());
});

it('keeps a heading in the same run as the prose it introduces', () => {
  const tree = render('## Today\n\nthe first thing\n\nthe second thing');
  expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
  expect(runText(tree)).toContain('Today\n\nthe first thing\n\nthe second thing');
  act(() => tree.unmount());
});

it('still gives a code block its own box, and prose around it its own runs', () => {
  const tree = render('before\n\n```\nls -la\n```\n\nafter');
  const inputs = tree.root.findAllByType(TextInput);
  expect(inputs).toHaveLength(3);
  expect(runText(tree, 0)).toContain('before');
  expect(runText(tree, 1)).toContain('ls -la');
  expect(runText(tree, 2)).toContain('after');
  act(() => tree.unmount());
});

it('leaves a block carrying a link tappable, on its own', () => {
  const tree = render('plain line\n\nSee [the report](https://example.com/r) now.');
  // The link block is a Text, not a TextInput, so the tap reaches it.
  expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
  expect(tree.root.findAllByType(Text).length).toBeGreaterThan(0);
  act(() => tree.unmount());
});

it('carries the bullet marker inside the run so it is part of the copy', () => {
  const tree = render('- one thing\n- another');
  expect(runText(tree)).toContain('•  one thing');
  act(() => tree.unmount());
});
