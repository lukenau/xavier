// The delegation block: what a reader needs at a glance — how many, what
// each was asked, working or done — with each agent's own card inside.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import type { AgentEntry } from '../../../chat/transcript';
import type { ChatMessage, ToolCallPart } from '../../../chat/types';
import { AgentsBlock } from './AgentsBlock';

jest.mock('../../../lib/query', () => ({ usePoll: () => ({ data: undefined, isPending: false }) }));
jest.mock('../../../lib/api', () => ({ api: { chatSubagentTranscript: jest.fn() } }));

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string')
    .join(' | ');
}

function entry(id: string, status: 'running' | 'complete' | 'error', goal: string | null): AgentEntry {
  const part = {
    type: 'tool_call',
    tool_call_id: `subagent:${id}`,
    tool_name: 'delegate_task',
    args: { role: 'leaf' },
    status,
    subagent: { child_session_id: id, child_role: 'leaf', phase: status === 'running' ? 'start' : 'stop', tool_call_count: null },
  } as ToolCallPart;
  const message = {
    id: `m-${id}`,
    thread_id: 't1',
    seq: 1,
    version: 1,
    role: 'assistant',
    author_type: 'agent',
    run_id: 'r1',
    status: 'complete',
    client_msg_id: null,
    cron_run_id: null,
    created_at: '2026-09-29T21:14:00Z',
    updated_at: '2026-09-29T21:15:27Z',
    parts: [part],
  } as ChatMessage;
  return { part, message, goal };
}

it('names each agent from the dispatch record and counts the working ones', () => {
  const startedAt = new Date(Date.now() - 87_000).toISOString();
  const tree = render(
    <AgentsBlock
      agents={[entry('c1', 'running', 'Read the meetings'), entry('c2', 'running', 'Scan email')]}
      startedAt={startedAt}
      endedAt={startedAt}
      threadId="t1"
    />,
  );
  const shown = texts(tree);
  expect(shown).toContain('2 agents');
  expect(shown).toContain('working · 1m 27s');
  expect(shown).toContain('Read the meetings');
  expect(shown).toContain('Scan email');
});

it('reads done with the span once every agent has stopped', () => {
  const tree = render(
    <AgentsBlock
      agents={[entry('c1', 'complete', 'Read the meetings')]}
      startedAt="2026-09-29T21:14:00Z"
      endedAt="2026-09-29T21:15:27Z"
      threadId="t1"
    />,
  );
  const shown = texts(tree);
  expect(shown).toContain('1 agent');
  expect(shown).toContain('done in 1m 27s');
});

it('tells unnamed agents apart by their place', () => {
  const tree = render(
    <AgentsBlock
      agents={[entry('c1', 'complete', null), entry('c2', 'complete', null)]}
      startedAt="2026-09-29T21:14:00Z"
      endedAt="2026-09-29T21:14:30Z"
      threadId="t1"
    />,
  );
  const shown = texts(tree);
  expect(shown).toContain('leaf 1');
  expect(shown).toContain('leaf 2');
});

it('says how many failed rather than calling the block done', () => {
  const tree = render(
    <AgentsBlock
      agents={[entry('c1', 'complete', 'a'), entry('c2', 'error', 'b')]}
      startedAt="2026-09-29T21:14:00Z"
      endedAt="2026-09-29T21:14:30Z"
      threadId="t1"
    />,
  );
  expect(texts(tree)).toContain('1 failed · 30s');
});
