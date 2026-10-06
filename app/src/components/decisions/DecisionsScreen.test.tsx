// Decisions: the pure helpers, plus wiring-level tests that render the real
// screen. The gate tests deliberately let the REAL api.answerDecision run
// against a mocked fetch — the point is that a tap issues a genuine
// /decisions/{id}/challenge POST and then surfaces the typed gate error, never
// a stubbed success.
jest.mock('expo-router', () => ({
  // Screen arms the tab-re-press scroll with it; behaviour is asserted in Screen.test.tsx.
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

import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { ApplyError, GateNotWiredError, GATE_NOT_WIRED_MESSAGE } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { Decision, DecisionsReport } from '../../lib/types';
import { openBrief } from '../briefs';
import { StatePanel, Toast } from '../shell';
import { decisionErrorMessage, DecisionCard, evidenceTarget, stakesOf } from './DecisionCards';
import DecisionsScreen from './DecisionsScreen';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
const BASE = 'https://hub.example.com/api';

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-1',
    title: 'Rebalance the sleeve?',
    summary: 'Drift is 4.1%.',
    options: [
      { key: 'yes', label: 'Rebalance now', detail: '→ trades at the open', recommended: true },
      { key: 'no', label: 'Leave it' },
    ],
    source: 'trader',
    created: '2026-09-10T12:00:00',
    status: 'open',
    ...over,
  };
}

function report(over: Partial<DecisionsReport> = {}): DecisionsReport {
  return { open: [], answered: [], errors: [], updated_at: '', ...over };
}

function reportState(data: DecisionsReport | undefined, over: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    dataUpdatedAt: Date.now(),
    refetch: jest.fn(),
    ...over,
  };
}

/** Every rendered string, with composite Text children (`{a}{b}`) joined. */
function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((n) => typeof n.props.children === 'string' || Array.isArray(n.props.children))
    .map((n) =>
      typeof n.props.children === 'string'
        ? n.props.children
        : (n.props.children as unknown[]).filter((c) => typeof c === 'string').join(''),
    );
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const found = renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(found).toHaveLength(1);
  return found[0];
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

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

describe('stakesOf', () => {
  test('the four known categories pass through', () => {
    for (const c of ['required', 'tradeoff', 'info', 'frozen']) {
      expect(stakesOf(decision({ category: c }))).toBe(c);
    }
  });

  test('missing or unknown folds into "required" — never under-alert', () => {
    expect(stakesOf(decision({ category: undefined }))).toBe('required');
    expect(stakesOf(decision({ category: 'whatever' }))).toBe('required');
  });
});

