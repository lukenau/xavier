// The composer is the primary input path, and on native it is also the reason
// the terminal screen behaves: the keyboard belongs to this TextInput, which
// lives OUTSIDE WKWebView, so none of the "WebView scrolls when its own
// textarea focuses" bugs (#2285/#2471/#3655/#3689) can fire. Enter (or the
// send button) ships the line + '\r' to the pty and keeps focus.
//
// 1:1 with apps/hub/src/routes/terminal/Composer.tsx, with two native spellings:
//   - `submitBehavior="submit"` IS the brief's `blurOnSubmit={false}`: on a
//     multiline TextInput, RN 0.86 defaults to 'newline' (Enter inserts a line
//     break and `onSubmitEditing` never fires) and `blurOnSubmit` alone cannot
//     change that — submitBehavior overrides it (TextInput.d.ts:755-784).
//     'submit' = fire onSubmitEditing, do NOT blur.
//   - the paste button reads the clipboard through RN core's deprecated
//     `Clipboard` (RCTClipboard still ships in 0.86). @react-native-clipboard
//     is the long-term home; installing packages is out of scope here. It
//     RESOLVES '' where the web's `navigator.clipboard.readText()` rejects, so
//     "empty" and "refused" are the same signal natively and both flash the
//     long-press hint — otherwise that hint would be dead code on device.
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Clipboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';

export const MIN_HEIGHT = 38;
export const MAX_HEIGHT = 110;
export const PASTE_FLASH_MS = 1600;

export interface ComposerHandle {
  /** Replaces the value and focuses the field — runbooks and attach hints. */
  fill: (text: string) => void;
}

export interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSend, disabled },
  ref,
) {
  const { t } = useTheme();
  const [value, setValue] = useState('');
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [pasteFlash, setPasteFlash] = useState(false);
  const input = useRef<TextInput>(null);
  // Empty Enter must not ship a bare \r — the KeyBar '⏎' chip covers that on purpose.
  const canSend = !disabled && value.trim().length > 0;

  useImperativeHandle(ref, () => ({
    fill: (text: string) => {
      setValue(text);
      input.current?.focus();
    },
  }));

  const send = () => {
    if (!canSend) return;
    onSend(`${value}\r`);
    setValue('');
    setHeight(MIN_HEIGHT);
  };

  const flashPasteHint = () => {
    setPasteFlash(true);
    setTimeout(() => setPasteFlash(false), PASTE_FLASH_MS);
  };

  const paste = async () => {
    try {
      const text = await Clipboard.getString();
      if (text) {
        setValue((v) => v + text);
        input.current?.focus();
      } else {
        flashPasteHint();
      }
    } catch {
      flashPasteHint();
    }
  };

  return (
    <View style={[styles.row, { backgroundColor: t('bg-1'), borderTopColor: t('border') }]}>
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
      <TextInput
        ref={input}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={send}
        submitBehavior="submit"
        multiline
        placeholder={disabled ? 'reconnecting…' : 'command…'}
        placeholderTextColor={t('fg-4')}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        enterKeyHint="send"
        onContentSizeChange={(e) =>
          setHeight(Math.min(Math.max(e.nativeEvent.contentSize.height, MIN_HEIGHT), MAX_HEIGHT))
        }
        style={[
          styles.input,
          {
            height,
            backgroundColor: t('bg-0'),
            borderColor: t('border-strong'),
            color: t('fg-0'),
          },
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
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  paste: {
    height: MIN_HEIGHT,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pasteLabel: { fontFamily: fonts.mono(550), fontSize: 11.5 },
  input: {
    flex: 1,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: fonts.mono(400),
    fontSize: 16,
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
