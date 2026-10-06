// The gated write path, end to end, with nothing stubbed but the network.
//
// The brief's rule is that the Face-ID actions must go through the REAL
// api.applyWrite — challenge POST first, typed error second — rather than a
// stub that fakes success. That is exactly what this asserts: a tap on
// Approve puts the canonical WriteRequest on /api/action/challenge, and the
// GateNotWiredError that comes back out of the (not yet built) assertion step
// surfaces through the PWA's own writeErrorMessage copy rules.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { UseQueryResult } from '@tanstack/react-query';
import { router } from 'expo-router';
import { NeedsYou } from './NeedsYou';
import type { PairingReport } from '../../lib/types';
import type { ChatAttentionResponse } from '../../chat/types';
import { GATE_NOT_WIRED_MESSAGE } from '../../lib/api';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const BASE = 'https://hub.example.com/api';

const REPORT: PairingReport = {
  pending: [{ platform: 'telegram', code: 'ABC123', user_id: '4242', user_name: 'the user', age: '3m' }],
  approved: [],
  pending_count: 1,
  approved_count: 0,
};

function fakeQuery(over: Partial<UseQueryResult<PairingReport, Error>> = {}) {
  return {
    data: REPORT,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn().mockResolvedValue({}),
    ...over,
  } as unknown as UseQueryResult<PairingReport, Error>;
}

const DRAFT_ROW = {
  id: 'att_d',
  thread_id: 'thr_1',
  thread_title: 'Chat',
  thread_kind: 'chat',
  kind: 'imessage_draft',
  summary: 'to Mom: running 10 min late',
  created_at: '2026-10-03T00:00:00Z',
  expires_at_derived: null,
};

function fakeAttention(over: Partial<UseQueryResult<ChatAttentionResponse, Error>> = {}) {
  return {
    data: { attention: [DRAFT_ROW] },
    isLoading: false,
    isError: false,
    error: null,
    ...over,
  } as unknown as UseQueryResult<ChatAttentionResponse, Error>;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).flatMap((n) => {
    const kids = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
    return kids.filter((c: unknown): c is string => typeof c === 'string');
  });
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.resetAllMocks();
});

test('Approve posts the canonical request to /action/challenge, then surfaces the gate error', async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      challenge: 'Y2hhbGxlbmdl',
      rp_id: 'hub.example.com',
      user_verification: 'required',
      allowed_credentials: [{ id: 'cred-1', type: 'public-key' }],
      timeout_ms: 60000,
    }),
  });

  const q = fakeQuery();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <NeedsYou q={q} />
      </SafeAreaProvider>,
    );
  });

  const approve = renderer.root.find(
    (n) => typeof n.type === 'function' && n.props.accessibilityRole === 'button' && n.props.onPress,
  );
  await act(async () => {
    await approve.props.onPress();
  });

  // 1. The real challenge POST happened, with the exact WriteRequest body.
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(`${BASE}/action/challenge`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: { action: 'pairing.approve', platform: 'telegram', code: 'ABC123' } }),
  });
  // 2. Nothing was faked as applied: no refetch, and the error copy is on screen.
  expect(q.refetch).not.toHaveBeenCalled();
  expect(texts(renderer)).toContain(GATE_NOT_WIRED_MESSAGE);
  // 3. The button is back to its idle label, not stuck on "Approving…".
  expect(texts(renderer)).toContain('Approve');
});

test('an empty pending list renders the quiet line, not a card', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <NeedsYou q={fakeQuery({ data: { ...REPORT, pending: [], pending_count: 0 } })} />
      </SafeAreaProvider>,
    );
  });
  expect(texts(renderer)).toContain('Nothing needs you.');
  expect(texts(renderer)).not.toContain('Approve');
});

test('a failed pairing read shows the error panel with the server message', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <NeedsYou q={fakeQuery({ data: undefined, isError: true, error: new Error('pairing unavailable — bridge down') })} />
      </SafeAreaProvider>,
    );
  });
  const t = texts(renderer);
  expect(t).toContain('Pairing unavailable');
  expect(t).toContain('pairing unavailable — bridge down');
});

test('a draft row shows its summary and a Review that opens the draft thread', () => {
  const q = fakeQuery({ data: { ...REPORT, pending: [], pending_count: 0 } });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <NeedsYou q={q} attention={fakeAttention()} />
      </SafeAreaProvider>,
    );
  });
  const t = texts(renderer);
  expect(t).toContain('iMessage draft');
  expect(t).toContain('to Mom: running 10 min late');
  expect(t).toContain('Review');
  // With a draft waiting, the quiet line stays off even though pairings are empty.
  expect(t).not.toContain('Nothing needs you.');

  const row = renderer.root.find(
    (n) => n.props.accessibilityLabel === 'iMessage draft in Chat' && typeof n.props.onPress === 'function',
  );
  act(() => row.props.onPress());
  expect(router.push).toHaveBeenCalledWith({ pathname: '/chat/thread', params: { threadId: 'thr_1' } });
});
