// The expandable subagent card (L71). the user: "like in claude code terminal you
// can click on a subagent and see their chat window to see text and tool
// calls. i don't need to interact with them, but visibility might be nice."
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ToolCallPart } from '../../../chat/types';
import { SubagentCard } from './SubagentCard';

const mockTranscript = jest.fn();
jest.mock('../../../lib/api', () => ({
  api: { chatSubagentTranscript: (...args: unknown[]) => mockTranscript(...args) },
}));

function part(over: Partial<ToolCallPart> = {}): ToolCallPart {
  return {
    type: 'tool_call',
    tool_call_id: 'subagent:child-1',
    tool_name: 'delegate_task',
    args: { role: 'researcher', goal: 'find the kernel version' },
    result: 'Linux 6.8.0',
    status: 'complete',
    duration_ms: 4200,
    subagent: { child_session_id: 'child-1', child_role: 'researcher', phase: 'stop', tool_call_count: 2 },
    ...over,
  } as ToolCallPart;
}

let client: QueryClient;

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
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

function header(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' &&
    n.props.accessibilityLabel.startsWith('Delegated to'))[0];
}

afterEach(() => {
  mockTranscript.mockReset();
  client?.clear();
});

it('shows the role, the goal and what came back without being opened', () => {
  const shown = texts(render(<SubagentCard part={part()} threadId="thr_1" />));
  expect(shown).toContain('researcher');
  expect(shown).toContain('find the kernel version');
  expect(shown).toContain('2 calls');
});

it('asks for the child transcript only once it is opened', async () => {
  mockTranscript.mockResolvedValue({ child_session_id: 'child-1', parts: [], truncated: false });
  const tree = render(<SubagentCard part={part()} threadId="thr_1" />);
  expect(mockTranscript).not.toHaveBeenCalled();

  await act(async () => {
    header(tree).props.onPress();
  });
  expect(mockTranscript).toHaveBeenCalledWith('thr_1', 'child-1');
});

it("draws the child's own text and tool calls", async () => {
  mockTranscript.mockResolvedValue({
    child_session_id: 'child-1',
    truncated: false,
    parts: [
      { type: 'reasoning', text: 'check the kernel' },
      { type: 'tool_call', tool_call_id: 't1', tool_name: 'terminal', args: 'uname -a', status: 'complete' },
      { type: 'text', text: 'Linux 6.8.0 on example-host.', role: 'assistant' },
    ],
  });
  const tree = render(<SubagentCard part={part()} threadId="thr_1" />);
  await act(async () => {
    header(tree).props.onPress();
  });
  const shown = texts(tree);
  expect(shown).toContain('check the kernel');
  expect(shown).toContain('terminal');
  expect(shown).toContain('Linux 6.8.0 on example-host.');
});

it('says so when the transcript cannot be read, rather than showing an empty child', async () => {
  // The query does not hand its error to the card in the turn the fetch
  // rejects: TanStack's notifyManager delivers it on a setTimeout(0). Under
  // real timers that tick raced the assertion and lost under load. Under fake
  // timers it runs exactly when the test says so, after every promise ahead
  // of it has settled.
  jest.useFakeTimers();
  try {
    mockTranscript.mockRejectedValue(new Error('gateway unreachable'));
    const tree = render(<SubagentCard part={part()} threadId="thr_1" />);
    await act(async () => {
      header(tree).props.onPress();
    });
    expect(mockTranscript).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.runAllTimersAsync();
    });
    expect(texts(tree)).toContain('Could not read this one back');
    // retry: false — the error is final, not a first attempt.
    expect(mockTranscript).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it('is still openable while the subagent is running, for the same reason', () => {
  const running = part({ status: 'running', result: undefined, duration_ms: undefined });
  const tree = render(<SubagentCard part={running} threadId="thr_1" />);
  expect(header(tree).props.accessibilityState).toEqual({ expanded: false });
});

it('has nothing to open when the row carries no child session', () => {
  const bare = part({ subagent: { child_session_id: '', child_role: 'r', phase: 'stop' }, result: undefined });
  const tree = render(<SubagentCard part={bare} threadId="thr_1" />);
  expect(header(tree).props.accessibilityState).toBeUndefined();
});
