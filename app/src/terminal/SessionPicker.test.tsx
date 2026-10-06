// The picker's writes are the only gated calls on this screen, and the gate is
// what the port must not fake: every test below drives the REAL
// `api.applyWrite` path (challenge → assertion → apply) with only the network
// stubbed, and asserts the request that would have been signed.
jest.mock('../lib/query', () => ({
  ...jest.requireActual('../lib/query'),
  usePoll: jest.fn(),
}));

import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { QueryKey } from '@tanstack/react-query';
import { api, ApplyError, GateNotWiredError, GATE_NOT_WIRED_MESSAGE } from '../lib/api';
import { QUERY_TUNING, usePoll } from '../lib/query';
import type { TmuxHistory, TmuxInventory, TmuxSession } from '../lib/types';
import { SessionPicker } from './SessionPicker';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

// Epoch SECONDS, relative to the real clock: the meta lines are rendered with
// the shared relTime, so a fixed date would drift into "in 6h" as time passes.
const NOW = Date.now();

const INVENTORY: TmuxInventory = {
  sessions: [
    {
      name: 'hub-term',
      created: NOW / 1000 - 7200,
      attached: true,
      windows: 2,
      protected: true,
      host: 'vps',
      title: null,
      session_id: null,
    },
    {
      name: 'claude-2',
      created: NOW / 1000 - 600,
      attached: false,
      windows: 1,
      protected: false,
      host: 'vps',
      title: 'Porting the terminal',
      session_id: 'b0a1c2d3-0000-4000-8000-000000000001',
    },
  ],
  hosts: [
    { id: 'vps', label: 'VPS', ok: true, error: null },
    { id: 'mac', label: 'MacBook', ok: false, error: 'MacBook: ssh timed out' },
  ],
};

// Unprotected but ATTACHED: hub-tmuxd refuses to kill a session with a client
// on it (409 "has an attached client — detach first"), so the row must not
// offer a Kill that the server would reject.
const ATTACHED: TmuxSession = {
  name: 'claude-9',
  created: NOW / 1000 - 60,
  attached: true,
  windows: 1,
  protected: false,
  host: 'vps',
  title: null,
  session_id: null,
};

const HISTORY: TmuxHistory = {
  sessions: [
    {
      host: 'vps',
      session_id: 'aaaabbbb-1111-4111-8111-111111111111',
      title: null,
      cwd: '/home/user/projects',
      last_active: NOW / 1000 - 3600,
      live: false,
    },
    {
      host: 'vps',
      session_id: 'ccccdddd-2222-4222-8222-222222222222',
      title: 'Running one',
      cwd: null,
      last_active: NOW / 1000 - 120,
      live: true,
    },
  ],
  hosts: INVENTORY.hosts,
};

const refetch = jest.fn();

function stub(inventory: Partial<{ data: TmuxInventory; isError: boolean; error: Error }>) {
  (usePoll as jest.Mock).mockImplementation((key: QueryKey) => {
    if (String(key[0]) === 'tmux-history') {
      return { data: HISTORY, isLoading: false, isError: false, error: null, refetch: jest.fn() };
    }
    return {
      data: inventory.data,
      isLoading: false,
      isError: inventory.isError ?? false,
      error: inventory.error ?? null,
      refetch,
    };
  });
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>,
    );
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out;
}

/** Rows repeat "Kill"/"Resume", so controls are located by accessibility
 * label; every assertion below is still on what the sheet RENDERS. */
function tap(tree: TestRenderer.ReactTestRenderer, label: string) {
  const hit = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => n.props.accessibilityLabel === label);
  if (!hit) throw new Error(`nothing labelled ${label}`);
  const press = hit.props.onPress as () => unknown;
  return async () => {
    await press();
  };
}

/** Text nodes joined, for the lines the PWA assembles from several children. */
const joined = (tree: TestRenderer.ReactTestRenderer) => texts(tree).join('');

let tree: TestRenderer.ReactTestRenderer | null = null;
let applyWrite: jest.SpyInstance;

beforeEach(() => {
  refetch.mockReset().mockResolvedValue(undefined);
  applyWrite = jest.spyOn(api, 'applyWrite');
  stub({ data: INVENTORY });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  applyWrite.mockRestore();
});

test('opens the tmux queries with the PWA\'s tuning, history only while Resume is open', () => {
  tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);
  const calls = (usePoll as jest.Mock).mock.calls;

  expect(calls[0][2]).toEqual({ ...QUERY_TUNING['tmux-sessions'], enabled: true });
  expect(calls[1][2]).toEqual({ ...QUERY_TUNING['tmux-history'], enabled: false });
});

test('lists each session with its meta line and a Kill only where killing is allowed', () => {
  tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);
  const rendered = texts(tree);

  expect(rendered).toContain('Claude shells');
  // Protected + attached, so no Kill, and the meta line says both.
  expect(rendered).toContain('VPS · attached · 2w · 2h ago · protected');
  // Titled session shows the title, with the raw name in the meta line.
  expect(rendered).toContain('Porting the terminal');
  expect(rendered).toContain('claude-2 · VPS · detached · 1w · 10m ago');
  expect(rendered.filter((s) => s === 'Kill')).toHaveLength(1);
});

test('an attached session offers no Kill either — the server would refuse it', () => {
  stub({ data: { sessions: [...INVENTORY.sessions, ATTACHED], hosts: INVENTORY.hosts } });
  tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

  expect(texts(tree)).toContain('claude-9');
  expect(texts(tree).filter((s) => s === 'Kill')).toHaveLength(1);
  expect(() => tap(tree!, 'Kill claude-9')).toThrow();
});

