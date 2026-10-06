// The thread menu (A23): the three actions, the labels they carry, and what
// tapping one sends. Alert is the OS's own surface, so it is mocked and the
// assertions are on the buttons handed to it.
import TestRenderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import { useChatStore } from '../../chat/store';
import type { Thread } from '../../chat/types';
import { ThreadMenuButton, threadMenuActions } from './ThreadMenu';

const mockPatch = jest.fn();
jest.mock('../../lib/api', () => ({
  api: { chatPatchThread: (...args: unknown[]) => mockPatch(...args) },
}));

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thr_1',
    kind: 'chat',
    title: 'Fast sleeve',
    status: 'idle',
    pinned: false,
    archived: false,
    last_seq: 1,
    created_at: '2026-09-22T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
    last_read_seq: 1,
    unread: 0,
    preview: null,
    preview_role: null,
    hermes_session_id: null,
    origin_thread_id: null,
    origin_message_id: null,
    ...overrides,
  };
}

interface AlertButton {
  text: string;
  style?: string;
  onPress?: () => void;
}

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => active?.unmount());
  active = null;
  jest.restoreAllMocks();
  mockPatch.mockReset();
  useChatStore.getState().reset();
});

function openMenu(t: Thread, onError = jest.fn()): AlertButton[] {
  const buttons: AlertButton[] = [];
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, options) => {
    buttons.push(...((options ?? []) as AlertButton[]));
  });
  act(() => {
    active = TestRenderer.create(<ThreadMenuButton thread={t} onError={onError} />);
  });
  const button = (active as TestRenderer.ReactTestRenderer).root.find(
    (n) => n.props?.accessibilityLabel === 'Thread actions' && typeof n.props?.onPress === 'function',
  );
  act(() => button.props.onPress());
  return buttons;
}

describe('threadMenuActions', () => {
  it('labels each action with what it will do to THIS thread', () => {
    expect(threadMenuActions(thread()).map((a) => a.label)).toEqual(['Pin', 'Rename…', 'Archive']);
    expect(threadMenuActions(thread({ pinned: true, archived: true })).map((a) => a.label)).toEqual([
      'Unpin',
      'Rename…',
      'Unarchive',
    ]);
  });

  it('carries the exact patch each action sends — the flip, never the current value', () => {
    expect(threadMenuActions(thread()).map((a) => a.patch)).toEqual([
      { pinned: true },
      undefined,
      { archived: true },
    ]);
  });
});

describe('ThreadMenuButton', () => {
  it('offers the three actions plus a cancel', () => {
    const buttons = openMenu(thread());
    expect(buttons.map((b) => b.text)).toEqual(['Pin', 'Rename…', 'Archive', 'Cancel']);
    expect(buttons[3].style).toBe('cancel');
  });

  it('pinning PATCHes the thread and folds the server\'s own row back into the store', async () => {
    const patched = thread({ pinned: true, preview: 'ran the backup', preview_role: 'assistant' });
    mockPatch.mockResolvedValue({ thread: patched });
    const buttons = openMenu(thread());
    await act(async () => buttons[0].onPress?.());
    expect(mockPatch).toHaveBeenCalledWith('thr_1', { pinned: true });
    const stored = useChatStore.getState().chat.threads.thr_1.thread;
    expect(stored.pinned).toBe(true);
    // The patch response is a full summary, so the preview survives the fold.
    expect(stored.preview).toBe('ran the backup');
  });

  it('renames with what was typed, trimmed, and sends nothing for a blank', async () => {
    let submit!: (text: string) => void;
    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb) => {
      submit = cb as (text: string) => void;
    });
    mockPatch.mockResolvedValue({ thread: thread({ title: 'Backup retention' }) });
    const buttons = openMenu(thread());
    act(() => buttons[1].onPress?.());
    await act(async () => submit('   '));
    expect(mockPatch).not.toHaveBeenCalled();
    await act(async () => submit('  Backup retention  '));
    expect(mockPatch).toHaveBeenCalledWith('thr_1', { title: 'Backup retention' });
  });

  it('a refused write says so instead of showing a pin that did not stick', async () => {
    const onError = jest.fn();
    mockPatch.mockRejectedValue(new Error('chat locked — unlock with Face ID'));
    const buttons = openMenu(thread(), onError);
    await act(async () => buttons[0].onPress?.());
    expect(onError).toHaveBeenCalledWith('chat locked — unlock with Face ID');
    expect(useChatStore.getState().chat.threads.thr_1).toBeUndefined();
  });

  it('a failure with no message still names the action and what to do', async () => {
    const onError = jest.fn();
    mockPatch.mockRejectedValue('nope');
    const buttons = openMenu(thread(), onError);
    await act(async () => buttons[0].onPress?.());
    expect(onError).toHaveBeenCalledWith('Could not pin this thread — nothing changed. Try again.');
  });
});
