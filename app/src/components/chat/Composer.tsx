// The chat composer — lifted from src/terminal/Composer.tsx (same TextInput
// shape, same `submitBehavior="submit"` / clipboard-paste native spellings;
// see that file's own header comment for why each exists) with the pty-only
// bits removed (no trailing '\r', no "command…" placeholder) and the
// Queue/Steer/Redirect segmented control + Stop the design reference adds
// for a chat turn in flight.
//
// `onSend` is wired to chat/routes.py's POST /send (ThreadScreen ->
// chat/hooks.ts's `useSendMessage`) — cookie-gated, never Face ID, same as
// every other route in that file. `onStop` still has nothing behind it:
// there is no turn-control route in this slice, so ThreadScreen keeps
// surfacing an honest "not live yet" notice for it.
//
// The `/` picker (VERDICT-V2 §4.6, the user's Claude-Code brief) lives here
// rather than in ThreadScreen: it needs the TextInput's live value AND
// cursor position, which only the component holding that state can track
// without lifting it. Selection tracking, slash-token detection, filtering,
// insertion and the unknown-command send gate are ALL pure functions in
// chat/commands.ts — this file is just the wiring: TextInput selection ->
// detectSlashContext -> <CommandSheet> -> insertCommandToken -> setValue.
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Clipboard, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../../lib/api';
import { usePoll } from '../../lib/query';
import {
  detectSlashContext,
  findUnknownLeadingCommand,
  insertCommandToken,
  type CommandCatalogEntry,
} from '../../chat/commands';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { CommandSheet } from './CommandSheet';
import {
  ATTACH_MESSAGE,
  attachPastedFile,
  attachPastedImage,
  formatBytes,
  isImageMime,
  pasteImage,
  pickFile,
  pickImage,
  type AttachOutcome,
  type PendingImage,
} from '../../chat/attachments';
import { PasteControl, available as pasteControlAvailable } from '../../../modules/paste-control';

export const MIN_HEIGHT = 38;
// Roughly eight lines before it scrolls — the field grew to about three and
// read as not growing at all (the user, 2026-09-22). Past this it scrolls, which
// is what every messaging app does rather than eating the conversation.
export const MAX_HEIGHT = 190;
export const PASTE_FLASH_MS = 1600;

export type ComposerMode = 'queue' | 'steer' | 'redirect';

const PLACEHOLDER = {
  ready: 'Message Xavier',
  loading: 'Loading conversation…',
  error: 'Thread unavailable',
} as const;

// The three are the gateway's own vocabulary, and they differ in a way worth
// one line: `steer()` injects at the next TOOL boundary and never interrupts,
// so a message sent while Xavier is only thinking sits there until the turn
// ends — which reads as queueing unless the difference is on screen (the user,
// 2026-09-22, who chose to keep the semantics and show them).
export const COMPOSER_MODES: { id: ComposerMode; label: string; hint: string }[] = [
  { id: 'queue', label: 'Queue', hint: 'waits for this turn to finish' },
  { id: 'steer', label: 'Steer', hint: 'lands at the next tool call' },
  { id: 'redirect', label: 'Redirect', hint: 'cuts in now' },
];

export interface ComposerHandle {
  fill: (text: string) => void;
}

/** Four is what fits across the strip without shrinking to nothing, and more
 * than four pictures in one message is a folder, not a message. */
export const MAX_ATTACHMENTS = 4;

export interface ComposerProps {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  onSend: (text: string, mode: ComposerMode, mediaIds: string[]) => void;
  /** Where an attachment is uploaded to. Without it the + button is hidden:
   * a picture has to belong to a thread. */
  threadId?: string;
  /** Whether the thread has a run in flight — gates the Stop button, not the
   * send button (queueing/steering while something runs is the point of the
   * mode control). */
  running: boolean;
  onStop: () => void;
  /** A stop request is in flight — the button waits rather than re-firing. */
  stopping?: boolean;
  /** Why there is nothing to send into yet. Never "locked": ChatLockGate
   * unmounts the whole thread while locked, so the composer only ever sees a
   * thread that is still loading or failed to. */
  unavailable?: 'loading' | 'error' | null;
  /** The thread's saved draft, seeding the field on mount. */
  initialDraft?: string;
  /** Reported on every keystroke so a half-written message survives leaving
   * the thread and coming back. */
  onDraftChange?: (text: string) => void;
}

/** How long a transient inline notice (unknown-command error, builtin-moved
 * hint) stays up — same duration class as `PASTE_FLASH_MS` just below. */