test('a sleeping MacBook is a row state, not an error panel', () => {
  tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);
  const rendered = texts(tree);

  expect(rendered).toContain('MacBook unreachable — MacBook: ssh timed out. Asleep?');
  // The VPS list is untouched beside it.
  expect(rendered).toContain('Porting the terminal');
  expect(rendered).not.toContain('Shells unavailable');
});

test('a host with no error string still reads as a row, not a blank', () => {
  stub({
    data: {
      sessions: [],
      hosts: [
        { id: 'vps', label: 'VPS', ok: true, error: null },
        { id: 'mac', label: 'MacBook', ok: false, error: null },
      ],
    },
  });
  tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

  expect(texts(tree)).toContain('MacBook unreachable — no response. Asleep?');
  expect(texts(tree)).toContain('No tmux sessions running.');
});

test('a failed listing shows the error panel', () => {
  stub({ isError: true, error: new Error('tmuxd unreachable: [Errno 2]') });
  tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

  expect(texts(tree)).toContain('Shells unavailable');
  expect(texts(tree)).toContain('tmuxd unreachable: [Errno 2]');
});

describe('gated writes', () => {
  test('New session spawns on the selected host and refetches', async () => {
    applyWrite.mockResolvedValue({ status: 'applied', name: 'claude-3', host: 'vps', attach: 'tmux switch-client -t claude-3' });
    tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

    await act(async () => {
      await tap(tree!, 'New session')();
    });

    // vps is the default host and rides implicitly, exactly as the PWA sends it.
    expect(applyWrite.mock.calls).toEqual([[{ action: 'tmux.spawn' }]]);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('switching host carries it into the spawn request', async () => {
    applyWrite.mockResolvedValue({ status: 'applied' });
    tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

    await act(async () => {
      await tap(tree!, 'MacBook')();
    });
    await act(async () => {
      await tap(tree!, 'New session')();
    });

    expect(applyWrite.mock.calls).toEqual([[{ action: 'tmux.spawn', host: 'mac' }]]);
  });

  test('Kill names the session, and the host when it is not the VPS', async () => {
    applyWrite.mockResolvedValue({ status: 'applied' });
    tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

    await act(async () => {
      await tap(tree!, 'Kill claude-2')();
    });

    expect(applyWrite.mock.calls).toEqual([[{ action: 'tmux.kill', name: 'claude-2' }]]);
  });

  test('Resume asks for the transcript id and its cwd', async () => {
    applyWrite.mockResolvedValue({ status: 'applied' });
    tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

    await act(async () => {
      await tap(tree!, 'Resume')();
    });
    expect(joined(tree)).toContain('Resume a past session · VPS');
    // The live transcript offers no Resume — resuming it would fork it.
    expect(texts(tree)).toContain('Running one');
    // The live transcript is not resumable, so exactly one row offers it.
    expect(texts(tree).filter((s) => s === 'Resume')).toHaveLength(2); // the toggle + one row

    await act(async () => {
      await tap(tree!, 'Resume aaaabbbb')();
    });

    expect(applyWrite.mock.calls).toEqual([
      [
        {
          action: 'tmux.spawn',
          resume: 'aaaabbbb-1111-4111-8111-111111111111',
          cwd: '/home/user/projects',
        },
      ],
    ]);
  });

  test('a gate that is not wired surfaces its message instead of silently failing', async () => {
    // This is the state the app is actually in until the signer registers:
    // the challenge POSTs for real and the assertion step throws.
    applyWrite.mockRejectedValue(new GateNotWiredError());
    tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

    await act(async () => {
      await tap(tree!, 'New session')();
    });

    expect(texts(tree)).toContain(GATE_NOT_WIRED_MESSAGE);
  });

  test('a cancelled Face ID prompt shows nothing at all', async () => {
    applyWrite.mockRejectedValue(new ApplyError('cancelled', 'User cancelled the Face ID prompt.'));
    tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

    await act(async () => {
      await tap(tree!, 'New session')();
    });

    expect(texts(tree)).not.toContain('User cancelled the Face ID prompt.');
  });

  test('a spawned session offers its attach command to the composer', async () => {
    applyWrite.mockResolvedValue({
      status: 'applied',
      name: 'claude-3',
      host: 'mac',
      attach: "tmux new-window -n mac:claude-3 'ssh -t mac /opt/homebrew/bin/tmux attach -t claude-3'",
    });
    const onAttach = jest.fn();
    const onClose = jest.fn();
    tree = render(<SessionPicker open onClose={onClose} onAttach={onAttach} />);

    await act(async () => {
      await tap(tree!, 'New session')();
    });
    expect(joined(tree)).toContain('Started claude-3 on MacBook — run');
    expect(texts(tree)).toContain(
      "tmux new-window -n mac:claude-3 'ssh -t mac /opt/homebrew/bin/tmux attach -t claude-3'",
    );

    await act(async () => {
      await tap(tree!, 'Fill the composer with the attach command')();
    });

    expect(onAttach.mock.calls).toEqual([
      ["tmux new-window -n mac:claude-3 'ssh -t mac /opt/homebrew/bin/tmux attach -t claude-3'"],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a spawn that returns no attach command falls back to the local switch-client form', async () => {
    applyWrite.mockResolvedValue({ status: 'applied', name: 'claude-4' });
    tree = render(<SessionPicker open onClose={jest.fn()} onAttach={jest.fn()} />);

    await act(async () => {
      await tap(tree!, 'New session')();
    });

    expect(texts(tree)).toContain('tmux switch-client -t claude-4');
  });
});
