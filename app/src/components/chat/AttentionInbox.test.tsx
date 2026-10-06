// A13. What the inbox renders is only ever what `GET /chat/attention` sent —
// the rows, their thread, and an expiry only when the row carries one — and
// tapping a row hands its thread id back so the caller can open it.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { AttentionInboxItem } from '../../chat/types';
import { useChatStore } from '../../chat/store';
import { AttentionInbox, expiryLabel, kindLabel, toneOf } from './AttentionInbox';

jest.mock('../../lib/api', () => ({ api: { chatAttention: jest.fn() } }));
let mockQuery: Record<string, unknown>;
jest.mock('../../lib/query', () => ({
  usePoll: () => mockQuery,
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function row(over: Partial<AttentionInboxItem> = {}): AttentionInboxItem {
  return {
    id: 'att_1',
    thread_id: 'thr_1',
    thread_title: 'Ops',
    thread_kind: 'ops',
    kind: 'approval',
    summary: 'delete the backup?',
    created_at: '2026-09-22T12:00:00Z',
    expires_at_derived: null,
    ...over,
  };
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
}

beforeEach(() => {
  mockQuery = { data: undefined, isLoading: false, isError: false, error: null };
  useChatStore.getState().reset();
});

test('an empty inbox says so', () => {
  mockQuery = { ...mockQuery, data: { attention: [] } };
  expect(texts(render(<AttentionInbox visible onClose={() => {}} onOpenThread={() => {}} />))).toContain(
    'Nothing is waiting on you',
  );
});

test('a row shows its kind, summary and thread, and its expiry only when it has one', () => {
  mockQuery = {
    ...mockQuery,
    data: {
      attention: [
        row({ id: 'att_a', kind: 'run_failed', summary: 'the nightly backup failed', expires_at_derived: null }),
        row({
          id: 'att_b',
          thread_id: 'thr_2',
          thread_title: null,
          thread_kind: 'cron',
          summary: 'approve the restart?',
          expires_at_derived: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      ],
    },
  };
  const rendered = texts(render(<AttentionInbox visible onClose={() => {}} onOpenThread={() => {}} />));
  expect(rendered).toContain('run failed');
  expect(rendered).toContain('the nightly backup failed');
  expect(rendered).toContain('Ops');
  // An unnamed thread falls back to its kind's own label, never to an invented name.
  expect(rendered).toContain('Cron');
  expect(rendered).toContain('expires in 5m');
  expect(rendered.filter((s) => s.startsWith('expires'))).toHaveLength(1);
});

test('tapping a row hands back its thread id', () => {
  mockQuery = { ...mockQuery, data: { attention: [row({ thread_id: 'thr_open_me' })] } };
  const opened: string[] = [];
  const tree = render(<AttentionInbox visible onClose={() => {}} onOpenThread={(id) => opened.push(id)} />);
  const card = tree.root.find(
    (n) => n.props.accessibilityLabel === 'approval in Ops' && typeof n.props.onPress === 'function',
  );
  act(() => card.props.onPress());
  expect(opened).toEqual(['thr_open_me']);
});

test('a failed read says so instead of showing an empty inbox', () => {
  mockQuery = { ...mockQuery, isError: true, error: new Error('offline') };
  const rendered = texts(render(<AttentionInbox visible onClose={() => {}} onOpenThread={() => {}} />));
  expect(rendered).toContain('Inbox unavailable');
  expect(rendered).not.toContain('Nothing is waiting on you');
});

test('a draft row is labelled and says it is answerable', () => {
  mockQuery = {
    ...mockQuery,
    data: {
      attention: [
        row({ id: 'att_d', kind: 'imessage_draft', summary: 'to Mom: running 10 min late' }),
      ],
    },
  };
  const rendered = texts(render(<AttentionInbox visible onClose={() => {}} onOpenThread={() => {}} />));
  expect(rendered).toContain('iMessage draft');
  expect(rendered).toContain('to Mom: running 10 min late');
  expect(rendered).toContain('tap to review');
});

test('a row the store already knows is answered is hidden before the server list catches up', () => {
  const store = useChatStore.getState();
  store.applyFrame({
    type: 'attention.upsert', seq: 1, thread_id: 'thr_1', attention_id: 'att_done', kind: 'imessage_draft',
    request_id: 'r', run_id: 'run', summary: 'draft already sent', message_id: null,
  });
  store.applyFrame({ type: 'approval.answered', thread_id: 'thr_1', run_id: 'run', request_id: 'r', choice: 'once' });
  mockQuery = {
    ...mockQuery,
    data: {
      attention: [
        row({ id: 'att_done', kind: 'imessage_draft', summary: 'draft already sent' }),
        row({ id: 'att_live', summary: 'still waiting' }),
      ],
    },
  };
  const rendered = texts(render(<AttentionInbox visible onClose={() => {}} onOpenThread={() => {}} />));
  expect(rendered).toContain('still waiting');
  expect(rendered).not.toContain('draft already sent');
});

describe('presentation helpers', () => {
  test('a failure reads as an error, a mention as information, anything unknown as waiting', () => {
    expect(toneOf('run_failed')).toBe('down');
    expect(toneOf('lease_timeout')).toBe('down');
    expect(toneOf('mention')).toBe('info');
    expect(toneOf('approval')).toBe('warn');
    expect(toneOf('imessage_draft')).toBe('warn');
    expect(toneOf('something_this_build_has_never_seen')).toBe('warn');
  });

  test('a draft kind reads as "iMessage draft"; every other kind stays honest about itself', () => {
    expect(kindLabel('imessage_draft')).toBe('iMessage draft');
    expect(kindLabel('run_failed')).toBe('run failed');
    expect(kindLabel('something_this_build_has_never_seen')).toBe('something this build has never seen');
  });

  test('an expiry in the past reads as expired, and a missing one renders nothing', () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    expect(expiryLabel(null, now)).toBeNull();
    expect(expiryLabel('2026-09-22T11:55:00Z', now)).toBe('expired');
    expect(expiryLabel('2026-09-22T12:05:00Z', now)).toBe('expires in 5m');
  });
});
