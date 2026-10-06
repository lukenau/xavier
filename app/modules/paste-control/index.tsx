// The system paste button, as a React component.
//
// iOS asks "would like to paste from…" whenever an app READS the pasteboard.
// It never asks when the user taps a `UIPasteControl`, because the tap is the
// consent. So this button is the one way to paste a picture — or a file —
// into the composer without the dialog (the user, 2026-09-30, then 2026-10-01).
//
// On anything but iOS 16+ the native view is absent; `available` says so and
// the composer keeps its own paste button for those cases.
import { Platform, type ViewProps } from 'react-native';
import { requireNativeView } from 'expo';

export interface PastedImage {
  base64: string;
  mime: string;
  width: number;
  height: number;
}

/** A file off the pasteboard. The native side reads it, so the name is the one
 * it was copied under and the bytes are already base64. */
export interface PastedFile {
  base64: string;
  mime: string;
  name: string;
}

export type PasteFailure = 'not_pasteable' | 'unreadable' | 'too_big';

interface NativeProps extends ViewProps {
  onPasteImage?: (event: { nativeEvent: PastedImage }) => void;
  onPasteFile?: (event: { nativeEvent: PastedFile }) => void;
  onPasteError?: (event: { nativeEvent: { reason: PasteFailure } }) => void;
}

/** iOS 16 is where UIPasteControl arrives; the podspec sets the same floor. */
export const available =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 16;

const NativePasteControl = available
  ? requireNativeView<NativeProps>('PasteControl')
  : null;

export function PasteControl({
  onImage,
  onFile,
  onFailure,
  ...rest
}: ViewProps & {
  onImage: (image: PastedImage) => void;
  onFile?: (file: PastedFile) => void;
  onFailure?: (reason: PasteFailure) => void;
}) {
  if (!NativePasteControl) return null;
  return (
    <NativePasteControl
      {...rest}
      onPasteImage={(e) => onImage(e.nativeEvent)}
      onPasteFile={(e) => onFile?.(e.nativeEvent)}
      onPasteError={(e) => onFailure?.(e.nativeEvent.reason)}
    />
  );
}
