// The thread header's overflow (A23) — pin, rename, archive. All three are
// columns the thread already has (`threads.pinned` / `title` / `archived`) and
// all three go through one route, chat/routes.py's `POST /threads/{id}/patch`,
// cookie-gated like mark-read.
//
// A native Alert rather than a sheet route: three actions on a pushed screen do
// not earn a route of their own, and `Alert.prompt` is the OS's own rename box.
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { api } from '../../lib/api';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { useChatStore } from '../../chat/store';
import type { Thread, ThreadPatchInput } from '../../chat/types';
import { PRESSED_OPACITY } from '../shell';

export interface ThreadMenuAction {
  key: 'pin' | 'rename' | 'archive';
  label: string;
  /** Absent for `rename`: its value is whatever the user types. */
  patch?: ThreadPatchInput;
}

/** Each action's label is the thing it will DO, read off the thread's current
 * state — an already-pinned thread offers Unpin. Pure, so the labelling is
 * testable without an Alert. */
export function threadMenuActions(thread: Thread): ThreadMenuAction[] {
  return [
    { key: 'pin', label: thread.pinned ? 'Unpin' : 'Pin', patch: { pinned: !thread.pinned } },
    { key: 'rename', label: 'Rename…' },
    { key: 'archive', label: thread.archived ? 'Unarchive' : 'Archive', patch: { archived: !thread.archived } },
  ];
}

export function ThreadMenuButton({
  thread,
  onError,
}: {
  thread: Thread;
  onError: (message: string) => void;
}) {
  const { t } = useTheme();
  const hydrateSnapshot = useChatStore((s) => s.hydrateSnapshot);

  async function apply(patch: ThreadPatchInput, verb: string) {
    try {
      const { thread: patched } = await api.chatPatchThread(thread.id, patch);
      // The response is a full thread summary, so folding it in is the whole
      // update — the socket's own `thread.patch` frame lands on the same state.
      hydrateSnapshot(patched, []);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : `Could not ${verb} this thread — nothing changed. Try again.`,
      );
    }
  }

  function rename() {
    Alert.prompt(
      'Rename thread',
      undefined,
      (text) => {
        const title = text.trim();
        if (title) void apply({ title }, 'rename');
      },
      'plain-text',
      thread.title ?? '',
    );
  }

  function open() {
    const actions = threadMenuActions(thread);
    Alert.alert(
      thread.title?.trim() || 'Thread',
      undefined,
      [
        ...actions.map((action) => ({
          text: action.label,
          onPress: () =>
            action.key === 'rename' ? rename() : void apply(action.patch!, action.label.toLowerCase()),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Thread actions"
      onPress={open}
      style={({ pressed }) => [styles.button, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <Text style={[styles.glyph, { color: t('fg-3') }]}>⋯</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minWidth: 36, minHeight: 36, alignItems: 'flex-end', justifyContent: 'center' },
  glyph: { fontFamily: fonts.sans(600), fontSize: 20, lineHeight: 22 },
});