export const COMMAND_NOTICE_MS = 2600;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { mode, onModeChange, onSend, running, onStop, stopping = false, unavailable = null, initialDraft = '', onDraftChange, threadId },
  ref,
) {
  const { t } = useTheme();
  const [value, setValueState] = useState(initialDraft);
  // Seeded from the thread's stored draft and reported back on every change.
  // ThreadScreen keys this component by thread id, so switching threads
  // remounts with the right seed rather than carrying a draft across.
  // `canSend` is read through the render closure, so the return key plus a tap
  // (or two batched taps) both passed it and one message went out twice. Set
  // synchronously on send; released by the next non-empty edit.
  const sendLatch = useRef(false);
  const setValue = useCallback(
    (next: string) => {
      if (next !== '') sendLatch.current = false;
      setValueState(next);
      onDraftChange?.(next);
    },
    [onDraftChange],
  );
  const [pasteFlash, setPasteFlash] = useState(false);
  const [attached, setAttached] = useState<PendingImage[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [commandNotice, setCommandNotice] = useState<{ kind: 'error' | 'hint'; text: string } | null>(null);
  const input = useRef<TextInput>(null);
  // A picture on its own is a message worth sending.
  const canSend = unavailable === null && (value.trim().length > 0 || attached.length > 0);

  // The catalog is a light, cookie-gated read shared by every open thread —
  // one poll per mounted composer, no per-keystroke round trip (VERDICT-V2
  // §4.6.3: "sourced from the last-published catalog").
  const commandsQuery = usePoll(['chat-commands'], api.chatCommands);
  const commands: CommandCatalogEntry[] = commandsQuery.data?.commands ?? [];

  const slashContext = useMemo(
    () => detectSlashContext(value, selection.end),
    [value, selection.end],
  );

  useImperativeHandle(ref, () => ({
    fill: (text: string) => {
      setValue(text);
      input.current?.focus();
    },
  }));

  const showNotice = (kind: 'error' | 'hint', text: string) => {
    setCommandNotice({ kind, text });
    setTimeout(() => setCommandNotice((n) => (n?.text === text ? null : n)), COMMAND_NOTICE_MS);
  };

  const selectCommand = (entry: CommandCatalogEntry) => {
    if (!slashContext) return;
    const wasAtStart = slashContext.start === 0;
    const result = insertCommandToken(value, slashContext.start, selection.end, entry);
    setValue(result.text);
    setSelection({ start: result.cursor, end: result.cursor });
    setDismissedTokenStart(null);
    input.current?.focus();
    if (result.placement === 'message-start' && !wasAtStart) {
      showNotice('hint', `Moved ${entry.name} to the start — commands only run from the beginning of a message.`);
    }
  };

  // A token the user closes stays closed until they type again — the next
  // keystroke clears this, so it reopens exactly when Claude Code's own
  // picker would (still typing the same token), not on an unrelated edit.
  const [dismissedTokenStart, setDismissedTokenStart] = useState<number | null>(null);
  const sheetOpen = slashContext !== null && dismissedTokenStart !== slashContext.start;

  const handleChangeText = (text: string) => {
    setValue(text);
    setDismissedTokenStart(null);
  };

  const send = () => {
    if (!canSend || sendLatch.current) return;
    // Belt-and-suspenders (VERDICT-V2 §4.6.3): a message that OPENS with an
    // unrecognized /token is never transmitted — there is no server-side
    // guard, so it would otherwise reach the model as plain prose.
    const unknown = findUnknownLeadingCommand(value, commands);
    if (unknown) {
      showNotice('error', `Unknown command: ${unknown}`);
      return;
    }
    sendLatch.current = true;
    onSend(value, mode, attached.map((a) => a.id));
    setValue('');
    setAttached([]);
  };

  const flashPasteHint = () => {
    setPasteFlash(true);
    setTimeout(() => setPasteFlash(false), PASTE_FLASH_MS);
  };

  // Pictures. Both routes land in the same place: uploaded to the thread, held
  // as an id, sent with the next message (the user asked for the + button and for
  // pasting, 2026-09-23).
  const attach = async (take: () => Promise<AttachOutcome>) => {
    if (!threadId || attached.length >= MAX_ATTACHMENTS) {
      if (attached.length >= MAX_ATTACHMENTS) showNotice('hint', `${MAX_ATTACHMENTS} attachments is the limit.`);
      return false;
    }
    setAttaching(true);
    try {
      const outcome = await take();
      if (outcome.ok) {
        // The gallery can hand back several at once; keep as many as there is
        // room for, in the order he picked them.
        const room = MAX_ATTACHMENTS - attached.length;
        setAttached((current) => [...current, ...outcome.images].slice(0, MAX_ATTACHMENTS));
        if (outcome.images.length > room) showNotice('hint', `${MAX_ATTACHMENTS} attachments is the limit.`);
        return true;
      }
      const message = ATTACH_MESSAGE[outcome.reason];
      if (message) showNotice(outcome.reason === 'empty' ? 'hint' : 'error', message);
      return false;
    } finally {
      setAttaching(false);
    }
  };

  /** One "+", two sources. A picture comes from the photo library, a file from
   * the Files app; the sheet is the platform's own, so it needs no design and
   * behaves the way every other iOS app's does. */
  const chooseAttachment = (id: string) => {
    // How many more the message has room for — the gallery allows that many,
    // so picking a second picture does not mean opening it again.
    const room = MAX_ATTACHMENTS - attached.length;
    if (Platform.OS !== 'ios') {
      void attach(() => pickImage(id, room));
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Photo', 'File', 'Cancel'], cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) void attach(() => pickImage(id, room));
        else if (index === 1) void attach(() => pickFile(id));
      },
    );
  };

  const paste = async () => {
    // A picture on the clipboard wins; otherwise this is the text paste it
    // always was.
    if (threadId && (await attach(() => pasteImage(threadId)))) {
      input.current?.focus();
      return;
    }
    try {
      const text = await Clipboard.getString();
      if (text) {
        setValue(value + text);
        input.current?.focus();
      } else {
        flashPasteHint();
      }
    } catch {
      flashPasteHint();
    }
  };

  return (
    <View style={[styles.wrap, { backgroundColor: t('bg-1'), borderTopColor: t('border') }]}>
      {/* Docked above the controls, inside the composer bar, so it sits on the
          keyboard rather than replacing the screen. */}
      <CommandSheet
        open={sheetOpen}
        onClose={() => setDismissedTokenStart(slashContext ? slashContext.start : null)}
        query={slashContext?.query ?? ''}
        commands={commands}
        running={running}
        onSelect={selectCommand}
      />
      {attached.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.thumbs}
          keyboardShouldPersistTaps="handled"
        >
          {attached.map((image) => (
            <Pressable
              key={image.id}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${image.name ?? 'this picture'}`}
              testID={`attachment-${image.id}`}
              onPress={() => setAttached((current) => current.filter((a) => a.id !== image.id))}
              style={[isImageMime(image.mime) ? styles.thumb : styles.fileThumb, { borderColor: t('border-strong') }]}
            >
              {isImageMime(image.mime) ? (
                <Image source={{ uri: image.uri }} style={styles.thumbImage} />
              ) : (
                <View style={styles.fileThumbBody}>
                  <Text numberOfLines={1} style={[styles.fileThumbName, { color: t('fg-1') }]}>
                    {image.name ?? 'File'}
                  </Text>
                  <Text numberOfLines={1} style={[styles.fileThumbSize, { color: t('fg-3') }]}>
                    {formatBytes(image.bytes)}
                  </Text>
                </View>
              )}
              <View style={[styles.thumbRemove, { backgroundColor: t('bg-0') }]}>
                <Text style={[styles.thumbRemoveLabel, { color: t('fg-1') }]}>×</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.toolRow}>
        <View style={[styles.segmented, { backgroundColor: t('bg-2'), borderColor: t('border') }]}>
          {COMPOSER_MODES.map((m) => {
            const active = m.id === mode;
            return (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => onModeChange(m.id)}
                style={[styles.segment, active && { backgroundColor: t('accent-soft') }]}
              >
                <Text style={[styles.segmentLabel, { color: active ? t('accent') : t('fg-3') }]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {running ? (
          <Text style={[styles.modeHint, { color: t('fg-3') }]} numberOfLines={1}>
            {COMPOSER_MODES.find((m) => m.id === mode)?.hint}
          </Text>
        ) : null}
        {running ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop"
            accessibilityState={{ disabled: stopping, busy: stopping }}
            disabled={stopping}
            onPress={onStop}
            style={[
              styles.stop,
              { backgroundColor: t('status-down-soft'), borderColor: t('status-down-border') },
              stopping && { opacity: 0.6 },
            ]}
          >
            <Text style={[styles.stopLabel, { color: t('status-down') }]}>{stopping ? 'Stopping…' : 'Stop'}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.row}>
        {threadId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach a photo or file"
            disabled={attaching || attached.length >= MAX_ATTACHMENTS}
            onPress={() => chooseAttachment(threadId)}
            style={[
              styles.attach,
              { backgroundColor: t('bg-2'), borderColor: t('border-strong') },
              (attaching || attached.length >= MAX_ATTACHMENTS) && { opacity: 0.4 },
            ]}
          >
            <Text style={[styles.attachLabel, { color: t('fg-1') }]}>+</Text>
          </Pressable>
        ) : null}
        {/* One paste button, never two. iOS asks permission whenever an app
            READS the pasteboard, so our own button cannot paste a picture
            without the dialog; a UIPasteControl can, because the tap on it is
            the consent (the user, 2026-09-30). Where the system draws that button
            it is the only one shown — build 14 shipped both side by side and
            the user saw a round icon next to a "paste" label. Text paste is not
            lost with the label: it stays on the keyboard's own long-press
            menu, which is where iOS puts it. The label is the fallback for
            below iOS 16 and for a composer with no thread yet. */}
        {threadId && pasteControlAvailable ? (
          <PasteControl
            style={styles.pasteControl}
            onImage={(image) => void attach(() => attachPastedImage(threadId, image))}
            onFile={(file) => void attach(() => attachPastedFile(threadId, file))}
            onFailure={(reason) =>
              showNotice('hint', reason === 'too_big' ? 'That is over 7 MB. Send a smaller one.' : 'Nothing to paste there — copy a picture or a file first.')
            }
          />
        ) : (
          <Pressable
            accessibilityLabel="Paste from clipboard"
            accessibilityRole="button"
            onPress={paste}
            style={[styles.paste, { backgroundColor: t('bg-2'), borderColor: t('border-strong') }]}
          >
            <Text style={[styles.pasteLabel, { color: pasteFlash ? t('status-warn') : t('fg-1') }]}>
              {pasteFlash ? 'long-press ↓' : 'paste'}
            </Text>
          </Pressable>
        )}
        <TextInput
          ref={input}
          value={value}
          selection={selection}
          onChangeText={handleChangeText}
          onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
          onSubmitEditing={send}
          submitBehavior="submit"
          multiline
          placeholder={PLACEHOLDER[unavailable ?? 'ready']}
          placeholderTextColor={t('fg-4')}
          autoCapitalize="sentences"
          autoCorrect
          enterKeyHint="send"
          style={[
            styles.input,
            // iOS grows a multiline field with what is typed and then keeps
            // that height after the text is cleared programmatically, until
            // the next keyboard show/hide. Pinning the height only while the
            // field is EMPTY snaps it back on send and leaves growth to the
            // native measurement, which was already right (the user, 2026-09-28:
            // first "doesn't auto go back", then "isn't stretching at all").
            value.length === 0 ? { height: MIN_HEIGHT } : null,
            { backgroundColor: t('bg-0'), borderColor: t('border-strong'), color: t('fg-0') },
          ]}
        />
        <Pressable
          accessibilityLabel="Send"
          accessibilityRole="button"
          onPress={send}
          disabled={!canSend}
          style={[styles.send, { backgroundColor: t('accent'), opacity: canSend ? 1 : 0.4 }]}
        >
          <Text style={[styles.sendGlyph, { color: t('on-accent') }]}>→</Text>
        </Pressable>
      </View>

      {commandNotice ? (
        <Text
          style={[
            styles.commandNotice,
            { color: commandNotice.kind === 'error' ? t('status-down') : t('fg-3') },
          ]}
        >
          {commandNotice.text}
        </Text>
      ) : null}

    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, gap: 8 },
  attach: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontFamily: fonts.mono(550), fontSize: 19, lineHeight: 22 },
  thumbs: { gap: 8, paddingBottom: 8, paddingHorizontal: 2 },
  thumb: { width: 54, height: 54, borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  thumbImage: { width: '100%', height: '100%' },
  fileThumb: { height: 54, minWidth: 110, maxWidth: 180, borderRadius: 10, borderWidth: 1, justifyContent: 'center', paddingLeft: 10, paddingRight: 22 },
  fileThumbBody: { gap: 2 },
  fileThumbName: { fontFamily: fonts.sans(550), fontSize: 12.5 },
  fileThumbSize: { fontFamily: fonts.mono(400), fontSize: 10 },
  thumbRemove: { position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  thumbRemoveLabel: { fontFamily: fonts.mono(550), fontSize: 12, lineHeight: 14 },
  modeHint: { flex: 1, minWidth: 0, fontFamily: fonts.mono(400), fontSize: 9.5, letterSpacing: 0.3 },
  toolRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  segmented: { flexDirection: 'row', borderRadius: 9, borderWidth: 1, padding: 2, gap: 2 },
  segment: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7 },
  segmentLabel: { fontFamily: fonts.mono(550), fontSize: 10.5, letterSpacing: 0.4 },
  stop: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  stopLabel: { fontFamily: fonts.sans(600), fontSize: 11.5 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  commandNotice: { fontFamily: fonts.sans(500), fontSize: 11, paddingHorizontal: 2 },
  paste: {
    height: MIN_HEIGHT,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pasteLabel: { fontFamily: fonts.mono(550), fontSize: 11.5 },
  // The system draws the button; this only reserves the room for it.
  pasteControl: { height: MIN_HEIGHT, width: 44 },
  input: {
    flex: 1,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: fonts.sans(400),
    fontSize: 15,
  },
  send: {
    width: 44,
    height: MIN_HEIGHT,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendGlyph: { fontFamily: fonts.sans(600), fontSize: 15 },
});
