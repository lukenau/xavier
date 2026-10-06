// What re-renders when one message changes.
//
// the user, 2026-09-24: "it can be really jumpy and unclean. rendering is an issue
// it would appear". Nothing in the transcript was memoized, so a single
// streamed delta re-rendered every bubble in the thread — tall widget cards
// included — several times a second for the length of a reply.
//
// `useTheme` is called once per render of every component that draws, so
// counting it counts renders.
import TestRenderer, { act } from 'react-test-renderer';
import type { ChatMessage } from '../../chat/types';
import { MessageBubble } from './MessageBubble';

jest.mock('../../theme/useTheme', () => {
  const actual = jest.requireActual('../../theme/useTheme');
  return { ...actual, useTheme: jest.fn(actual.useTheme) };
});
// eslint-disable-next-line import/first
import { useTheme } from '../../theme/useTheme';

const renders = useTheme as jest.Mock;

function message(id: string, text: string): ChatMessage {
  return {
    id,
    thread_id: 't1',
    seq: Number(id.replace(/\D/g, '')),
    role: 'assistant',
    author_type: 'agent',
    run_id: 'r1',
    status: 'complete',
    client_msg_id: null,
    cron_run_id: null,
    created_at: '2026-09-24T00:00:00Z',
    updated_at: '2026-09-24T00:00:00Z',
    parts: [{ type: 'text', text }],
  } as ChatMessage;
}

function List({ messages, onCopy }: { messages: ChatMessage[]; onCopy: (text: string) => void }) {
  return (
    <>
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} onCopy={onCopy} />
      ))}
    </>
  );
}

it('re-renders the message that changed, and leaves the rest alone', () => {
  const onCopy = () => {};
  const first = message('m1', 'the long one');
  const second = message('m2', 'streaming');

  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<List messages={[first, second]} onCopy={onCopy} />);
  });
  const afterFirstPaint = renders.mock.calls.length;
  expect(afterFirstPaint).toBeGreaterThan(0);

  // One message grows, as a streamed delta makes it grow. The other is the
  // same object it was.
  const grown = { ...second, parts: [{ type: 'text', text: 'streaming stil' }] } as ChatMessage;
  act(() => {
    tree.update(<List messages={[first, grown]} onCopy={onCopy} />);
  });
  const afterUpdate = renders.mock.calls.length - afterFirstPaint;

  // The changed row costs a render. The unchanged one costs nothing — before
  // this, both rows re-rendered on every delta.
  expect(afterUpdate).toBeGreaterThan(0);
  expect(afterUpdate).toBeLessThan(afterFirstPaint);
});

it('does not re-render anything when nothing changed', () => {
  const onCopy = () => {};
  const messages = [message('m1', 'one'), message('m2', 'two')];

  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<List messages={messages} onCopy={onCopy} />);
  });
  const painted = renders.mock.calls.length;

  act(() => {
    tree.update(<List messages={messages} onCopy={onCopy} />);
  });
  expect(renders.mock.calls.length).toBe(painted);
});

it('re-renders when the callback changes, because a new callback is new behaviour', () => {
  const messages = [message('m1', 'one')];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<List messages={messages} onCopy={() => {}} />);
  });
  const painted = renders.mock.calls.length;

  act(() => {
    tree.update(<List messages={messages} onCopy={() => {}} />);
  });
  expect(renders.mock.calls.length).toBeGreaterThan(painted);
});
