// Adversarial review, 2026-09-22: parts were keyed by their index in the
// post-fold `inline` list, so completing a turn — which folds finished tool
// calls out of that list — shifted every later index, remounted the subtree,
// and wiped a clarify answer being typed at that moment.
jest.mock('@shopify/react-native-skia', () => ({}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, api: { ...actual.api, chatAnswerClarify: jest.fn() } };
});
jest.mock('./widgets/ChartWidget', () => ({ ChartWidget: () => null }));

import TestRenderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import type { ChatMessage } from '../../chat/types';
import { MessageBubble } from './MessageBubble';

function message(status: 'streaming' | 'complete'): ChatMessage {
  return {
    id: 'm1',
    thread_id: 't1',
    seq: 1,
    version: 1,
    role: 'assistant',
    author_type: 'agent',
    run_id: 'run1',
    status,
    client_msg_id: null,
    cron_run_id: null,
    created_at: '2026-09-22T00:00:00Z',
    updated_at: '2026-09-22T00:00:10Z',
    parts: [
      { type: 'tool_call', tool_call_id: 'tc1', tool_name: 'terminal', status: 'complete' },
      { type: 'widget', kind: 'clarify', widget_id: 'clr_1', question: 'Why?', choices: [] },
    ],
  };
}

test('completing a turn keeps a half-typed clarify answer', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<MessageBubble message={message('streaming')} />);
  });
  act(() => r.root.findByType(TextInput).props.onChangeText('because the build is red'));
  act(() => r.update(<MessageBubble message={message('complete')} />));
  expect(r.root.findByType(TextInput).props.value).toBe('because the build is red');
  act(() => r.unmount());
});
