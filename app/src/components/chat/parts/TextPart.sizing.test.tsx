// No pinned height on a text view in the transcript.
//
// A UITextView never reports a content height smaller than its own frame, so a
// height pinned from `onContentSizeChange` only ratchets up — one transient
// tall measurement stuck as an empty gap above the timestamp — and while a long
// reply streamed the pin ran a pass behind the text on every tick, so the page
// bounced (the user, 2026-10-01: "long tool calls or messages cause the chat page to
// go up and down in a flicker"). The views size themselves instead.
// While a reply streams, the words are revealed over time and nothing is rendered on the first pass. Stubbed to
// show all of it at once so `streaming` can be exercised without timers.
jest.mock('../../../chat/useSmoothedText', () => ({ useSmoothedText: (text: string) => text }));

import { create, act } from 'react-test-renderer';
import { StyleSheet, TextInput } from 'react-native';
import { TextPart } from './TextPart';

const LONG = [
  '## A heading',
  'First paragraph with enough words to wrap across more than one line on a phone screen.',
  '- one\n- two\n- three',
  '> a quoted line that also sits in its own text view',
  'Last paragraph.',
].join('\n\n');

function inputs(streaming: boolean) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<TextPart text={LONG} streaming={streaming} />);
  });
  return tree.root.findAllByType(TextInput);
}

it.each([false, true])('pins no height and listens for no resize, streaming=%s', (streaming) => {
  const views = inputs(streaming);
  expect(views.length).toBeGreaterThan(0);
  for (const view of views) {
    expect(view.props.onContentSizeChange).toBeUndefined();
    expect(StyleSheet.flatten(view.props.style)).not.toHaveProperty('height');
  }
});

it('still renders a run of blocks as one selectable view (the copy-across-blank-lines fix)', () => {
  const views = inputs(false);
  // heading + paragraph + list are one run; the quote is its own view; the last paragraph is one more run.
  expect(views.length).toBeLessThan(5);
  expect(views[0].props.editable).toBe(false);
});
