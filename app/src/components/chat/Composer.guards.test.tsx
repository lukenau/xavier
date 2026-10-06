// Adversarial review, 2026-09-22: the return key plus a tap (or two batched
// taps) both passed a guard read through the render closure, so one message
// went out twice; and a thread that merely failed to load told the user the chat
// was locked.
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, api: { ...actual.api, chatCommands: jest.fn(() => new Promise(() => {})) } };
});

import TestRenderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer, type ComposerProps } from './Composer';

let renderer: TestRenderer.ReactTestRenderer | null = null;
let client: QueryClient;

function render(props: Partial<ComposerProps> = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['chat-commands'], { version: 1, source: 'live', commands: [] });
  const onSend = jest.fn();
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Composer mode="steer" onModeChange={() => {}} onSend={onSend} running={false} onStop={() => {}} {...props} />
      </QueryClientProvider>,
    );
  });
  return { r: renderer!, onSend };
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  client?.clear();
});

const input = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(TextInput);
const sendButton = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props.accessibilityLabel === 'Send' && typeof n.props.onPress === 'function')[0];

test('return key and a tap in the same batch send once', () => {
  const { r, onSend } = render();
  act(() => input(r).props.onChangeText('ship it'));
  act(() => {
    input(r).props.onSubmitEditing();
    sendButton(r).props.onPress();
  });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test('two batched taps send once', () => {
  const { r, onSend } = render();
  act(() => input(r).props.onChangeText('ship it'));
  const press = sendButton(r).props.onPress;
  act(() => {
    press();
    press();
  });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test('the latch releases for the next message, even with identical text', () => {
  const { r, onSend } = render();
  act(() => input(r).props.onChangeText('ok'));
  act(() => sendButton(r).props.onPress());
  act(() => input(r).props.onChangeText('ok'));
  act(() => sendButton(r).props.onPress());
  expect(onSend).toHaveBeenCalledTimes(2);
});

test('the placeholder speaks to a person, not a terminal', () => {
  const { r } = render();
  expect(input(r).props.placeholder).toBe('Message Xavier');
});

test('a loading thread does not claim the chat is locked', () => {
  const { r } = render({ unavailable: 'loading' });
  expect(input(r).props.placeholder).not.toMatch(/lock/i);
  expect(input(r).props.placeholder).toMatch(/loading/i);
});

test('a thread that failed to load does not claim the chat is locked', () => {
  const { r } = render({ unavailable: 'error' });
  expect(input(r).props.placeholder).not.toMatch(/lock/i);
  expect(input(r).props.placeholder).toMatch(/unavailable/i);
});