describe('decisionErrorMessage', () => {
  test.each([
    ['cancelled', 'Face ID cancelled.'],
    ['no_passkey', 'No passkey enrolled. Enrol Face ID in Security first.'],
    ['challenge_expired', 'That took too long — tap again.'],
    ['assertion_invalid', 'Face ID did not verify.'],
  ] as const)('%s → %s', (code, copy) => {
    expect(decisionErrorMessage(new ApplyError(code))).toBe(copy);
    expect(decisionErrorMessage(new GateNotWiredError(code))).toBe(copy);
  });

  test('an unmapped code falls back to the server detail verbatim', () => {
    expect(decisionErrorMessage(new ApplyError('bad_request', "unknown option_key 'x'"))).toBe(
      "unknown option_key 'x'",
    );
  });

  test('a gate with no signer surfaces its own message, not a fabricated one', () => {
    expect(decisionErrorMessage(new GateNotWiredError())).toBe(GATE_NOT_WIRED_MESSAGE);
  });

  test('a non-Error falls back to "Answer failed."', () => {
    expect(decisionErrorMessage('nope')).toBe('Answer failed.');
    expect(decisionErrorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('evidenceTarget', () => {
  const ORIGIN = 'https://hub.example.com';

  test('agent HTML on the hub host goes to the brief reader', () => {
    expect(evidenceTarget('/my-pages/rebalance/', ORIGIN)).toEqual({
      kind: 'brief',
      uri: `${ORIGIN}/my-pages/rebalance/`,
    });
  });

  test('anything else http(s) goes to the system browser', () => {
    expect(evidenceTarget('https://github.com/x/pull/1', ORIGIN)).toEqual({
      kind: 'external',
      uri: 'https://github.com/x/pull/1',
    });
    // Same host, but not agent HTML — the app shell must never be mounted in
    // the brief reader, so this is a browser link too.
    expect(evidenceTarget('/', ORIGIN)?.kind).toBe('external');
  });

  test('non-http(s) schemes resolve to nothing at all', () => {
    expect(evidenceTarget('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(evidenceTarget(null, ORIGIN)).toBeNull();
  });
});

describe('page states', () => {
  test('loading copy names the store it is reading', async () => {
    (usePoll as jest.Mock).mockReturnValue(reportState(undefined, { isLoading: true }));
    const renderer = await render();
    const panel = renderer.root.findByType(StatePanel);
    expect(panel.props.title).toBe('Reading the decision queue…');
    expect(panel.props.detail).toBe('decisions/*.json · via hub-api');
  });

  test('an error falls back to "hub-api unreachable" only when there is no message', async () => {
    (usePoll as jest.Mock).mockReturnValue(
      reportState(undefined, { isError: true, error: new Error('GET /decisions → 503') }),
    );
    let renderer = await render();
    expect(renderer.root.findByType(StatePanel).props.detail).toBe('GET /decisions → 503');

    (usePoll as jest.Mock).mockReturnValue(reportState(undefined, { isError: true, error: null }));
    renderer = await render();
    expect(renderer.root.findByType(StatePanel).props.detail).toBe('hub-api unreachable');
  });

  test('an empty queue reads "Queue clear"', async () => {
    (usePoll as jest.Mock).mockReturnValue(reportState(report()));
    const renderer = await render();
    expect(renderer.root.findByType(StatePanel).props.title).toBe('Queue clear');
  });

  test('the poll is the Decisions call site: key ["decisions"], 60s tuning', async () => {
    (usePoll as jest.Mock).mockReturnValue(reportState(report()));
    await render();
    expect(usePoll).toHaveBeenCalledWith(
      ['decisions'],
      expect.any(Function),
      QUERY_TUNING['decisions-page'],
    );
    expect(QUERY_TUNING['decisions-page'].refetchInterval).toBe(60_000);
  });
});

describe('stakes groups', () => {
  test('"Needs your answer" starts expanded; lower-stakes groups are header-only until tapped', async () => {
    (usePoll as jest.Mock).mockReturnValue(
      reportState(
        report({
          open: [
            decision({ id: 'req', category: 'required', title: 'Answer me' }),
            decision({ id: 'frz', category: 'frozen', title: 'Frozen one' }),
          ],
        }),
      ),
    );
    const renderer = await render();
    expect(renderer.root.findAllByType(DecisionCard).map((c) => c.props.decision.id)).toEqual(['req']);

    act(() => pressable(renderer, 'Frozen — on your instruction').props.onPress());
    expect(renderer.root.findAllByType(DecisionCard).map((c) => c.props.decision.id)).toEqual([
      'req',
      'frz',
    ]);
  });
});

describe('the answer gate', () => {
  test('tapping an option issues a REAL challenge POST and then surfaces the gate error — never a success toast', async () => {
    (usePoll as jest.Mock).mockReturnValue(reportState(report({ open: [decision()] })));
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ challenge: 'c', rp_id: 'r', user_verification: 'required', allowed_credentials: [], timeout_ms: 60000 }),
    );
    const renderer = await render();

    await act(async () => {
      pressable(renderer, 'Rebalance now').props.onPress();
    });

    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/decisions/dec-1/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_key: 'yes', note: null }),
    });
    // Exactly one call: the apply POST is never reached without an assertion.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);

    const toast = renderer.root.findByType(Toast);
    expect(toast.props.kind).toBe('err');
    expect(toast.props.text).toBe(GATE_NOT_WIRED_MESSAGE);
  });

  test('a server rejection at the challenge is mapped to its error copy', async () => {
    (usePoll as jest.Mock).mockReturnValue(reportState(report({ open: [decision()] })));
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ detail: { code: 'no_passkey', detail: 'No passkey registered.' } }, 412),
    );
    const renderer = await render();

    await act(async () => {
      pressable(renderer, 'Rebalance now').props.onPress();
    });

    const toast = renderer.root.findByType(Toast);
    expect(toast.props.kind).toBe('err');
    expect(toast.props.text).toBe('No passkey enrolled. Enrol Face ID in Security first.');
  });

  test('Dismiss sends the reserved option_key, not a note-only answer', async () => {
    (usePoll as jest.Mock).mockReturnValue(reportState(report({ open: [decision()] })));
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ detail: 'boom' }, 400));
    const renderer = await render();

    await act(async () => {
      pressable(renderer, 'Dismiss').props.onPress();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE}/decisions/dec-1/challenge`,
      expect.objectContaining({ body: JSON.stringify({ option_key: 'dismiss', note: null }) }),
    );
  });
});

// An automation's iMessage draft surfaces as a card carrying `draft_id`.
// Approving it sends a message, so it takes the same gate as every other card:
// a real challenge POST first, and nothing applied without an assertion.
describe('an iMessage draft card', () => {
  const draft = () =>
    decision({
      id: 'imessage-draft-42',
      title: 'Approve iMessage draft',
      summary: 'To Example Contact: running ten minutes late',
      source: 'imessage',
      options: [
        { key: 'once', label: 'Approve & send' },
        { key: 'deny', label: 'Discard' },
      ],
      draft_id: 42,
    });
  const urls = () => (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));

  test.each([
    ['Approve & send', 'once'],
    ['Discard', 'deny'],
  ])('%s posts the Face-ID challenge, never the ungated draft route', async (label, optionKey) => {
    (usePoll as jest.Mock).mockReturnValue(reportState(report({ open: [draft()] })));
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ challenge: 'c', rp_id: 'r', user_verification: 'required', allowed_credentials: [], timeout_ms: 60000 }),
    );
    const renderer = await render();

    await act(async () => {
      pressable(renderer, label).props.onPress();
    });

    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/decisions/imessage-draft-42/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_key: optionKey, note: null }),
    });
    // The challenge is the only call: with no signer there is no proof, so no
    // answer is applied, and no route answers a draft without one.
    expect(urls()).toEqual([`${BASE}/decisions/imessage-draft-42/challenge`]);
    expect(urls().some((u) => u.includes('draft-answer'))).toBe(false);
    expect(renderer.root.findByType(Toast).props.text).toBe(GATE_NOT_WIRED_MESSAGE);
  });
});

describe('evidence link', () => {
  test('a /my-pages evidence URL opens the brief reader, not the browser', async () => {
    (usePoll as jest.Mock).mockReturnValue(
      reportState(report({ open: [decision({ evidence_url: '/my-pages/drift-2026-09-10/' })] })),
    );
    const renderer = await render();

    act(() => pressable(renderer, 'evidence').props.onPress());

    expect(openBrief).toHaveBeenCalledWith(
      'https://hub.example.com/my-pages/drift-2026-09-10/',
      'Rebalance the sleeve?',
    );
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  test('an off-host evidence URL opens the browser, not the brief reader', async () => {
    (usePoll as jest.Mock).mockReturnValue(
      reportState(report({ open: [decision({ evidence_url: 'https://github.com/x/pull/1' })] })),
    );
    const renderer = await render();

    act(() => pressable(renderer, 'evidence').props.onPress());

    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://github.com/x/pull/1');
    expect(openBrief).not.toHaveBeenCalled();
  });
});

describe('answered rows', () => {
  const answered = (over: Partial<Decision>) =>
    decision({ id: 'a1', status: 'answered', answer: { option_key: 'yes', note: null, ts: '2026-09-10T13:00:00' }, ...over });

  test('a dismissed row reads "dismissed"; an answered row reads its option label', async () => {
    (usePoll as jest.Mock).mockReturnValue(
      reportState(
        report({
          answered: [
            answered({ id: 'a1' }),
            answered({
              id: 'a2',
              status: 'dismissed',
              answer: { option_key: 'dismiss', note: null, ts: '2026-09-10T13:00:00' },
            }),
          ],
        }),
      ),
    );
    const renderer = await render();
    const rendered = texts(renderer);
    expect(rendered.some((s) => s.startsWith('Rebalance now ·'))).toBe(true);
    expect(rendered.some((s) => s.startsWith('dismissed ·'))).toBe(true);
  });

  test('unreadable card files surface as an amber line, pluralised', async () => {
    (usePoll as jest.Mock).mockReturnValue(reportState(report({ errors: ['a.json', 'b.json'] })));
    const renderer = await render();
    expect(texts(renderer).some((s) => s.includes('unreadable card files: a.json, b.json'))).toBe(
      true,
    );
  });
});
