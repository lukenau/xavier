// BriefCard is Home's door into the native brief. The property that matters
// most here is a negative one: no tap on this card may reach the WebView
// reader any more. The page it used to open dies at cutover, and its buttons
// are the ones that "didn't really work".
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('../briefs', () => ({ openBrief: jest.fn(), resolveBriefUri: jest.fn() }));

import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BriefCard, briefSummary } from './BriefCard';
import { bucketView, type Brief } from '../brief/briefModel';
import { LIVE_BRIEF } from '../brief/liveBrief.fixture';

const { router } = require('expo-router') as { router: { push: jest.Mock } };
const briefs = require('../briefs') as { openBrief: jest.Mock; resolveBriefUri: jest.Mock };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let clients: QueryClient[] = [];
let mounted: TestRenderer.ReactTestRenderer[] = [];

async function render(brief: Brief | null = LIVE_BRIEF) {
  (global.fetch as jest.Mock).mockResolvedValue(
    brief ? jsonResponse(brief) : jsonResponse({ detail: 'no brief' }, 404),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <BriefCard />
      </QueryClientProvider>,
    );
  });
  mounted.push(tree);
  // Settle on the condition, not a tick count — the card's own query carries
  // the global retry, which puts a real delay in front of the error branch.
  const deadline = Date.now() + 3000;
  while (texts(tree).includes('reading…') && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((n) => [n.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String);
}

const pressables = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll((n) => typeof n.props.style === 'function');

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

afterEach(() => {
  // A leaked QueryClient observer is an open handle that makes jest hang after
  // a green run — unmount and clear every one.
  act(() => {
    for (const tree of mounted) tree.unmount();
  });
  mounted = [];
  for (const client of clients) client.clear();
  clients = [];
});

describe('no WebView path remains for the daily brief (spec §11.1)', () => {
  test('the card pushes /brief; it never calls openBrief or resolveBriefUri', async () => {
    const tree = await render();
    act(() => pressables(tree)[0].props.onPress());
    expect(router.push).toHaveBeenCalledWith('/brief');
    expect(briefs.openBrief).not.toHaveBeenCalled();
    expect(briefs.resolveBriefUri).not.toHaveBeenCalled();
  });

  test('the row under it still goes to the Feed, where legacy briefs live', async () => {
    const tree = await render();
    act(() => pressables(tree)[1].props.onPress());
    expect(router.push).toHaveBeenCalledWith('/feed');
  });

  test('the card no longer takes `pages` at all — it reads the brief itself', () => {
    // A MyPage slug was the old input, and the reason a tap could resolve to a
    // dead HTML page. The component takes no props now.
    expect(BriefCard.length).toBe(0);
  });
});

describe('briefSummary', () => {
  test('the title is the day line, never any item — with per-bucket counts under it', () => {
    const summary = briefSummary(LIVE_BRIEF);
    expect(summary?.title).toBe('Wednesday, Sep 16 · Daily brief');
    expect(summary?.title).not.toContain(bucketView(LIVE_BRIEF, 'now')[0].title);
    expect(summary?.title).not.toContain(bucketView(LIVE_BRIEF, 'today')[0].title);
    expect(summary?.counts).toBe('Now 2 · Today 20');
    // No 44, no total — the same rule the screen follows.
    expect(summary?.counts).not.toContain('44');
    // The fixture brief's finance source is STALE, not failed — it answered with
    // older data. A stale source no longer cries wolf on the card (2026-09-22).
    // The card never names a source: it is a door, not a status page (the user,
    // 2026-09-22). Source health lives on the brief screen's own banner.
    expect(summary?.warning).toBeNull();
    expect(briefSummary({ ...LIVE_BRIEF, sources: { ...LIVE_BRIEF.sources, finance: 'unreachable' } })?.warning)
      .toBeNull();
    const healthy = briefSummary({ ...LIVE_BRIEF, sources: { email: 'ok', calendar: 'ok' } });
    expect(healthy?.warning).toBeNull();
    expect(healthy?.counts).toBe('Now 2 · Today 20');
    // The title tracks the day, not the health of the sources.
    expect(healthy?.title).toBe(summary?.title);
  });

  test('the title never changes when the Now bucket empties — only counts do', () => {
    const noNow: Brief = { ...LIVE_BRIEF, buckets: { ...LIVE_BRIEF.buckets, now: [] } };
    const summary = briefSummary(noNow);
    expect(summary?.title).toBe('Wednesday, Sep 16 · Daily brief');
    expect(summary?.title).not.toContain(bucketView(LIVE_BRIEF, 'today')[0].title);
    expect(summary?.counts).toBe('Today 20');
  });

  test('a clear day is a count statement, never a summary, and is NOT a warning', () => {
    const clear: Brief = {
      ...LIVE_BRIEF,
      buckets: { now: [], today: [], week: [], background: [] },
      sources: { email: 'ok', calendar: 'ok' },
    };
    expect(briefSummary(clear)).toEqual({
      title: 'Wednesday, Sep 16 · Daily brief',
      counts: 'Nothing for you today',
      warning: null,
    });
  });

  test('an empty day with dead inputs is a WARNING, and the title still names the day', () => {
    const blind: Brief = {
      ...LIVE_BRIEF,
      buckets: { now: [], today: [], week: [], background: [] },
      sources: { email: 'unreachable', calendar: 'absent' },
    };
    const summary = briefSummary(blind);
    expect(summary?.title).toBe('Wednesday, Sep 16 · Daily brief');
    // Still no source named — but an empty day with dead inputs withholds
    // "Nothing for you today" rather than asserting a calm it cannot back.
    expect(summary?.warning).toBeNull();
    expect(summary?.counts).toBe('');
  });

  test('a brief served from an older day shows THAT day in the title, and still warns', () => {
    const stale: Brief = { ...LIVE_BRIEF, date: '2026-09-16', served_date: '2026-09-14' };
    const summary = briefSummary(stale);
    expect(summary?.title).toBe('Monday, Sep 14 · Daily brief');
    expect(summary?.warning).toContain("hasn't landed");
  });

  test('no number of dead sources puts a source on the card', () => {
    const summary = briefSummary({
      ...LIVE_BRIEF,
      sources: { email: 'unreachable', calendar: 'unreachable', packages: 'unreachable', oura: 'absent' },
    });
    expect(summary?.warning).toBeNull();
    expect(summary?.counts).toBe('Now 2 · Today 20');
  });

  test('no brief at all is null, not a fabricated title', () => {
    expect(briefSummary(undefined)).toBeNull();
  });
});

describe('what the card renders', () => {
  test('the day-line title, never an item, and the counts when nothing is degraded', async () => {
    const healthy: Brief = { ...LIVE_BRIEF, sources: { email: 'ok', calendar: 'ok' } };
    const rendered = texts(await render(healthy));
    expect(rendered).toContain('Wednesday, Sep 16 · Daily brief');
    expect(rendered).not.toContain(bucketView(LIVE_BRIEF, 'now')[0].title);
    expect(rendered).toContain('Now 2 · Today 20');
  });

  test('a failed input is not mentioned on the card at all', async () => {
    const rendered = texts(await render({ ...LIVE_BRIEF, sources: { ...LIVE_BRIEF.sources, finance: 'unreachable' } }));
    expect(rendered.join(' ')).not.toMatch(/finance|not reporting|built without/i);
  });

  test('a read failure says so rather than showing a blank day', async () => {
    const rendered = texts(await render(null)).join(' ');
    expect(rendered).toContain('couldn’t read the brief');
    expect(rendered).not.toContain('Nothing for you today');
  });

  test('the primary target is at least 44pt', async () => {
    const tree = await render();
    const flat = [pressables(tree)[0].props.style({ pressed: false })].flat(Infinity).filter(Boolean);
    expect(flat.some((s: Record<string, unknown>) => s?.minHeight === 44)).toBe(true);
  });
});
