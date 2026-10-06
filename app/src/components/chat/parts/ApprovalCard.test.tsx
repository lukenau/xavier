// Adversarial review, 2026-09-22: `if (applying) return` read state through
// the render closure, so two presses in one batch started two challenges —
// two Face ID prompts and two applies on one request_id.
jest.mock('../../../lib/api', () => {
  const actual = jest.requireActual('../../../lib/api');
  return { ...actual, api: { ...actual.api, chatApprovalApply: jest.fn() } };
});

import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import type { PendingApprovalView } from '../../../chat/types';
import { ApprovalCard } from './ApprovalCard';

const applyMock = api.chatApprovalApply as jest.Mock;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
const card = () => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <ApprovalCard approval={APPROVAL} />
  </SafeAreaProvider>
);

const APPROVAL: PendingApprovalView = {
  thread_id: 't1',
  attention_id: 'att_1',
  request_id: 'req_1',
  run_id: 'run_1',
  message_id: null,
  summary: 'rm -rf build/',
  choices: ['once', 'deny'],
  expires_at_derived: null,
};

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  applyMock.mockReset();
});

function choiceButtons(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll(
    (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    { deep: false },
  );
}

test('two presses in one batch start one Face ID flow', async () => {
  let release!: (v: unknown) => void;
  applyMock.mockImplementation(() => new Promise((res) => (release = res)));
  act(() => {
    renderer = TestRenderer.create(card());
  });
  const [once, deny] = choiceButtons(renderer!);
  act(() => {
    once.props.onPress();
    deny.props.onPress();
  });
  expect(applyMock).toHaveBeenCalledTimes(1);
  await act(async () => release({ decisions: [{ choice: 'once' }] }));
});

test('the latch clears after a failure so the card can be answered again', async () => {
  applyMock.mockRejectedValueOnce(new Error('network down'));
  act(() => {
    renderer = TestRenderer.create(card());
  });
  await act(async () => {
    choiceButtons(renderer!)[0].props.onPress();
  });
  applyMock.mockResolvedValueOnce({ decisions: [{ choice: 'once' }] });
  await act(async () => {
    choiceButtons(renderer!)[0].props.onPress();
  });
  expect(applyMock).toHaveBeenCalledTimes(2);
});
