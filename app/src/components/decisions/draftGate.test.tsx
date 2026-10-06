// An iMessage-draft card answered end to end through the write gate: the
// challenge, the device-key proof, then /answer carrying the same body every
// other card sends. It lives in its own file because it arms the gate with a
// signer, and a registered signer stays for the life of the module registry —
// DecisionsScreen.test.tsx needs the unarmed gate.
jest.mock('expo-router', () => ({
  useScrollToTop: () => {},
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require('react');
    useEffect(callback, [callback]);
  },
  useIsFocused: () => true,
}));

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef((props: object, _ref: unknown) => React.createElement(View, props)),
  };
});

jest.mock('../briefs', () => ({
  ...jest.requireActual('../briefs'),
  openBrief: jest.fn(),
}));

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

jest.mock('../../lib/query', () => ({
  ...jest.requireActual('../../lib/query'),
  usePoll: jest.fn(),
}));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { api, registerGateSigner, type AssertionChallenge, type GateProof } from '../../lib/api';
import { usePoll } from '../../lib/query';
import type { Decision, DecisionsReport } from '../../lib/types';
import { Toast } from '../shell';
import DecisionsScreen from './DecisionsScreen';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
const BASE = 'https://hub.example.com/api';

const CHALLENGE: AssertionChallenge = {
  challenge: 'c2FtcGxlLWNoYWxsZW5nZQ',
  rp_id: 'hub.example.com',
  user_verification: 'required',
  allowed_credentials: [],
  timeout_ms: 60000,
};
const PROOF: GateProof = {
  devicekey_assertion: { key_id: 'k1', challenge_b64: CHALLENGE.challenge, signature_b64: 'c2ln' },
};
const signer = jest.fn(async (_challenge: AssertionChallenge) => PROOF);
registerGateSigner(signer);

const DRAFT: Decision = {
  id: 'imessage-draft-42',
  title: 'Approve iMessage draft',
  summary: 'To Example Contact: running ten minutes late',
  source: 'imessage',
  created: '2026-09-10T12:00:00Z',
  status: 'open',
  category: 'required',
  options: [
    { key: 'once', label: 'Approve & send' },
    { key: 'deny', label: 'Discard' },
  ],
  draft_id: 42,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function serve(open: Decision[]) {
  const data: DecisionsReport = { open, answered: [], errors: [], updated_at: '' };
  (usePoll as jest.Mock).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    dataUpdatedAt: Date.now(),
    refetch: jest.fn(),
  });
}

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={new QueryClient()}>
        <SafeAreaProvider initialMetrics={METRICS}>
          <DecisionsScreen />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );
  });
  return renderer;
}

function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const found = renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(found).toHaveLength(1);
  return act(async () => {
    found[0].props.onPress();
  });
}

const calls = () => (global.fetch as jest.Mock).mock.calls as [string, RequestInit][];
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

test('approving a draft: challenge, then the device-key proof, then /answer', async () => {
  serve([DRAFT]);
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(jsonResponse(CHALLENGE))
    .mockResolvedValueOnce(
      jsonResponse({ status: 'answered', answered_at: '2026-09-10T12:01:00Z', draft: { draft_id: 42, status: 'sent' } }),
    );
  const renderer = await render();

  await press(renderer, 'Approve & send');

  expect(calls().map(([url]) => url)).toEqual([
    `${BASE}/decisions/imessage-draft-42/challenge`,
    `${BASE}/decisions/imessage-draft-42/answer`,
  ]);
  expect(bodyOf(calls()[0])).toEqual({ option_key: 'once', note: null });
  expect(signer).toHaveBeenCalledTimes(1);
  expect(signer).toHaveBeenCalledWith(CHALLENGE);
  // The answer is the challenged body plus the proof — nothing else, nothing less.
  expect(bodyOf(calls()[1])).toEqual({ option_key: 'once', note: null, ...PROOF });
  expect(renderer.root.findByType(Toast).props).toMatchObject({
    kind: 'ok',
    text: 'Answered — logged to the response ledger.',
  });
});

test('a refused proof leaves the draft unsent and says why', async () => {
  serve([DRAFT]);
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(jsonResponse(CHALLENGE))
    .mockResolvedValueOnce(jsonResponse({ detail: { code: 'assertion_invalid', detail: 'bad proof' } }, 403));
  const renderer = await render();

  await press(renderer, 'Discard');

  expect(bodyOf(calls()[1])).toEqual({ option_key: 'deny', note: null, ...PROOF });
  expect(renderer.root.findByType(Toast).props).toMatchObject({ kind: 'err', text: 'Face ID did not verify.' });
});

test('no shipped source can answer a decision past the gate', () => {
  expect('answerDraftDecision' in api).toBe(false);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const shipped = [resolve(__dirname, '../..'), resolve(__dirname, '../../../app')]
    .flatMap(walk)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
  expect(shipped.length).toBeGreaterThan(50);
  expect(shipped.filter((f) => readFileSync(f, 'utf8').includes('draft-answer'))).toEqual([]);
});
