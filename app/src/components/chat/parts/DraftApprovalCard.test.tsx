// The draft card: what it shows (recipient + body, not the tool summary), the
// same one-Face-ID-per-batch latch ApprovalCard has, and that answering folds
// the `approval.answered` frame into the store so the card and the attention
// inbox both learn the draft is done.
jest.mock('../../../lib/api', () => {
  const actual = jest.requireActual('../../../lib/api');
  return { ...actual, api: { ...actual.api, chatApprovalApply: jest.fn() } };
});

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useChatStore } from '../../../chat/store';
import type { PendingApprovalView } from '../../../chat/types';
import { DraftApprovalCard } from './DraftApprovalCard';

const applyMock = api.chatApprovalApply as jest.Mock;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const DRAFT: PendingApprovalView = {
  thread_id: 't1',
  attention_id: 'att_1',
  request_id: 'req_1',
  run_id: 'run_1',
  message_id: 'm1',
  summary: 'iMessage draft',
  choices: ['once', 'deny'],
  expires_at_derived: null,
  draft: { to: 'Mom', text: 'running 10 min late', draft_id: 42 },
};

function card(approval: PendingApprovalView = DRAFT) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <DraftApprovalCard approval={approval} />
    </SafeAreaProvider>
  );
}

function texts(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
}

function choiceButtons(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll(
    (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    { deep: false },
  );
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
beforeEach(() => useChatStore.getState().reset());
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  applyMock.mockReset();
});

test('shows the recipient, body and draft id with Send / Discard, not the tool summary', () => {
  act(() => {
    renderer = TestRenderer.create(card());
  });
  const shown = texts(renderer!);
  expect(shown).toContain('To Mom');
  expect(shown).toContain('running 10 min late');
  expect(shown).toContain('draft #42');
  expect(shown).toContain('Send');
  expect(shown).toContain('Discard');
  expect(shown).toContain('imessage draft');
});

test('falls back to the attention summary when the args carried no body', () => {
  act(() => {
    renderer = TestRenderer.create(
      card({ ...DRAFT, summary: 'to Mom: forgot the keys', draft: { to: null, text: null, draft_id: null } }),
    );
  });
  const shown = texts(renderer!);
  expect(shown).toContain('Recipient not named');
  expect(shown).toContain('to Mom: forgot the keys');
});

test('two presses in one batch start one Face ID flow', async () => {
  let release!: (v: unknown) => void;
  applyMock.mockImplementation(() => new Promise((res) => (release = res)));
  act(() => {
    renderer = TestRenderer.create(card());
  });
  const [send, discard] = choiceButtons(renderer!);
  act(() => {
    send.props.onPress();
    discard.props.onPress();
  });
  expect(applyMock).toHaveBeenCalledTimes(1);
  expect(applyMock).toHaveBeenCalledWith([{ run_id: 'run_1', request_id: 'req_1', choice: 'once' }]);
  await act(async () => release({ decisions: [{ choice: 'once' }] }));
});

test('answering folds an approval.answered frame into the store so both surfaces update', async () => {
  useChatStore.getState().applyFrame({
    type: 'attention.upsert',
    seq: 1,
    thread_id: 't1',
    attention_id: 'att_1',
    kind: 'imessage_draft',
    request_id: 'req_1',
    run_id: 'run_1',
    summary: 'to Mom',
    message_id: null,
  });
  applyMock.mockResolvedValueOnce({ decisions: [{ choice: 'deny' }] });
  act(() => {
    renderer = TestRenderer.create(card());
  });
  await act(async () => {
    choiceButtons(renderer!)[1].props.onPress();
  });
  const row = useChatStore.getState().chat.threads['t1'].attention[0];
  expect(row.state).toBe('answered');
});
