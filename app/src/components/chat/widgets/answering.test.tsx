// Interaction defects proved by the 2026-09-22 adversarial review: a clarify
// answer that looked sent when the POST failed, a card that forgot it was
// answered on remount, and a poll whose buttons were wired to nothing.
jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const { View } = require('react-native');
  const node =
    (name: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) =>
      React.createElement(View, { testID: name, ...props }, props.children);
  return {
    Canvas: node('sk-canvas'),
    Group: node('sk-group'),
    Line: node('sk-line'),
    Path: node('sk-path'),
    Rect: node('sk-rect'),
    RoundedRect: node('sk-rrect'),
    Circle: node('sk-circle'),
    Text: node('sk-text'),
    vec: (x: number, y: number) => ({ x, y }),
    useFont: () => ({ measureText: (text: string) => ({ x: 0, y: 0, width: text.length * 6, height: 10 }) }),
  };
});
jest.mock('../../../lib/api', () => {
  const actual = jest.requireActual('../../../lib/api');
  return { ...actual, api: { ...actual.api, chatAnswerClarify: jest.fn() } };
});

import { create, act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { ApiError, api } from '../../../lib/api';
import { useChatStore } from '../../../chat/store';
import type { WidgetPart } from '../../../chat/types';
import { WidgetPartView } from './index';

const answerMock = api.chatAnswerClarify as jest.Mock;

const CLARIFY: WidgetPart = {
  type: 'widget',
  kind: 'clarify',
  widget_id: 'clr_1',
  question: 'Which env?',
  choices: ['staging', 'prod'],
};

const POLL: WidgetPart = {
  type: 'widget',
  kind: 'poll',
  question: 'Ship today?',
  options: [
    { id: 'yes', label: 'Ship it' },
    { id: 'no', label: 'Wait' },
  ],
};

let tree: ReactTestRenderer | null = null;
function render(part: WidgetPart) {
  act(() => {
    tree = create(<WidgetPartView part={part} threadId="t1" />);
  });
  return tree!;
}

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  answerMock.mockReset();
  useChatStore.getState().reset();
});

function textOf(node: ReactTestInstance): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === 'string' || typeof n === 'number') out.push(String(n));
    else if (Array.isArray(n)) n.forEach(walk);
  };
  node.findAllByType(Text).forEach((n) => walk(n.props.children));
  return out.join('');
}

function liveButtons(r: ReactTestRenderer) {
  return r.root.findAll(
    (n) =>
      n.props.accessibilityRole === 'button' &&
      typeof n.props.onPress === 'function' &&
      n.props.disabled !== true,
    { deep: false },
  );
}

async function tap(r: ReactTestRenderer, label: string) {
  const target = liveButtons(r).find((b) => textOf(b).includes(label));
  if (!target) throw new Error(`no live control labelled ${label}`);
  await act(async () => {
    target.props.onPress();
  });
}

describe('clarify: the answer commits only once the server took it', () => {
  it('shows a sending state while the POST is in flight, not "Answered"', async () => {
    answerMock.mockImplementation(() => new Promise(() => {}));
    const r = render(CLARIFY);
    await tap(r, 'prod');
    expect(textOf(r.root)).not.toContain('Answered');
    expect(textOf(r.root)).toMatch(/Sending/);
  });

  it('a failed POST says it did not go through and offers a retry that re-sends', async () => {
    answerMock.mockRejectedValueOnce(new ApiError(502, 'the gateway did not answer', 'gateway_unreachable'));
    const r = render(CLARIFY);
    await tap(r, 'prod');
    expect(textOf(r.root)).not.toContain('Answered');
    expect(textOf(r.root)).toMatch(/didn.t go through/i);

    answerMock.mockResolvedValueOnce({ status: 'ok', clarify_id: 'clr_1' });
    await tap(r, 'Try again');
    expect(answerMock).toHaveBeenCalledTimes(2);
    expect(answerMock).toHaveBeenLastCalledWith('clr_1', 't1', '2');
    expect(textOf(r.root)).toContain('Answered: prod');
  });

  it('a resolved POST commits the card', async () => {
    answerMock.mockResolvedValue({ status: 'ok', clarify_id: 'clr_1' });
    const r = render(CLARIFY);
    await tap(r, 'prod');
    expect(textOf(r.root)).toContain('Answered: prod');
    expect(liveButtons(r)).toHaveLength(0);
  });
});

describe('clarify: answered is server state, not component state', () => {
  function answeredRow() {
    useChatStore.getState().applyFrame({
      type: 'attention.upsert',
      thread_id: 't1',
      seq: 1,
      attention_id: 'att_1',
      kind: 'question',
      request_id: 'clr_1',
      run_id: null,
      message_id: null,
      summary: 'Which env?',
      state: 'answered',
      expires_at_derived: null,
      created_at: '2026-09-22T00:00:00Z',
      dismissed_at: '2026-09-22T00:01:00Z',
    } as never);
  }

  it('a remounted card whose question row is answered offers no second POST', () => {
    answeredRow();
    const r = render(CLARIFY);
    expect(liveButtons(r)).toHaveLength(0);
    expect(textOf(r.root)).toContain('Answered');
    // The row says it was answered, not with what — never invent the choice.
    expect(textOf(r.root)).not.toContain('Answered: staging');
    expect(textOf(r.root)).not.toContain('Answered: prod');
  });

  it('an open question row leaves the card answerable', () => {
    const r = render(CLARIFY);
    expect(liveButtons(r).length).toBeGreaterThan(0);
  });
});

describe('poll with no vote route', () => {
  it('does not render live-looking options wired to nothing', () => {
    const r = render(POLL);
    expect(liveButtons(r)).toHaveLength(0);
  });
});
