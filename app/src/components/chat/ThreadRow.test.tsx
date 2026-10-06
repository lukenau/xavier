// Every pill and the preview line on a thread row, against the fields
// chat/routes.py's `_thread_payload` actually sends. The rule the whole batch
// turns on: a row shows a value the server gave it, or shows nothing.
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import type { Thread } from '../../chat/types';
import { previewLine, ThreadRow } from './ThreadRow';

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thr_1',
    kind: 'chat',
    title: 'Fast sleeve',
    status: 'idle',
    pinned: false,
    archived: false,
    last_seq: 3,
    created_at: '2026-09-22T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 3,
    unread: 0,
    preview: null,
    preview_role: null,
    hermes_session_id: null,
    origin_thread_id: null,
    origin_message_id: null,
    ...overrides,
  };
}

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) => {
    const children = n.props.children;
    return Array.isArray(children) ? children.join('') : String(children);
  });
}

function row(t: Thread, props: Partial<React.ComponentProps<typeof ThreadRow>> = {}) {
  return render(
    <ThreadRow
      thread={t}
      needsYou={false}
      attentionSummary={null}
      originLabel={null}
      onPress={() => {}}
      {...props}
    />,
  );
}

describe('previewLine', () => {
  it('prefers the open attention summary over the last thing said', () => {
    const t = thread({ preview: 'ran the backup', preview_role: 'assistant' });
    expect(previewLine(t, 'terminal: rm -rf')).toBe('terminal: rm -rf');
  });

  it('falls back to the last message — the line a quiet thread had none of', () => {
    const t = thread({ preview: 'ran the backup', preview_role: 'assistant' });
    expect(previewLine(t, null)).toBe('ran the backup');
  });

  it("marks the user's own words as his, so his message does not read as Xavier's", () => {
    const t = thread({ preview: 'what did i miss', preview_role: 'user' });
    expect(previewLine(t, null)).toBe('You: what did i miss');
  });

  it('is null when the server sent no preview and nothing is waiting', () => {
    expect(previewLine(thread(), null)).toBeNull();
  });
});

describe('ThreadRow pills', () => {
  it('badges a thread the gateway opened, and never a plain chat', () => {
    expect(texts(row(thread({ kind: 'cron' })))).toContain('Cron');
    expect(texts(row(thread({ kind: 'chat' })))).not.toContain('Chat');
  });

  it('falls back to the raw kind for one this build has no label for', () => {
    expect(texts(row(thread({ kind: 'inbox' })))).toContain('inbox');
  });

  it('shows provenance only when the caller could name an origin', () => {
    expect(texts(row(thread(), { originLabel: 'Brief' }))).toContain('from Brief');
    expect(texts(row(thread())).some((s) => s.startsWith('from '))).toBe(false);
  });

  it('renders pinned and unread from their own fields', () => {
    const t = thread({ pinned: true, unread: 4 });
    const shown = texts(row(t, { needsYou: true }));
    expect(shown).toEqual(expect.arrayContaining(['pinned', '4 new']));
  });

  it('carries no needs-you pill — the section head and the amber dot already say it', () => {
    const shown = texts(row(thread({ pinned: true }), { needsYou: true }));
    expect(shown).not.toContain('needs you');
  });

  it('renders no pill row at all for a plain, read, unpinned thread', () => {
    const shown = texts(row(thread()));
    expect(shown.filter((s) => s === 'needs you' || s === 'pinned' || s.endsWith(' new'))).toEqual([]);
  });

  it('puts the preview under the title', () => {
    const t = thread({ preview: 'ran the backup', preview_role: 'assistant' });
    expect(texts(row(t))).toContain('ran the backup');
  });
});

describe('the working dot', () => {
  // `thread.status` is on the wire but nothing sets it, so every thread used to
  // look idle (the user, 2026-09-22: "show an active color dot signal on the threads
  // that are actively working").
  function dotColor(tree: TestRenderer.ReactTestRenderer): unknown {
    const dot = tree.root.findAll((n) => n.props.testID === 'thread-status-dot')[0];
    const flat = [dot.props.style].flat(Infinity) as Array<Record<string, unknown>>;
    return flat.reduce((acc, s) => (s && s.backgroundColor ? s.backgroundColor : acc), undefined as unknown);
  }

  it('is the accent while a turn runs, and not otherwise', () => {
    const idle = dotColor(row(thread()));
    const working = dotColor(row(thread(), { working: true }));
    expect(working).not.toEqual(idle);
    expect(working).toBeDefined();
  });

  it('gives way to the amber of a thread that needs the user', () => {
    const needs = dotColor(row(thread(), { needsYou: true }));
    const needsAndWorking = dotColor(row(thread(), { needsYou: true, working: true }));
    expect(needsAndWorking).toEqual(needs);
  });
});
