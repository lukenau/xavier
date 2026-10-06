// the user, 2026-10-01: "when you go from tool to thinking it causes a flicker too
// when the thinking collapses … make sure anything returned as a message from
// the skill_manage post hook stays collapsed." A finished tool call used to sit
// inline, as its own card, for the whole stream and then fold away in the same
// frame the reply settled — the hard re-layout was the flicker. It folds now the
// moment it is finished, streaming or not.
jest.mock('@shopify/react-native-skia', () => ({}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, api: { ...actual.api, chatAnswerClarify: jest.fn() } };
});
jest.mock('./widgets/ChartWidget', () => ({ ChartWidget: () => null }));

import TestRenderer, { act } from 'react-test-renderer';
import type { ChatMessage } from '../../chat/types';
import { MessageBubble } from './MessageBubble';

function streamingWithFinishedTool(): ChatMessage {
  return {
    id: 'm1',
    thread_id: 't1',
    seq: 1,
    version: 1,
    role: 'assistant',
    author_type: 'agent',
    run_id: 'run1',
    status: 'streaming',
    client_msg_id: null,
    cron_run_id: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:10Z',
    parts: [
      { type: 'text', text: 'working on it' },
      { type: 'tool_call', tool_call_id: 'tc1', tool_name: 'skill_manage', status: 'complete', duration_ms: 1200 },
    ],
  };
}

test('a finished tool call is folded while the reply is still streaming', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<MessageBubble message={streamingWithFinishedTool()} />);
  });
  const json = JSON.stringify(r.toJSON());
  expect(json).toContain('Worked for');
  act(() => r.unmount());
});

test('a running tool call still shows itself', () => {
  const msg = streamingWithFinishedTool();
  (msg.parts[1] as { status: string }).status = 'running';
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<MessageBubble message={msg} />);
  });
  const json = JSON.stringify(r.toJSON());
  expect(json).not.toContain('Worked for');
  expect(json).toContain('skill_manage');
  act(() => r.unmount());
});
